import { randomUUID } from 'node:crypto'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import type {
  ExecutionAdapter,
  ExecutionRepository,
  PreflightRecord,
  PreflightRequest,
  PreflightResult,
  SignedExecutionRequest,
  SigningAdapter,
} from './contracts.js'
import {
  buildExecutionRequestFromIntent,
  buildOrderRecordFromExecutionLog,
  createExecutionAdapter,
  mapExecutionLogToAuditEventType,
  mapExecutionLogToIntentStatus,
} from './executionAdapter.js'
import { buildPreflightRecord, computePreflightPolicyFingerprint } from './preflight.js'
import { createExecutionRepository } from './repository.js'
import { createSigningAdapter } from './signing.js'
import {
  type AuditEvent,
  AuditEventSchema,
  type ExecutionPolicySnapshot,
  type IntentRecord,
  IntentRecordSchema,
  type SubmitIntentRequest,
} from './schema.js'

export class ExecutionPolicyError extends Error {
  status = 422

  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'ExecutionPolicyError'
  }
}

export class IntentStateError extends Error {
  status = 409

  constructor(message: string) {
    super(message)
    this.name = 'IntentStateError'
  }
}

export class IntentNotFoundError extends Error {
  status = 404

  constructor(intentId: string) {
    super(`Intent not found: ${intentId}`)
    this.name = 'IntentNotFoundError'
  }
}

type ExecutionServiceOptions = {
  policy?: ExecutionPolicySnapshot
  signingAdapter?: SigningAdapter
  executionAdapter?: ExecutionAdapter
  repository?: ExecutionRepository
  now?: () => Date
}

const DEFAULT_POLICY: ExecutionPolicySnapshot = {
  maxNotionalUsd: 100_000,
  dailyNotionalLimitUsd: 250_000,
  allowedVenues: ['paper'],
  maxTtlSeconds: 86_400,
}

export class ExecutionService {
  private readonly policy: ExecutionPolicySnapshot
  private readonly signingAdapter: SigningAdapter
  private readonly executionAdapter: ExecutionAdapter
  private readonly repository: ExecutionRepository
  private readonly now: () => Date

  constructor(options: ExecutionServiceOptions = {}) {
    this.policy = options.policy ?? DEFAULT_POLICY
    this.signingAdapter = options.signingAdapter ?? createSigningAdapter()
    this.executionAdapter = options.executionAdapter ?? createExecutionAdapter()
    this.repository =
      options.repository ??
      createExecutionRepository({
        storageKind: getRuntimeConfig().execution.storageKind,
        storagePath: getRuntimeConfig().execution.storagePath,
      })
    this.now = options.now ?? (() => new Date())
  }

  getPolicy(): ExecutionPolicySnapshot {
    return this.policy
  }

  listIntents(status?: IntentRecord['status']): IntentRecord[] {
    return this.repository.listIntents(status)
  }

  getIntent(intentId: string): IntentRecord {
    const intent = this.repository.getIntent(intentId)
    if (!intent) {
      throw new IntentNotFoundError(intentId)
    }
    return intent
  }

  listPreflightRecords(intentId: string): PreflightRecord[] {
    this.getIntent(intentId)
    return this.repository.listPreflightRecords(intentId)
  }

  getLatestPreflightRecord(intentId: string): PreflightRecord | null {
    this.getIntent(intentId)
    return this.repository.getLatestPreflightRecord(intentId)
  }

  getExecutionPreflightRecord(intentId: string): PreflightRecord | null {
    const intent = this.getIntent(intentId)
    const record = this.repository.getLatestPreflightRecord(intentId)
    if (!record) {
      return null
    }

    const normalizedRequest = this.normalizePreflightRequest(intent, record.request)
    if (!record.result.ok) {
      throw new ExecutionPolicyError(
        `Latest preflight for intent ${intentId} did not pass`,
        'preflight_failed'
      )
    }

    if (record.result.venue !== normalizedRequest.venue) {
      throw new ExecutionPolicyError(
        `Latest preflight for intent ${intentId} does not match the current venue`,
        'preflight_mismatch'
      )
    }

    const expectedFingerprint = computePreflightPolicyFingerprint(normalizedRequest)
    if (record.policyFingerprint !== expectedFingerprint) {
      throw new ExecutionPolicyError(
        `Latest preflight for intent ${intentId} no longer matches current policy`,
        'preflight_stale'
      )
    }

    const maxAgeMs = getRuntimeConfig().execution.preflightMaxAgeSeconds * 1000
    if (Date.parse(record.recordedAt) + maxAgeMs < this.now().getTime()) {
      throw new ExecutionPolicyError(
        `Latest preflight for intent ${intentId} is stale`,
        'preflight_stale'
      )
    }

    return record
  }

