import { describe, expect, it } from 'vitest'
import {
  CandidateRecordSchema,
  EnrichedCandidateRecordSchema,
  ExecutionLogRecordSchema,
  PreflightRequestSchema,
  ExecutionRequestSchema,
  PreflightResultSchema,
  SignedExecutionRequestSchema,
} from './contracts.js'

describe('execution foundation contracts', () => {
  it('parses candidate and enriched candidate records', () => {
    const candidate = CandidateRecordSchema.parse({
      marketId: 'mkt-1',
      eventId: 'evt-1',
      slug: 'btc-above-100k',
      question: 'Will BTC close above 100k?',
      marketType: 'standard',
      tradable: true,
      metadataComplete: true,
    })

    const enriched = EnrichedCandidateRecordSchema.parse({
      ...candidate,
      qualificationStatus: 'eligible',
      qualificationReasons: [],
      orderbook: {
        bestBid: 0.48,
        bestAsk: 0.52,
        spreadBps: 400,
        depthUsd: 1200,
        asOf: '2026-04-19T12:00:00.000Z',
      },
      impliedProbability: 0.52,
    })

    expect(enriched.orderbook.depthUsd).toBe(1200)
  })

  it('parses preflight results and execution requests', () => {
    const executionRequest = ExecutionRequestSchema.parse({
      requestId: 'req-1',
      intentId: 'intent-1',
      venue: 'paper',
      marketId: 'mkt-1',
      side: 'buy',
      quantity: 10,
      executionMode: 'taker',
      submittedAt: '2026-04-19T12:00:00.000Z',
    })

    const signedRequest = SignedExecutionRequestSchema.parse({
      ...executionRequest,
      signerRef: 'signer-1',
      signature: 'signed-payload',
    })

    const preflight = PreflightResultSchema.parse({
      ok: false,
      checkedAt: '2026-04-19T12:00:00.000Z',
      venue: 'paper',
      checks: [
        {
          code: 'spread_above_limit',
          ok: false,
          message: 'Spread exceeds configured limit',
        },
      ],
    })
    const preflightRequest = PreflightRequestSchema.parse({
      candidate: {
        marketId: 'mkt-1',
        eventId: 'evt-1',
        slug: 'btc-above-100k',
        question: 'Will BTC close above 100k?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        qualificationStatus: 'eligible',
        qualificationReasons: [],
        orderbook: {
          bestBid: 0.48,
          bestAsk: 0.52,
          spreadBps: 400,
          depthUsd: 1200,
          asOf: '2026-04-19T12:00:00.000Z',
        },
        impliedProbability: 0.5,
      },
      positionUsd: 250,
    })

    expect(signedRequest.signature).toBe('signed-payload')
    expect(preflight.checks[0]?.code).toBe('spread_above_limit')
    expect(preflightRequest.positionUsd).toBe(250)
  })

  it('parses execution log records and rejects invalid candidate data', () => {
    const logRecord = ExecutionLogRecordSchema.parse({
      logId: 'log-1',
      intentId: 'intent-1',
      venue: 'paper',
      status: 'placed',
      recordedAt: '2026-04-19T12:00:00.000Z',
      requestId: 'req-1',
      preflightOk: true,
    })

    expect(logRecord.status).toBe('placed')

    expect(() =>
      CandidateRecordSchema.parse({
        marketId: '',
        eventId: 'evt-1',
        slug: 'bad',
        question: 'bad candidate',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
      })
    ).toThrow()
  })
})
