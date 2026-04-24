import { describe, expect, it } from 'vitest'
import {
  buildExecutionRequestFromIntent,
  buildOrderRecordFromExecutionLog,
  mapExecutionLogToAuditEventType,
  mapExecutionLogToIntentStatus,
  mapExecutionLogToOrderStatus,
  PaperExecutionAdapter,
  updateOrderRecordFromExecutionLog,
} from './executionAdapter.js'
import type { ExecutionLogRecord } from './contracts.js'
import type { IntentRecord } from './schema.js'

const baseIntent: IntentRecord = {
  intentId: 'intent-1',
  idempotencyKey: 'idem-1',
  accountId: 'acct-1',
  market: 'BTC-USD',
  venue: 'paper',
  side: 'buy',
  quantity: 2,
  limitPrice: 0.51,
  notionalUsd: 102,
  ttlSeconds: 300,
  status: 'confirmed',
  createdAt: '2026-04-22T00:00:00.000Z',
  updatedAt: '2026-04-22T00:00:00.000Z',
  confirmedAt: '2026-04-22T00:00:00.000Z',
  expiresAt: '2026-04-22T00:05:00.000Z',
  metadata: {},
  orders: [],
  auditTrail: [],
}

describe('executionAdapter', () => {
  it('builds execution requests from intents with a stable default execution mode', () => {
    const request = buildExecutionRequestFromIntent(
      {
        ...baseIntent,
        metadata: {
          executionMode: 'maker',
        },
      },
      'req-1',
      '2026-04-22T00:01:00.000Z'
    )

    expect(request).toMatchObject({
      requestId: 'req-1',
      intentId: baseIntent.intentId,
      marketId: baseIntent.market,
      executionMode: 'maker',
    })

    const fallbackRequest = buildExecutionRequestFromIntent(
      {
        ...baseIntent,
        metadata: {
          executionMode: 'bad-mode',
        },
      },
      'req-2',
      '2026-04-22T00:02:00.000Z'
    )

    expect(fallbackRequest.executionMode).toBe('taker')
  })

  it.each([
    ['accepted', 'pending', 'execution_pending', 'execution_pending'],
    ['placed', 'placed', 'execution_pending', 'execution_pending'],
    ['filled', 'filled', 'executed', 'execution_succeeded'],
    ['cancelled', 'cancelled', 'confirmed', 'execution_cancelled'],
    ['failed', 'failed', 'confirmed', 'execution_failed'],
    ['rejected', 'failed', 'confirmed', 'execution_failed'],
  ] as const)(
    'maps %s execution logs into normalized lifecycle records',
    (logStatus, orderStatus, intentStatus, auditType) => {
      expect(mapExecutionLogToOrderStatus(logStatus)).toBe(orderStatus)
      expect(mapExecutionLogToIntentStatus(logStatus)).toBe(intentStatus)
      expect(mapExecutionLogToAuditEventType(logStatus)).toBe(auditType)
    }
  )

  it('builds order records with venue ids and failure reasons from execution logs', () => {
    const log: ExecutionLogRecord = {
      logId: 'log-1',
      intentId: baseIntent.intentId,
      venue: baseIntent.venue,
      status: 'failed',
      recordedAt: '2026-04-22T00:03:00.000Z',
      orderId: 'venue-order-1',
      requestId: 'req-3',
      preflightOk: true,
      details: {
        reason: 'insufficient depth',
      },
    }

    const order = buildOrderRecordFromExecutionLog({
      intent: baseIntent,
      executionLog: log,
    })

    expect(order).toMatchObject({
      status: 'failed',
      externalOrderId: 'venue-order-1',
      failureReason: 'insufficient depth',
    })
  })

  it('provides a paper adapter with deterministic filled and cancelled logs', async () => {
    const adapter = new PaperExecutionAdapter()

    const placed = await adapter.placeOrder({
      ...buildExecutionRequestFromIntent(baseIntent, 'req-4', '2026-04-22T00:04:00.000Z'),
      signerRef: 'mock:paper',
      signature: 'sig-1',
    })
    const cancelled = await adapter.cancelOrder('venue-order-2', 'req-5')

    expect(placed.status).toBe('filled')
    expect(placed.orderId).toBe('paper-req-4')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.orderId).toBe('venue-order-2')
    await expect(adapter.getOrderStatus('venue-order-3', 'req-6')).resolves.toMatchObject({
      status: 'filled',
      orderId: 'venue-order-3',
    })
  })

  it('updates existing order records from refreshed execution logs', () => {
    const order = buildOrderRecordFromExecutionLog({
      intent: baseIntent,
      executionLog: {
        logId: 'log-pending',
        intentId: baseIntent.intentId,
        venue: baseIntent.venue,
        status: 'accepted',
        recordedAt: '2026-04-22T00:01:00.000Z',
        orderId: 'venue-order-4',
        requestId: 'req-7',
        preflightOk: true,
        details: {},
      },
    })

    const refreshed = updateOrderRecordFromExecutionLog({
      order,
      executionLog: {
        logId: 'log-filled',
        intentId: baseIntent.intentId,
        venue: baseIntent.venue,
        status: 'filled',
        recordedAt: '2026-04-22T00:02:00.000Z',
        orderId: 'venue-order-4',
        requestId: 'req-8',
        preflightOk: true,
        details: {},
      },
    })

    expect(refreshed.status).toBe('filled')
    expect(refreshed.updatedAt).toBe('2026-04-22T00:02:00.000Z')
  })
})
