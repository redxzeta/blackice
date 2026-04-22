import { randomUUID } from 'node:crypto'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  type ExecutionAdapter,
  type ExecutionLogRecord,
  ExecutionLogRecordSchema,
  ExecutionModeSchema,
  type ExecutionRequest,
  ExecutionRequestSchema,
  type SignedExecutionRequest,
  SignedExecutionRequestSchema,
} from './contracts.js'
import type { AuditEvent, IntentRecord, OrderRecord } from './schema.js'
import { OrderRecordSchema } from './schema.js'

const DEFAULT_EXECUTION_MODE = 'taker'

export class ExecutionAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionAdapterError'
  }
}

export class PaperExecutionAdapter implements ExecutionAdapter {
  async placeOrder(request: SignedExecutionRequest): Promise<ExecutionLogRecord> {
    const normalizedRequest = SignedExecutionRequestSchema.parse(request)
    const nowIso = new Date().toISOString()

    return ExecutionLogRecordSchema.parse({
      logId: randomUUID(),
      intentId: normalizedRequest.intentId,
      venue: normalizedRequest.venue,
      status: 'filled',
      recordedAt: nowIso,
      orderId: `paper-${normalizedRequest.requestId}`,
      requestId: normalizedRequest.requestId,
      preflightOk: true,
      details: {
        executionMode: normalizedRequest.executionMode,
      },
    })
  }

  async cancelOrder(orderId: string, requestId: string): Promise<ExecutionLogRecord> {
    return ExecutionLogRecordSchema.parse({
      logId: randomUUID(),
      intentId: orderId,
      venue: 'paper',
      status: 'cancelled',
      recordedAt: new Date().toISOString(),
      orderId,
      requestId,
      preflightOk: true,
      details: {},
    })
  }
}

export function createExecutionAdapter(options: { venue?: string } = {}): ExecutionAdapter {
  const venue = (options.venue ?? getRuntimeConfig().execution.defaultVenue).trim()

  switch (venue) {
    case 'paper':
      return new PaperExecutionAdapter()
    default:
      throw new ExecutionAdapterError(`Unsupported execution.defaultVenue: ${venue}`)
  }
}

export function buildExecutionRequestFromIntent(
  intent: IntentRecord,
  requestId: string,
  submittedAt: string
): ExecutionRequest {
  const executionMode = resolveExecutionMode(intent)

  return ExecutionRequestSchema.parse({
    requestId,
    intentId: intent.intentId,
    venue: intent.venue,
    marketId: intent.market,
    side: intent.side,
    quantity: intent.quantity,
    limitPrice: intent.limitPrice,
    executionMode,
    submittedAt,
  })
}

export function mapExecutionLogToOrderStatus(
  status: ExecutionLogRecord['status']
): OrderRecord['status'] {
  switch (status) {
    case 'accepted':
      return 'pending'
    case 'placed':
      return 'placed'
    case 'filled':
      return 'filled'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'rejected':
      return 'failed'
  }
}

export function mapExecutionLogToIntentStatus(
  status: ExecutionLogRecord['status']
): IntentRecord['status'] {
  switch (status) {
    case 'accepted':
    case 'placed':
      return 'execution_pending'
    case 'filled':
      return 'executed'
    case 'cancelled':
    case 'failed':
    case 'rejected':
      return 'confirmed'
  }
}

export function mapExecutionLogToAuditEventType(
  status: ExecutionLogRecord['status']
): AuditEvent['type'] {
  switch (status) {
    case 'accepted':
    case 'placed':
      return 'execution_pending'
    case 'filled':
      return 'execution_succeeded'
    case 'cancelled':
      return 'execution_cancelled'
    case 'failed':
    case 'rejected':
      return 'execution_failed'
  }
}

export function buildOrderRecordFromExecutionLog(input: {
  intent: IntentRecord
  executionLog: ExecutionLogRecord
  recordedAt?: string
}): OrderRecord {
  const recordedAt = input.recordedAt ?? input.executionLog.recordedAt
  const failureReason = extractFailureReason(input.executionLog)

  return OrderRecordSchema.parse({
    orderId: randomUUID(),
    venue: input.intent.venue,
    market: input.intent.market,
    side: input.intent.side,
    quantity: input.intent.quantity,
    limitPrice: input.intent.limitPrice,
    notionalUsd: input.intent.notionalUsd,
    status: mapExecutionLogToOrderStatus(input.executionLog.status),
    createdAt: recordedAt,
    updatedAt: recordedAt,
    externalOrderId: input.executionLog.orderId,
    failureReason,
  })
}

function resolveExecutionMode(intent: IntentRecord) {
  const rawMode = intent.metadata.executionMode
  if (typeof rawMode !== 'string') {
    return DEFAULT_EXECUTION_MODE
  }

  const parsedMode = ExecutionModeSchema.safeParse(rawMode.trim())
  return parsedMode.success ? parsedMode.data : DEFAULT_EXECUTION_MODE
}

function extractFailureReason(executionLog: ExecutionLogRecord): string | undefined {
  if (executionLog.status !== 'failed' && executionLog.status !== 'rejected') {
    return undefined
  }

  const reason = executionLog.details.reason
  return typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : executionLog.status
}
