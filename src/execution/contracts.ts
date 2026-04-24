import { z } from 'zod'
import type { AuditEvent, IntentRecord, IntentStatus } from './schema.js'

export const MarketTypeSchema = z.enum(['standard', 'sports', 'election', 'other'])

export const ExecutionModeSchema = z.enum(['taker', 'maker', 'none'])

export const QualificationStatusSchema = z.enum(['eligible', 'filtered', 'blocked'])

export const CandidateDiscoveryQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  excludedEventTypes: z.array(MarketTypeSchema).optional(),
})

export const CandidateRecordSchema = z.object({
  marketId: z.string().min(1),
  eventId: z.string().min(1),
  slug: z.string().min(1),
  question: z.string().min(1),
  marketType: MarketTypeSchema,
  tradable: z.boolean(),
  metadataComplete: z.boolean(),
  endDate: z.string().datetime().optional(),
  tags: z.array(z.string().min(1)).default([]),
})

export const OrderbookSnapshotSchema = z.object({
  bestBid: z.number().nonnegative().nullable(),
  bestAsk: z.number().nonnegative().nullable(),
  spreadBps: z.number().nonnegative().nullable(),
  depthUsd: z.number().nonnegative(),
  asOf: z.string().datetime(),
})

export const EnrichedCandidateRecordSchema = CandidateRecordSchema.extend({
  qualificationStatus: QualificationStatusSchema,
  qualificationReasons: z.array(z.string().min(1)).default([]),
  orderbook: OrderbookSnapshotSchema,
  impliedProbability: z.number().min(0).max(1).nullable(),
})

export const PreflightCheckCodeSchema = z.enum([
  'candidate_not_tradable',
  'metadata_incomplete',
  'spread_above_limit',
  'depth_below_minimum',
  'position_above_limit',
  'venue_not_allowed',
  'signing_unavailable',
])

export const PreflightCheckResultSchema = z.object({
  code: PreflightCheckCodeSchema,
  ok: z.boolean(),
  message: z.string().min(1),
})

export const PreflightResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string().datetime(),
  venue: z.string().min(1),
  checks: z.array(PreflightCheckResultSchema).min(1),
})

export const PreflightRequestSchema = z.object({
  candidate: EnrichedCandidateRecordSchema,
  venue: z.string().min(1).optional(),
  positionUsd: z.number().nonnegative().optional(),
})

export const PreflightRecordSchema = z.object({
  preflightId: z.string().min(1),
  intentId: z.string().min(1),
  recordedAt: z.string().datetime(),
  policyFingerprint: z.string().min(1),
  request: PreflightRequestSchema,
  result: PreflightResultSchema,
})

export const ExecutionRequestSchema = z.object({
  requestId: z.string().min(1),
  intentId: z.string().min(1),
  venue: z.string().min(1),
  marketId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  executionMode: ExecutionModeSchema,
  submittedAt: z.string().datetime(),
})

export const SignedExecutionRequestSchema = ExecutionRequestSchema.extend({
  signerRef: z.string().min(1),
  signature: z.string().min(1),
})

export const ExecutionLogRecordSchema = z.object({
  logId: z.string().min(1),
  intentId: z.string().min(1),
  venue: z.string().min(1),
  status: z.enum(['accepted', 'rejected', 'placed', 'filled', 'cancelled', 'failed']),
  recordedAt: z.string().datetime(),
  orderId: z.string().min(1).optional(),
  requestId: z.string().min(1),
  preflightOk: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
})

export type CandidateDiscoveryQuery = z.infer<typeof CandidateDiscoveryQuerySchema>
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>
export type OrderbookSnapshot = z.infer<typeof OrderbookSnapshotSchema>
export type EnrichedCandidateRecord = z.infer<typeof EnrichedCandidateRecordSchema>
export type PreflightCheckCode = z.infer<typeof PreflightCheckCodeSchema>
export type PreflightCheckResult = z.infer<typeof PreflightCheckResultSchema>
export type PreflightResult = z.infer<typeof PreflightResultSchema>
export type PreflightRequest = z.infer<typeof PreflightRequestSchema>
export type PreflightRecord = z.infer<typeof PreflightRecordSchema>
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>
export type SignedExecutionRequest = z.infer<typeof SignedExecutionRequestSchema>
export type ExecutionLogRecord = z.infer<typeof ExecutionLogRecordSchema>
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

export type CandidateDiscoveryAdapter = {
  listCandidates(query: CandidateDiscoveryQuery): Promise<CandidateRecord[]>
}

export type OrderbookReadAdapter = {
  getSnapshot(candidate: CandidateRecord): Promise<OrderbookSnapshot>
}

export type CandidateEnrichmentAdapter = {
  listEnrichedCandidates(query: CandidateDiscoveryQuery): Promise<EnrichedCandidateRecord[]>
}

export type PreflightEvaluator = {
  evaluate(request: PreflightRequest): Promise<PreflightResult>
}

export type SigningAdapter = {
  signExecutionRequest(request: ExecutionRequest): Promise<SignedExecutionRequest>
}

export type ExecutionAdapter = {
  placeOrder(request: SignedExecutionRequest): Promise<ExecutionLogRecord>
  cancelOrder(orderId: string, requestId: string): Promise<ExecutionLogRecord>
}

export type ExecutionRepository = {
  getIntent(intentId: string): IntentRecord | null
  listIntents(status?: IntentStatus): IntentRecord[]
  saveIntent(intent: IntentRecord): void
  getIntentIdByIdempotencyKey(idempotencyKey: string): string | null
  saveIdempotencyKey(idempotencyKey: string, intentId: string): void
  appendAuditEvent(event: AuditEvent): void
  listPreflightRecords(intentId: string): PreflightRecord[]
  getLatestPreflightRecord(intentId: string): PreflightRecord | null
  appendPreflightRecord(record: PreflightRecord): void
  appendExecutionLog(record: ExecutionLogRecord): void
}
