import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IntentRecord } from './schema.js'
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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('execution repositories', () => {
  it('stores and retrieves intents in memory', () => {
    const repository = new InMemoryExecutionRepository()
    const intent = buildIntent()

    repository.saveIntent(intent)
    repository.saveIdempotencyKey(intent.idempotencyKey, intent.intentId)

    expect(repository.getIntent(intent.intentId)).toMatchObject(intent)
    expect(repository.getIntentIdByIdempotencyKey(intent.idempotencyKey)).toBe(intent.intentId)
  })

  it('persists intents to disk across repository instances', () => {
    const storagePath = makeTempPath('execution-state.json')
    const firstRepository = new FileExecutionRepository(storagePath)
    const intent = buildIntent()

    firstRepository.saveIntent(intent)
    firstRepository.saveIdempotencyKey(intent.idempotencyKey, intent.intentId)

    const secondRepository = new FileExecutionRepository(storagePath)
    expect(secondRepository.getIntent(intent.intentId)).toMatchObject(intent)
    expect(secondRepository.getIntentIdByIdempotencyKey(intent.idempotencyKey)).toBe(
      intent.intentId
    )

    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'))
    expect(persisted.idempotencyKeys[intent.idempotencyKey]).toBe(intent.intentId)
  })
})
