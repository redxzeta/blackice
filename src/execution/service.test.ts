import { describe, expect, it } from 'vitest'
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

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
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
      signer: {
        async signIntent() {
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
      venueExecutor: {
        async placeOrder() {
          throw new Error('venue rejected order')
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
      venueExecutor: {
        async placeOrder() {
          return {
            externalOrderId: 'venue-pending-1',
            status: 'pending' as const,
          }
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('execution_pending')
    expect(result.executedAt).toBeUndefined()
    expect(result.orders.at(-1)?.status).toBe('pending')
    expect(result.auditTrail.at(-1)?.type).toBe('execution_pending')
  })

  it('keeps the intent confirmed when the venue returns a cancelled order', async () => {
    const service = new ExecutionService({
      venueExecutor: {
        async placeOrder() {
          return {
            externalOrderId: 'venue-cancelled-1',
            status: 'cancelled' as const,
          }
        },
      },
    })

    const { intent } = service.submitIntent(validIntent, 'req-1')
    service.confirmIntent(intent.intentId, 'req-2')

    const result = await service.executeIntent(intent.intentId, 'req-3')

    expect(result.status).toBe('confirmed')
    expect(result.executedAt).toBeUndefined()
    expect(result.orders.at(-1)?.status).toBe('cancelled')
    expect(result.auditTrail.at(-1)?.type).toBe('execution_cancelled')
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
    const signerGate = createDeferredPromise<{ signerRef: string }>()
    const service = new ExecutionService({
      signer: {
        async signIntent() {
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

    signerGate.resolve({ signerRef: 'local-signer:test' })
    await expect(executionPromise).resolves.toMatchObject({ status: 'executed' })
  })
})
