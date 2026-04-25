import { constants, accessSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import {
  type ExecutionLogRecord,
  type ExecutionRepository,
  type PreflightRecord,
  PreflightRecordSchema,
} from './contracts.js'
import type { IntentRecord, IntentStatus } from './schema.js'
import { AuditEventSchema, IntentRecordSchema } from './schema.js'

type StoredExecutionState = {
  intents: Record<string, IntentRecord>
  idempotencyKeys: Record<string, string>
  preflightRecords: PreflightRecord[]
  executionLogs: ExecutionLogRecord[]
}

const EMPTY_STATE: StoredExecutionState = {
  intents: {},
  idempotencyKeys: {},
  preflightRecords: [],
  executionLogs: [],
}

export type ExecutionRepositoryStorageCheck = {
  ok: boolean
  storageKind: string
  storagePath?: string
  reason?: string
}

function cloneIntent(intent: IntentRecord): IntentRecord {
  return IntentRecordSchema.parse(structuredClone(intent))
}

function cloneState(state: StoredExecutionState): StoredExecutionState {
  return {
    intents: Object.fromEntries(
      Object.entries(state.intents).map(([intentId, intent]) => [intentId, cloneIntent(intent)])
    ),
    idempotencyKeys: { ...state.idempotencyKeys },
    preflightRecords: structuredClone(state.preflightRecords),
    executionLogs: structuredClone(state.executionLogs),
  }
}

function parseState(raw: string): StoredExecutionState {
  const parsed = JSON.parse(raw) as Partial<StoredExecutionState>
  const intents = Object.fromEntries(
    Object.entries(parsed.intents ?? {}).map(([intentId, intent]) => [
      intentId,
      IntentRecordSchema.parse(intent),
    ])
  )

  return {
    intents,
    idempotencyKeys: { ...(parsed.idempotencyKeys ?? {}) },
    preflightRecords: (parsed.preflightRecords ?? []).map((record) =>
      PreflightRecordSchema.parse(record)
    ),
    executionLogs: structuredClone(parsed.executionLogs ?? []),
  }
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  private state: StoredExecutionState

  constructor(seedState: StoredExecutionState = EMPTY_STATE) {
    this.state = cloneState(seedState)
  }

  getIntent(intentId: string): IntentRecord | null {
    const intent = this.state.intents[intentId]
    return intent ? cloneIntent(intent) : null
  }

  listIntents(status?: IntentStatus): IntentRecord[] {
    const intents = Object.values(this.state.intents).map(cloneIntent)
    return status ? intents.filter((intent) => intent.status === status) : intents
  }

  saveIntent(intent: IntentRecord): void {
    this.state.intents[intent.intentId] = cloneIntent(intent)
  }

  getIntentIdByIdempotencyKey(idempotencyKey: string): string | null {
    return this.state.idempotencyKeys[idempotencyKey] ?? null
  }

  saveIdempotencyKey(idempotencyKey: string, intentId: string): void {
    this.state.idempotencyKeys[idempotencyKey] = intentId
  }

  appendAuditEvent(event: IntentRecord['auditTrail'][number]): void {
    const parsedEvent = AuditEventSchema.parse(event)
    const intent = this.state.intents[parsedEvent.intentId]
    if (!intent) {
      return
    }

    const nextIntent = cloneIntent(intent)
    nextIntent.auditTrail.push(parsedEvent)
    this.state.intents[parsedEvent.intentId] = nextIntent
  }

  listPreflightRecords(intentId: string): PreflightRecord[] {
    return this.state.preflightRecords
      .filter((record) => record.intentId === intentId)
      .map((record) => PreflightRecordSchema.parse(structuredClone(record)))
  }

  getLatestPreflightRecord(intentId: string): PreflightRecord | null {
    const records = this.listPreflightRecords(intentId)
    return records.at(-1) ?? null
  }

  appendPreflightRecord(record: PreflightRecord): void {
    this.state.preflightRecords.push(PreflightRecordSchema.parse(structuredClone(record)))
  }

  listExecutionLogs(intentId: string): ExecutionLogRecord[] {
    return this.state.executionLogs
      .filter((record) => record.intentId === intentId)
      .map((record) => structuredClone(record))
  }

  appendExecutionLog(record: ExecutionLogRecord): void {
    this.state.executionLogs.push(structuredClone(record))
  }
}

export class FileExecutionRepository implements ExecutionRepository {
  constructor(private readonly filePath: string) {
    ensureRepositoryFile(filePath)
  }

  getIntent(intentId: string): IntentRecord | null {
    const state = this.readState()
    const intent = state.intents[intentId]
    return intent ? cloneIntent(intent) : null
  }

  listIntents(status?: IntentStatus): IntentRecord[] {
    const intents = Object.values(this.readState().intents).map(cloneIntent)
    return status ? intents.filter((intent) => intent.status === status) : intents
  }

  saveIntent(intent: IntentRecord): void {
    const state = this.readState()
    state.intents[intent.intentId] = cloneIntent(intent)
    this.writeState(state)
  }

  getIntentIdByIdempotencyKey(idempotencyKey: string): string | null {
    return this.readState().idempotencyKeys[idempotencyKey] ?? null
  }

  saveIdempotencyKey(idempotencyKey: string, intentId: string): void {
    const state = this.readState()
    state.idempotencyKeys[idempotencyKey] = intentId
    this.writeState(state)
  }

  appendAuditEvent(event: IntentRecord['auditTrail'][number]): void {
    const parsedEvent = AuditEventSchema.parse(event)
    const state = this.readState()
    const intent = state.intents[parsedEvent.intentId]
    if (!intent) {
      return
    }

    const nextIntent = cloneIntent(intent)
    nextIntent.auditTrail.push(parsedEvent)
    state.intents[parsedEvent.intentId] = nextIntent
    this.writeState(state)
  }

  listPreflightRecords(intentId: string): PreflightRecord[] {
    return this.readState()
      .preflightRecords.filter((record) => record.intentId === intentId)
      .map((record) => PreflightRecordSchema.parse(structuredClone(record)))
  }

  getLatestPreflightRecord(intentId: string): PreflightRecord | null {
    const records = this.listPreflightRecords(intentId)
    return records.at(-1) ?? null
  }

  appendPreflightRecord(record: PreflightRecord): void {
    const state = this.readState()
    state.preflightRecords.push(PreflightRecordSchema.parse(structuredClone(record)))
    this.writeState(state)
  }

  listExecutionLogs(intentId: string): ExecutionLogRecord[] {
    return this.readState()
      .executionLogs.filter((record) => record.intentId === intentId)
      .map((record) => structuredClone(record))
  }

  appendExecutionLog(record: ExecutionLogRecord): void {
    const state = this.readState()
    state.executionLogs.push(structuredClone(record))
    this.writeState(state)
  }

  private readState(): StoredExecutionState {
    return parseState(readFileSync(this.filePath, 'utf8'))
  }

  private writeState(state: StoredExecutionState): void {
    writeFileSync(this.filePath, JSON.stringify(state, null, 2))
  }
}

export function createExecutionRepository(options: {
  storageKind: string
  storagePath?: string
}): ExecutionRepository {
  if (options.storageKind === 'memory') {
    return new InMemoryExecutionRepository()
  }

  if (!options.storagePath) {
    throw new Error(`execution.storagePath is required for storageKind=${options.storageKind}`)
  }

  const storageCheck = checkExecutionRepositoryStorageSync(options)
  if (!storageCheck.ok) {
    throw new Error(storageCheck.reason ?? 'execution repository storage is unavailable')
  }

  return new FileExecutionRepository(options.storagePath)
}

export async function checkExecutionRepositoryStorage(options: {
  storageKind: string
  storagePath?: string
}): Promise<ExecutionRepositoryStorageCheck> {
  if (options.storageKind === 'memory') {
    return { ok: true, storageKind: options.storageKind }
  }

  if (!options.storagePath) {
    return {
      ok: false,
      storageKind: options.storageKind,
      reason: `execution.storagePath is required for storageKind=${options.storageKind}`,
    }
  }

  const storagePath = path.resolve(options.storagePath)
  const parent = path.dirname(storagePath)
  try {
    await access(parent, constants.R_OK | constants.W_OK)
  } catch {
    return {
      ok: false,
      storageKind: options.storageKind,
      storagePath,
      reason: `execution storage parent is not readable and writable: ${parent}`,
    }
  }

  if (!existsSync(storagePath)) {
    return { ok: true, storageKind: options.storageKind, storagePath }
  }

  try {
    parseState(readFileSync(storagePath, 'utf8'))
    await access(storagePath, constants.R_OK | constants.W_OK)
    return { ok: true, storageKind: options.storageKind, storagePath }
  } catch (error) {
    return {
      ok: false,
      storageKind: options.storageKind,
      storagePath,
      reason: `execution storage state is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

function checkExecutionRepositoryStorageSync(options: {
  storageKind: string
  storagePath?: string
}): ExecutionRepositoryStorageCheck {
  if (options.storageKind === 'memory') {
    return { ok: true, storageKind: options.storageKind }
  }

  if (!options.storagePath) {
    return {
      ok: false,
      storageKind: options.storageKind,
      reason: `execution.storagePath is required for storageKind=${options.storageKind}`,
    }
  }

  const storagePath = path.resolve(options.storagePath)
  const parent = path.dirname(storagePath)
  try {
    if (!existsSync(parent)) {
      return {
        ok: false,
        storageKind: options.storageKind,
        storagePath,
        reason: `execution storage parent does not exist: ${parent}`,
      }
    }
    accessSync(parent, constants.R_OK | constants.W_OK)
    if (existsSync(storagePath)) {
      accessSync(storagePath, constants.R_OK | constants.W_OK)
      parseState(readFileSync(storagePath, 'utf8'))
    }
    return { ok: true, storageKind: options.storageKind, storagePath }
  } catch (error) {
    return {
      ok: false,
      storageKind: options.storageKind,
      storagePath,
      reason: `execution storage state is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

function ensureRepositoryFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify(EMPTY_STATE, null, 2))
  }
}
