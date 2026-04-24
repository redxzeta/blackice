import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ExecutionLogRecord,
  ExecutionRequest,
  PreflightRequest,
  PreflightResult,
  SignedExecutionRequest,
} from './contracts.js'
import { FileExecutionRepository } from './repository.js'
import { ExecutionPolicyError, ExecutionService, IntentStateError } from './service.js'

function buildService() {
  let currentTime = Date.parse('2026-04-18T12:00:00.000Z')
  const service = new ExecutionService({
    now: () => new Date(currentTime),
  })

  return {
    service,
    advanceTime(ms: number) {
      currentTime += ms
    },
  }
}

const validIntent = {
  idempotencyKey: 'idem-1',
  accountId: 'acct-1',
  market: 'BTC-USD',
  venue: 'paper',
  side: 'buy' as const,
  quantity: 1,
  notionalUsd: 10_000,
  ttlSeconds: 300,
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function buildSignedRequest(request: ExecutionRequest): SignedExecutionRequest {
  return {
    ...request,
    signerRef: 'mock:paper',
    signature: `sig:${request.requestId}`,
  }
}

function buildExecutionLog(
  status: ExecutionLogRecord['status'],
  overrides: Partial<ExecutionLogRecord> = {}
): ExecutionLogRecord {
  return {
    logId: overrides.logId ?? `log-${status}`,
    intentId: overrides.intentId ?? 'intent-1',
    venue: overrides.venue ?? 'paper',
    status,
    recordedAt: overrides.recordedAt ?? '2026-04-18T12:00:01.000Z',
    orderId: overrides.orderId ?? `venue-${status}-1`,
    requestId: overrides.requestId ?? 'req-3',
    preflightOk: overrides.preflightOk ?? true,
    details: overrides.details ?? {},
  }
}

function buildPreflightRequest(overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    candidate: {
      marketId: 'market-1',
      eventId: 'event-1',
      slug: 'btc-above-100k',
      question: 'Will BTC close above 100k?',
      marketType: 'standard',
      tradable: true,
      metadataComplete: true,
      qualificationStatus: 'eligible',
      qualificationReasons: [],
      orderbook: {
        bestBid: 0.48,
        bestAsk: 0.5,
        spreadBps: 400,
        depthUsd: 1200,
        asOf: '2026-04-18T12:00:00.000Z',
      },
      impliedProbability: 0.49,
      tags: [],
    },
    ...overrides,
  }
}

function buildPreflightResult(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    ok: true,
    checkedAt: '2026-04-18T12:00:00.000Z',
    venue: 'paper',
    checks: [
      {
        code: 'candidate_not_tradable',
        ok: true,
        message: 'Candidate is tradable',
      },
    ],
    ...overrides,
  }
}