  recordPreflight(
    intentId: string,
    request: PreflightRequest,
    result: PreflightResult,
    requestId: string
  ): PreflightRecord {
    const intent = this.getIntent(intentId)
    const normalizedRequest = this.normalizePreflightRequest(intent, request)
    if (result.venue !== normalizedRequest.venue) {
      throw new IntentStateError(
        `Preflight result venue ${result.venue} does not match intent venue ${intent.venue}`
      )
    }
    const record = buildPreflightRecord({
      intentId,
      recordedAt: this.now().toISOString(),
      request: normalizedRequest,
      result,
    })

    this.repository.appendPreflightRecord(record)
    this.appendAuditEvent(intent, 'preflight_recorded', requestId, {
      preflightId: record.preflightId,
      preflightOk: record.result.ok,
      policyFingerprint: record.policyFingerprint,
    })
    return record
  }

  submitIntent(
    input: SubmitIntentRequest,
    requestId: string
  ): { created: boolean; intent: IntentRecord } {
    const existingIntentId = this.repository.getIntentIdByIdempotencyKey(input.idempotencyKey)
    if (existingIntentId) {
      const existingIntent = this.getIntent(existingIntentId)
      if (!this.matchesExistingIntent(existingIntent, input)) {
        throw new IntentStateError(
          `Idempotency key ${input.idempotencyKey} conflicts with an existing intent payload`
        )
      }
      return {
        created: false,
        intent: existingIntent,
      }
    }

    this.validatePolicy(input)

    const nowIso = this.now().toISOString()
    const intentId = input.intentId ?? randomUUID()
    if (this.repository.getIntent(intentId)) {
      throw new IntentStateError(`Intent already exists: ${intentId}`)
    }

    const intent = IntentRecordSchema.parse({
      intentId,
      idempotencyKey: input.idempotencyKey,
      accountId: input.accountId,
      market: input.market,
      venue: input.venue,
      side: input.side,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      notionalUsd: input.notionalUsd,
      ttlSeconds: input.ttlSeconds,
      status: 'submitted',
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + input.ttlSeconds * 1000).toISOString(),
      metadata: input.metadata,
      orders: [],
      auditTrail: [],
    })

    this.appendAuditEvent(intent, 'intent_submitted', requestId, {
      accountId: input.accountId,
      venue: input.venue,
      market: input.market,
      notionalUsd: input.notionalUsd,
    })

    this.repository.saveIntent(intent)
    this.repository.saveIdempotencyKey(input.idempotencyKey, intent.intentId)

