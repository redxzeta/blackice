import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IntentRecord } from './schema.js'
import type { ExecutionLogRecord, PreflightRecord } from './contracts.js'
import { FileExecutionRepository, InMemoryExecutionRepository } from './repository.js'

const tempDirs: string[] = []

function makeTempPath(filename: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-exec-repo-'))
  tempDirs.push(dir)
  return path.join(dir, filename)
}

function buildIntent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    intentId: 'intent-1',
    idempotencyKey: 'idem-1',
    accountId: 'acct-1',
    market: 'BTC-USD',
    venue: 'paper',
    side: 'buy',
    quantity: 1,
    notionalUsd: 1000,
    ttlSeconds: 300,
    status: 'submitted',
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    expiresAt: '2026-04-21T00:05:00.000Z',
    metadata: {},
    orders: [],
    auditTrail: [],
    ...overrides,
  }
}

function buildPreflightRecord(overrides: Partial<PreflightRecord> = {}): PreflightRecord {
  return {
    preflightId: 'preflight-1',
    intentId: 'intent-1',
    recordedAt: '2026-04-21T00:01:00.000Z',
    policyFingerprint: 'fingerprint-1',
    request: {
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
          asOf: '2026-04-21T00:00:00.000Z',
        },
        impliedProbability: 0.49,
        tags: [],
      },
      venue: 'paper',
      positionUsd: 1000,
    },
    result: {
      ok: true,
      checkedAt: '2026-04-21T00:01:00.000Z',
      venue: 'paper',
      checks: [
        {
          code: 'candidate_not_tradable',
          ok: true,
          message: 'Candidate is tradable',
        },
      ],
    },
    ...overrides,
  }
}

function buildExecutionLogRecord(overrides: Partial<ExecutionLogRecord> = {}): ExecutionLogRecord {
  return {
    logId: 'log-1',
    intentId: 'intent-1',
    venue: 'paper',
    status: 'placed',
    recordedAt: '2026-04-21T00:02:00.000Z',
    orderId: 'venue-order-1',
    requestId: 'req-1',
    preflightOk: true,
    details: {},
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('execution repositories', () => {
  it('stores and retrieves intents in memory', () => {
    const repository = new InMemoryExecutionRepository()
    const intent = buildIntent()
    const preflightRecord = buildPreflightRecord()
    const executionLog = buildExecutionLogRecord()

    repository.saveIntent(intent)
    repository.saveIdempotencyKey(intent.idempotencyKey, intent.intentId)
    repository.appendPreflightRecord(preflightRecord)
    repository.appendExecutionLog(executionLog)

    expect(repository.getIntent(intent.intentId)).toMatchObject(intent)
    expect(repository.getIntentIdByIdempotencyKey(intent.idempotencyKey)).toBe(intent.intentId)
    expect(repository.getLatestPreflightRecord(intent.intentId)).toMatchObject(preflightRecord)
    expect(repository.listExecutionLogs(intent.intentId)).toMatchObject([executionLog])
  })

  it('persists intents to disk across repository instances', () => {
    const storagePath = makeTempPath('execution-state.json')
    const firstRepository = new FileExecutionRepository(storagePath)
    const intent = buildIntent()
    const preflightRecord = buildPreflightRecord()
    const executionLog = buildExecutionLogRecord()

    firstRepository.saveIntent(intent)
    firstRepository.saveIdempotencyKey(intent.idempotencyKey, intent.intentId)
    firstRepository.appendPreflightRecord(preflightRecord)
    firstRepository.appendExecutionLog(executionLog)

    const secondRepository = new FileExecutionRepository(storagePath)
    expect(secondRepository.getIntent(intent.intentId)).toMatchObject(intent)
    expect(secondRepository.getIntentIdByIdempotencyKey(intent.idempotencyKey)).toBe(
      intent.intentId
    )
    expect(secondRepository.listPreflightRecords(intent.intentId)).toHaveLength(1)
    expect(secondRepository.getLatestPreflightRecord(intent.intentId)).toMatchObject(
      preflightRecord
    )
    expect(secondRepository.listExecutionLogs(intent.intentId)).toMatchObject([executionLog])

    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'))
    expect(persisted.idempotencyKeys[intent.idempotencyKey]).toBe(intent.intentId)
    expect(persisted.preflightRecords).toHaveLength(1)
    expect(persisted.executionLogs).toHaveLength(1)
  })
})