describe('ExecutionService', () => {
  it('supports idempotent submit retries', () => {
    const { service } = buildService()

    const first = service.submitIntent(validIntent, 'req-1')
    const second = service.submitIntent(validIntent, 'req-2')

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.intent.intentId).toBe(first.intent.intentId)
  })

  it('records intent-bound preflight records and returns the latest one', () => {
    const { service } = buildService()

    const { intent } = service.submitIntent(validIntent, 'req-1')
    const record = service.recordPreflight(
      intent.intentId,
      buildPreflightRequest(),
      buildPreflightResult(),
      'req-2'
    )

    expect(record.intentId).toBe(intent.intentId)
    expect(record.request.venue).toBe(intent.venue)
    expect(record.request.positionUsd).toBe(intent.notionalUsd)
    expect(service.getLatestPreflightRecord(intent.intentId)?.preflightId).toBe(record.preflightId)
    expect(service.listPreflightRecords(intent.intentId)).toHaveLength(1)
    expect(service.getIntent(intent.intentId).auditTrail.at(-1)?.type).toBe('preflight_recorded')
  })

  it('returns the latest successful preflight record for execution gating', () => {
    const { service } = buildService()
    const { intent } = service.submitIntent(validIntent, 'req-1')
    const record = service.recordPreflight(
      intent.intentId,
      buildPreflightRequest(),
      buildPreflightResult(),
      'req-2'
    )

    expect(service.getExecutionPreflightRecord(intent.intentId)?.preflightId).toBe(
      record.preflightId
    )
  })

  it('rejects execute-time use of failed or stale preflight records', () => {
    const { service, advanceTime } = buildService()
    const { intent } = service.submitIntent(validIntent, 'req-1')

    service.recordPreflight(
      intent.intentId,
      buildPreflightRequest(),
      buildPreflightResult({ ok: false }),
      'req-2'
    )
    expect(() => service.getExecutionPreflightRecord(intent.intentId)).toThrowError(
      ExecutionPolicyError
    )

    const { intent: secondIntent } = service.submitIntent(
      { ...validIntent, idempotencyKey: 'idem-2', market: 'ETH-USD' },
      'req-3'
    )
    service.recordPreflight(
      secondIntent.intentId,
      buildPreflightRequest(),
      buildPreflightResult(),
      'req-4'
    )
    advanceTime(301_000)

    expect(() => service.getExecutionPreflightRecord(secondIntent.intentId)).toThrowError(
      ExecutionPolicyError
    )
  })

  it('rejects preflight records whose venue or position do not match the intent', () => {
    const { service } = buildService()

    const { intent } = service.submitIntent(validIntent, 'req-1')

    expect(() =>
      service.recordPreflight(
        intent.intentId,
        buildPreflightRequest({ venue: 'live' }),
        buildPreflightResult(),
        'req-2'
      )
    ).toThrowError(IntentStateError)

    expect(() =>
      service.recordPreflight(
        intent.intentId,
        buildPreflightRequest({ positionUsd: 9_999 }),
        buildPreflightResult(),
        'req-3'
      )
    ).toThrowError(IntentStateError)

    expect(() =>
      service.recordPreflight(
        intent.intentId,
        buildPreflightRequest(),
        buildPreflightResult({ venue: 'live' }),
        'req-4'
      )
    ).toThrowError(IntentStateError)
  })

  it('rejects policy violations', () => {
    const { service } = buildService()

    expect(() =>
      service.submitIntent(
        {
          ...validIntent,
          idempotencyKey: 'idem-2',
          venue: 'binance',
        },
        'req-1'
      )
    ).toThrowError(ExecutionPolicyError)
  })

  it('rejects idempotency key reuse when the payload changes', () => {
    const { service } = buildService()

    service.submitIntent(validIntent, 'req-1')

    expect(() =>
      service.submitIntent(
        {
          ...validIntent,
          notionalUsd: 15_000,
        },
        'req-2'
      )
    ).toThrowError(IntentStateError)
  })

  it('records signer failures and keeps intent confirmable', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest() {
          throw new Error('signer offline')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    await expect(service.executeIntent(intent.intentId, 'req-3')).rejects.toThrow('signer offline')

    const stored = service.getIntent(intent.intentId)
    expect(stored.status).toBe('confirmed')
    expect(stored.auditTrail.at(-1)?.type).toBe('signing_failed')
  })

  it('records execution failures and keeps intent confirmed for retry', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          throw new Error('venue rejected order')
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    await expect(service.executeIntent(intent.intentId, 'req-3')).rejects.toThrow(
      'venue rejected order'
    )

    const stored = service.getIntent(intent.intentId)
    expect(stored.status).toBe('confirmed')
    expect(stored.auditTrail.at(-1)?.type).toBe('execution_failed')
  })

  it('keeps the intent execution_pending when the venue returns a pending order', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          return buildExecutionLog('accepted', {
            orderId: 'venue-pending-1',
          })
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('execution_pending')
    expect(result.executedAt).toBeUndefined()
    expect(result.orders.at(-1)).toMatchObject({
      status: 'pending',
      externalOrderId: 'venue-pending-1',
    })
    expect(result.auditTrail.at(-1)?.type).toBe('execution_pending')
  })

  it('keeps the intent execution_pending when the venue returns a placed order', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          return buildExecutionLog('placed', {
            orderId: 'venue-placed-1',
          })
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('execution_pending')
    expect(result.orders.at(-1)).toMatchObject({
      status: 'placed',
      externalOrderId: 'venue-placed-1',
    })
    expect(result.auditTrail.at(-1)?.type).toBe('execution_pending')
  })

  it('keeps the intent confirmed when the venue returns a cancelled order', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          return buildExecutionLog('cancelled', {
            orderId: 'venue-cancelled-1',
          })
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('confirmed')
    expect(result.executedAt).toBeUndefined()
    expect(result.orders.at(-1)).toMatchObject({
      status: 'cancelled',
      externalOrderId: 'venue-cancelled-1',
    })
    expect(result.auditTrail.at(-1)?.type).toBe('execution_cancelled')
  })

  it('keeps the intent confirmed when the venue returns a failed order', async () => {
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          return buildExecutionLog('failed', {
            orderId: 'venue-failed-1',
            details: {
              reason: 'insufficient depth',
            },
          })
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('confirmed')
    expect(result.orders.at(-1)).toMatchObject({
      status: 'failed',
      externalOrderId: 'venue-failed-1',
      failureReason: 'insufficient depth',
    })
    expect(result.auditTrail.at(-1)?.type).toBe('execution_failed')
  })

  it('blocks execution after ttl expiry', async () => {
    const { service, advanceTime } = buildService()

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')
    advanceTime(301_000)

    await expect(service.executeIntent(intent.intentId, 'req-3')).rejects.toThrow(
      ExecutionPolicyError
    )
  })

  it('prevents cancellation after execution', async () => {
    const { service } = buildService()

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')
    await service.executeIntent(intent.intentId, 'req-3')

    expect(() => service.cancelIntent(intent.intentId, 'req-4')).toThrowError(IntentStateError)
  })

  it('rejects cancellation while execution is pending', async () => {
    const signerGate = createDeferredPromise<SignedExecutionRequest>()
    const service = new ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return signerGate.promise
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const executionPromise = service.executeIntent(intent.intentId, 'req-3')
    await Promise.resolve()

    expect(service.getIntent(intent.intentId).status).toBe('execution_pending')
    expect(() => service.cancelIntent(intent.intentId, 'req-4')).toThrowError(IntentStateError)

    signerGate.resolve(
      buildSignedRequest({
        requestId: 'req-3',
        intentId: intent.intentId,
        venue: 'paper',
        marketId: validIntent.market,
        side: validIntent.side,
        quantity: validIntent.quantity,
        executionMode: 'taker',
        submittedAt: '2026-04-18T12:00:00.000Z',
      })
    )
    await expect(executionPromise).resolves.toMatchObject({ status: 'executed' })
  })

  it('persists normalized execution logs in the durable repository', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blackice-execution-logs-'))
    tempDirs.push(dir)
    const storagePath = path.join(dir, 'execution-state.json')

    const repository = new FileExecutionRepository(storagePath)
    const service = new ExecutionService({
      repository,
      now: () => new Date('2026-04-18T12:00:00.000Z'),
      signingAdapter: {
        async signExecutionRequest(request) {
          return buildSignedRequest(request)
        },
      },
      executionAdapter: {
        async placeOrder() {
          return buildExecutionLog('filled', {
            intentId: 'intent-filled',
            orderId: 'venue-filled-1',
          })
        },
        async cancelOrder() {
          return buildExecutionLog('cancelled')
        },
      },
    })

    const { intent } = service.submitIntent(
      {
        ...validIntent,
        intentId: 'intent-filled',
        idempotencyKey: 'idem-filled',
      },
      'req-1'
    )
    service.confirmIntent(intent.intentId, 'req-2')
    await service.executeIntent(intent.intentId, 'req-3')

    const storedState = JSON.parse(readFileSync(storagePath, 'utf8')) as {
      executionLogs: ExecutionLogRecord[]
    }

    expect(storedState.executionLogs).toHaveLength(1)
    expect(storedState.executionLogs[0]).toMatchObject({
      intentId: 'intent-filled',
      status: 'filled',
      orderId: 'venue-filled-1',
    })
  })

  it('persists preflight records across service instances with the durable repository', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blackice-preflight-records-'))
    tempDirs.push(dir)
    const storagePath = path.join(dir, 'execution-state.json')

    const firstRepository = new FileExecutionRepository(storagePath)
    const firstService = new ExecutionService({
      repository: firstRepository,
      now: () => new Date('2026-04-18T12:00:00.000Z'),
    })
    const { intent } = firstService.submitIntent(validIntent, 'req-1')
    const recorded = firstService.recordPreflight(
      intent.intentId,
      buildPreflightRequest(),
      buildPreflightResult(),
      'req-2'
    )

    const secondRepository = new FileExecutionRepository(storagePath)
    const secondService = new ExecutionService({
      repository: secondRepository,
      now: () => new Date('2026-04-18T12:00:01.000Z'),
    })

    expect(secondService.getLatestPreflightRecord(intent.intentId)).toMatchObject({
      preflightId: recorded.preflightId,
      intentId: intent.intentId,
      policyFingerprint: recorded.policyFingerprint,
    })
    expect(JSON.parse(readFileSync(storagePath, 'utf8')).preflightRecords).toHaveLength(1)
  })

  it('reloads intents from a durable repository across service instances', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blackice-service-repo-'))
    tempDirs.push(dir)
    const storagePath = path.join(dir, 'execution-state.json')

    const firstRepository = new FileExecutionRepository(storagePath)
    const firstService = new ExecutionService({
      repository: firstRepository,
      now: () => new Date('2026-04-18T12:00:00.000Z'),
    })
    const submitted = firstService.submitIntent(validIntent, 'req-1')

    const secondRepository = new FileExecutionRepository(storagePath)
    const secondService = new ExecutionService({
      repository: secondRepository,
      now: () => new Date('2026-04-18T12:00:01.000Z'),
    })

    expect(secondService.getIntent(submitted.intent.intentId)).toMatchObject({
      intentId: submitted.intent.intentId,
      idempotencyKey: validIntent.idempotencyKey,
      status: 'submitted',
    })
    expect(secondService.listIntents()).toHaveLength(1)
  })
})