    return { created: true, intent }
  }

  confirmIntent(intentId: string, requestId: string): IntentRecord {
    const intent = this.getIntent(intentId)
    if (intent.status === 'confirmed' || intent.status === 'executed') {
      return intent
    }
    if (intent.status !== 'submitted') {
      throw new IntentStateError(
        `Intent ${intentId} cannot be confirmed from status ${intent.status}`
      )
    }

    const nowIso = this.now().toISOString()
    intent.status = 'confirmed'
    intent.confirmedAt = nowIso
    intent.updatedAt = nowIso
    this.appendAuditEvent(intent, 'intent_confirmed', requestId, {})
    this.repository.saveIntent(intent)
    return intent
  }

  async executeIntent(intentId: string, requestId: string): Promise<IntentRecord> {
    const intent = this.getIntent(intentId)
    if (intent.status === 'executed') {
      return intent
    }
    if (intent.status !== 'confirmed') {
      throw new IntentStateError(`Intent ${intentId} cannot execute from status ${intent.status}`)
    }
    if (Date.parse(intent.expiresAt) < this.now().getTime()) {
      throw new ExecutionPolicyError(
        `Intent ${intentId} expired before execution`,
        'intent_expired'
      )
    }

    const requestedAt = this.now().toISOString()
    intent.status = 'execution_pending'
    intent.updatedAt = requestedAt
    this.repository.saveIntent(intent)
    this.appendAuditEvent(intent, 'signing_requested', requestId, {})

    const executionRequest = buildExecutionRequestFromIntent(intent, requestId, requestedAt)
    let signedRequest: SignedExecutionRequest

    try {
      signedRequest = await this.signingAdapter.signExecutionRequest(executionRequest)
      intent.signerRef = signedRequest.signerRef
      this.repository.saveIntent(intent)
      this.appendAuditEvent(intent, 'signing_succeeded', requestId, {
        signerRef: signedRequest.signerRef,
      })
    } catch (error) {
      const nowIso = this.now().toISOString()
      intent.status = 'confirmed'
      intent.updatedAt = nowIso
      this.repository.saveIntent(intent)
      this.appendAuditEvent(intent, 'signing_failed', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    this.appendAuditEvent(intent, 'execution_requested', requestId, {})

    try {
      const executionLog = await this.executionAdapter.placeOrder(signedRequest)
      this.repository.appendExecutionLog(executionLog)

      const nowIso = executionLog.recordedAt
      const order = buildOrderRecordFromExecutionLog({
        intent,
        executionLog,
        recordedAt: nowIso,
      })

      intent.orders.push(order)
      intent.status = mapExecutionLogToIntentStatus(executionLog.status)
      intent.updatedAt = nowIso

      if (intent.status === 'executed') {
        intent.executedAt = nowIso
      }

      this.repository.saveIntent(intent)
      this.appendAuditEvent(
        intent,
        mapExecutionLogToAuditEventType(executionLog.status),
        requestId,
        {
          externalOrderId: executionLog.orderId,
          executionStatus: executionLog.status,
          logId: executionLog.logId,
        }
      )
      return intent
    } catch (error) {
      const nowIso = this.now().toISOString()
      intent.status = 'confirmed'
      intent.updatedAt = nowIso
      this.repository.saveIntent(intent)
      this.appendAuditEvent(intent, 'execution_failed', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  cancelIntent(intentId: string, requestId: string): IntentRecord {
    const intent = this.getIntent(intentId)
    if (intent.status === 'cancelled') {
      return intent
    }
    if (intent.status === 'executed' || intent.status === 'execution_pending') {
      throw new IntentStateError(
        `Intent ${intentId} cannot be cancelled from status ${intent.status}`
      )
    }

    const nowIso = this.now().toISOString()
    intent.status = 'cancelled'
    intent.cancelledAt = nowIso
    intent.updatedAt = nowIso
    this.appendAuditEvent(intent, 'intent_cancelled', requestId, {})
    this.repository.saveIntent(intent)
    return intent
  }

  private validatePolicy(input: SubmitIntentRequest): void {
    if (!this.policy.allowedVenues.includes(input.venue)) {
      throw new ExecutionPolicyError(
        `Venue ${input.venue} is not allowed by policy`,
        'venue_not_allowed'
      )
    }
    if (input.notionalUsd > this.policy.maxNotionalUsd) {
      throw new ExecutionPolicyError(
        `Intent notional ${input.notionalUsd} exceeds max ${this.policy.maxNotionalUsd}`,
        'max_notional_exceeded'
      )
    }
    if (input.ttlSeconds > this.policy.maxTtlSeconds) {
      throw new ExecutionPolicyError(
        `Intent ttlSeconds ${input.ttlSeconds} exceeds max ${this.policy.maxTtlSeconds}`,
        'ttl_exceeded'
      )
    }

    const windowStart = this.now()
    windowStart.setUTCHours(0, 0, 0, 0)
    const todayNotional = this.repository
      .listIntents()
      .filter((intent) => Date.parse(intent.createdAt) >= windowStart.getTime())
      .reduce((total, intent) => total + intent.notionalUsd, 0)

    if (todayNotional + input.notionalUsd > this.policy.dailyNotionalLimitUsd) {
      throw new ExecutionPolicyError(
        `Daily notional limit ${this.policy.dailyNotionalLimitUsd} would be exceeded`,
        'daily_notional_limit_exceeded'
      )
    }
  }

  private appendAuditEvent(
    intent: IntentRecord,
    type: AuditEvent['type'],
    requestId: string,
    details: Record<string, unknown>
  ): void {
    const event = AuditEventSchema.parse({
      eventId: randomUUID(),
      intentId: intent.intentId,
      type,
      timestamp: this.now().toISOString(),
      requestId,
      details,
    })
    intent.auditTrail.push(event)
    this.repository.appendAuditEvent(event)
    this.repository.saveIntent(intent)
  }

  private matchesExistingIntent(intent: IntentRecord, input: SubmitIntentRequest): boolean {
    return (
      intent.accountId === input.accountId &&
      intent.market === input.market &&
      intent.venue === input.venue &&
      intent.side === input.side &&
      intent.quantity === input.quantity &&
      intent.limitPrice === input.limitPrice &&
      intent.notionalUsd === input.notionalUsd &&
      intent.ttlSeconds === input.ttlSeconds &&
      JSON.stringify(intent.metadata) === JSON.stringify(input.metadata ?? {})
    )
  }

  private normalizePreflightRequest(
    intent: IntentRecord,
    request: PreflightRequest
  ): PreflightRequest {
    const venue = request.venue ?? intent.venue
    if (venue !== intent.venue) {
      throw new IntentStateError(
        `Preflight venue ${venue} does not match intent venue ${intent.venue}`
      )
    }

    const positionUsd = request.positionUsd ?? intent.notionalUsd
    if (positionUsd !== intent.notionalUsd) {
      throw new IntentStateError(
        `Preflight position ${positionUsd} does not match intent notional ${intent.notionalUsd}`
      )
    }

    return {
      ...request,
      venue,
      positionUsd,
    }
  }
}
