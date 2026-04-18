import { randomUUID } from 'node:crypto'
import {
  type AuditEvent,
  AuditEventSchema,
  type ExecutionPolicySnapshot,
  type IntentRecord,
  IntentRecordSchema,
  type OrderRecord,
  OrderRecordSchema,
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

export type Signer = {
  signIntent(intent: IntentRecord): Promise<{ signerRef: string }>
}

export type VenueExecutor = {
  placeOrder(
    intent: IntentRecord
  ): Promise<{ externalOrderId: string; status: OrderRecord['status'] }>
}

type ExecutionServiceOptions = {
  policy?: ExecutionPolicySnapshot
  signer?: Signer
  venueExecutor?: VenueExecutor
  now?: () => Date
}

const DEFAULT_POLICY: ExecutionPolicySnapshot = {
  maxNotionalUsd: 100_000,
  dailyNotionalLimitUsd: 250_000,
  allowedVenues: ['paper'],
  maxTtlSeconds: 86_400,
}

class InMemorySigner implements Signer {
  async signIntent(intent: IntentRecord): Promise<{ signerRef: string }> {
    return { signerRef: `local-signer:${intent.intentId}` }
  }
}

class InMemoryVenueExecutor implements VenueExecutor {
  async placeOrder(
    intent: IntentRecord
  ): Promise<{ externalOrderId: string; status: OrderRecord['status'] }> {
    return {
      externalOrderId: `paper-${intent.intentId}`,
      status: 'filled',
    }
  }
}

export class ExecutionService {
  private readonly intents = new Map<string, IntentRecord>()
  private readonly idempotencyKeys = new Map<string, string>()
  private readonly policy: ExecutionPolicySnapshot
  private readonly signer: Signer
  private readonly venueExecutor: VenueExecutor
  private readonly now: () => Date

  constructor(options: ExecutionServiceOptions = {}) {
    this.policy = options.policy ?? DEFAULT_POLICY
    this.signer = options.signer ?? new InMemorySigner()
    this.venueExecutor = options.venueExecutor ?? new InMemoryVenueExecutor()
    this.now = options.now ?? (() => new Date())
  }

  getPolicy(): ExecutionPolicySnapshot {
    return this.policy
  }

  listIntents(status?: IntentRecord['status']): IntentRecord[] {
    const intents = Array.from(this.intents.values())
    return status ? intents.filter((intent) => intent.status === status) : intents
  }

  getIntent(intentId: string): IntentRecord {
    const intent = this.intents.get(intentId)
    if (!intent) {
      throw new IntentNotFoundError(intentId)
    }
    return intent
  }

  submitIntent(
    input: SubmitIntentRequest,
    requestId: string
  ): { created: boolean; intent: IntentRecord } {
    const existingIntentId = this.idempotencyKeys.get(input.idempotencyKey)
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
    if (this.intents.has(intentId)) {
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

    this.intents.set(intent.intentId, intent)
    this.idempotencyKeys.set(input.idempotencyKey, intent.intentId)

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
    this.appendAuditEvent(intent, 'signing_requested', requestId, {})

    try {
      const signed = await this.signer.signIntent(intent)
      intent.signerRef = signed.signerRef
      this.appendAuditEvent(intent, 'signing_succeeded', requestId, {
        signerRef: signed.signerRef,
      })
    } catch (error) {
      intent.status = 'confirmed'
      intent.updatedAt = this.now().toISOString()
      this.appendAuditEvent(intent, 'signing_failed', requestId, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    this.appendAuditEvent(intent, 'execution_requested', requestId, {})

    try {
      const execution = await this.venueExecutor.placeOrder(intent)
      const nowIso = this.now().toISOString()
      const order = OrderRecordSchema.parse({
        orderId: randomUUID(),
        venue: intent.venue,
        market: intent.market,
        side: intent.side,
        quantity: intent.quantity,
        limitPrice: intent.limitPrice,
        notionalUsd: intent.notionalUsd,
        status: execution.status,
        createdAt: nowIso,
        updatedAt: nowIso,
        externalOrderId: execution.externalOrderId,
      })

      intent.orders.push(order)

      if (execution.status === 'filled') {
        intent.status = 'executed'
        intent.executedAt = nowIso
        intent.updatedAt = nowIso
        this.appendAuditEvent(intent, 'execution_succeeded', requestId, {
          externalOrderId: execution.externalOrderId,
          orderStatus: execution.status,
        })
        return intent
      }

      if (execution.status === 'pending' || execution.status === 'placed') {
        intent.status = 'execution_pending'
        intent.updatedAt = nowIso
        this.appendAuditEvent(intent, 'execution_pending', requestId, {
          externalOrderId: execution.externalOrderId,
          orderStatus: execution.status,
        })
        return intent
      }

      intent.status = 'confirmed'
      intent.updatedAt = nowIso
      this.appendAuditEvent(
        intent,
        execution.status === 'cancelled' ? 'execution_cancelled' : 'execution_failed',
        requestId,
        {
          externalOrderId: execution.externalOrderId,
          orderStatus: execution.status,
        }
      )
      return intent
    } catch (error) {
      const nowIso = this.now().toISOString()
      intent.status = 'confirmed'
      intent.updatedAt = nowIso
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
    const todayNotional = Array.from(this.intents.values())
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
    intent.auditTrail.push(
      AuditEventSchema.parse({
        eventId: randomUUID(),
        intentId: intent.intentId,
        type,
        timestamp: this.now().toISOString(),
        requestId,
        details,
      })
    )
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
}
