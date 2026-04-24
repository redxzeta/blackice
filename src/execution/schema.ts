import { z } from 'zod'
import {
  CandidateDiscoveryQuerySchema,
  EnrichedCandidateRecordSchema,
  ExecutionLogRecordSchema,
  PreflightRecordSchema,
  PreflightResultSchema,
} from './contracts.js'

export const IntentStatusSchema = z.enum([
  'submitted',
  'confirmed',
  'execution_pending',
  'executed',
  'cancelled',
  'rejected',
])

export const OrderStatusSchema = z.enum(['pending', 'placed', 'filled', 'cancelled', 'failed'])

export const AuditEventTypeSchema = z.enum([
  'intent_submitted',
  'intent_confirmed',
  'intent_rejected',
  'preflight_recorded',
  'signing_requested',
  'signing_succeeded',
  'signing_failed',
  'execution_requested',
  'execution_pending',
  'execution_cancelled',
  'execution_succeeded',
  'execution_failed',
  'intent_cancelled',
])

export const ExecutionPolicySnapshotSchema = z.object({
  maxNotionalUsd: z.number().positive(),
  dailyNotionalLimitUsd: z.number().positive(),
  allowedVenues: z.array(z.string().min(1)).min(1),
  maxTtlSeconds: z.number().int().positive(),
})

export const SubmitIntentRequestSchema = z.object({
  intentId: z.string().min(1).max(120).optional(),
  idempotencyKey: z.string().min(1).max(120),
  accountId: z.string().min(1).max(120),
  market: z.string().min(3).max(64),
  venue: z.string().min(1).max(64),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  notionalUsd: z.number().positive(),
  ttlSeconds: z.number().int().min(1).max(86_400),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

export const OrderRecordSchema = z.object({
  orderId: z.string().min(1),
  venue: z.string().min(1),
  market: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  notionalUsd: z.number().positive(),
  status: OrderStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  externalOrderId: z.string().min(1).optional(),
  failureReason: z.string().min(1).optional(),
})

export const AuditEventSchema = z.object({
  eventId: z.string().min(1),
  intentId: z.string().min(1),
  type: AuditEventTypeSchema,
  timestamp: z.string().datetime(),
  requestId: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
})

export const IntentRecordSchema = z.object({
  intentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  accountId: z.string().min(1),
  market: z.string().min(1),
  venue: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  notionalUsd: z.number().positive(),
  ttlSeconds: z.number().int().positive(),
  status: IntentStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  confirmedAt: z.string().datetime().optional(),
  executedAt: z.string().datetime().optional(),
  cancelledAt: z.string().datetime().optional(),
  rejectionReason: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  signerRef: z.string().min(1).optional(),
  orders: z.array(OrderRecordSchema).default([]),
  auditTrail: z.array(AuditEventSchema).default([]),
})

export const SubmitIntentResponseSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  intent: IntentRecordSchema,
  policy: ExecutionPolicySnapshotSchema,
})

export const IntentActionResponseSchema = z.object({
  ok: z.literal(true),
  intent: IntentRecordSchema,
})

export const ExecuteIntentRequestSchema = z.object({}).default({})

export const ExecuteIntentResponseSchema = z.object({
  ok: z.literal(true),
  intent: IntentRecordSchema,
  preflightRecord: PreflightRecordSchema.optional(),
})

export const IntentRefreshResponseSchema = z.object({
  ok: z.literal(true),
  intent: IntentRecordSchema,
  executionLog: ExecutionLogRecordSchema.optional(),
})

export const ListIntentsResponseSchema = z.object({
  ok: z.literal(true),
  intents: z.array(IntentRecordSchema),
})

export const ListCandidatesRequestSchema = CandidateDiscoveryQuerySchema

export const ListCandidatesResponseSchema = z.object({
  ok: z.literal(true),
  candidates: z.array(EnrichedCandidateRecordSchema),
})

export const PreflightActionResponseSchema = z.object({
  ok: z.literal(true),
  preflight: PreflightResultSchema,
})

export const IntentPreflightResponseSchema = z.object({
  ok: z.literal(true),
  preflightRecord: PreflightRecordSchema,
})

export type SubmitIntentRequest = z.input<typeof SubmitIntentRequestSchema>
export type ExecutionPolicySnapshot = z.infer<typeof ExecutionPolicySnapshotSchema>
export type IntentRecord = z.infer<typeof IntentRecordSchema>
export type OrderRecord = z.infer<typeof OrderRecordSchema>
export type AuditEvent = z.infer<typeof AuditEventSchema>
export type IntentStatus = z.infer<typeof IntentStatusSchema>
