import { z } from 'zod';

export const ANALYZE_MAX_HOURS = 168;
export const ANALYZE_MAX_LINES_REQUEST = 5000;
export const BATCH_CONCURRENCY_MIN = 1;
export const BATCH_CONCURRENCY_MAX = 5;

export const AnalyzeLogsRequestSchema = z
  .object({
    source: z.enum(['journalctl', 'docker', 'file']),
    target: z.string().min(1).max(300),
    hours: z.number().positive().max(ANALYZE_MAX_HOURS),
    maxLines: z.number().int().positive().max(ANALYZE_MAX_LINES_REQUEST)
  })
  .strict();

export const AnalyzeLogsBatchRequestSchema = z
  .object({
    source: z.literal('file').optional().default('file'),
    targets: z.array(z.string().min(1).max(300)).optional(),
    hours: z.number().positive().max(ANALYZE_MAX_HOURS).optional().default(6),
    maxLines: z.number().int().positive().max(ANALYZE_MAX_LINES_REQUEST).optional().default(300),
    concurrency: z.number().int().min(BATCH_CONCURRENCY_MIN).max(BATCH_CONCURRENCY_MAX).optional().default(2)
  })
  .strict();

export const AnalyzeLogsTargetsResponseSchema = z
  .object({
    targets: z.array(z.string())
  })
  .strict();

export const AnalyzeLogsResponseSchema = z
  .object({
    analysis: z.string(),
    safety: z
      .object({
        redacted: z.boolean(),
        reasons: z.array(z.string())
      })
      .optional()
  })
  .strict();

export const AnalyzeLogsBatchResultOkSchema = z
  .object({
    target: z.string(),
    ok: z.literal(true),
    analysis: z.string(),
    safety: z
      .object({
        redacted: z.boolean(),
        reasons: z.array(z.string())
      })
      .optional()
  })
  .strict();

export const AnalyzeLogsBatchResultErrorSchema = z
  .object({
    target: z.string(),
    ok: z.literal(false),
    status: z.number().int(),
    error: z.string()
  })
  .strict();

export const AnalyzeLogsBatchResultSchema = z.discriminatedUnion('ok', [
  AnalyzeLogsBatchResultOkSchema,
  AnalyzeLogsBatchResultErrorSchema
]);

export const AnalyzeLogsBatchResponseSchema = z
  .object({
    source: z.literal('file'),
    requestedTargets: z.number().int().nonnegative(),
    analyzedTargets: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    results: z.array(AnalyzeLogsBatchResultSchema)
  })
  .strict();

export const AnalyzeLogsStatusResponseSchema = z
  .object({
    endpoints: z.array(z.string()),
    limits: z.object({
      maxHours: z.number().int().positive(),
      maxLinesRequest: z.number().int().positive(),
      maxLinesEffectiveCap: z.number().int().positive(),
      batchConcurrencyMin: z.number().int().positive(),
      batchConcurrencyMax: z.number().int().positive()
    }),
    targets: z.object({
      count: z.number().int().nonnegative(),
      items: z.array(z.string())
    }),
    llm: z.object({
      baseUrl: z.string(),
      model: z.string(),
      timeoutMs: z.number().int().positive()
    })
  })
  .strict();

export type AnalyzeLogsRequest = z.infer<typeof AnalyzeLogsRequestSchema>;
export type AnalyzeLogsBatchRequest = z.infer<typeof AnalyzeLogsBatchRequestSchema>;
export type AnalyzeLogsTargetsResponse = z.infer<typeof AnalyzeLogsTargetsResponseSchema>;
export type AnalyzeLogsResponse = z.infer<typeof AnalyzeLogsResponseSchema>;
export type AnalyzeLogsBatchResultOk = z.infer<typeof AnalyzeLogsBatchResultOkSchema>;
export type AnalyzeLogsBatchResultError = z.infer<typeof AnalyzeLogsBatchResultErrorSchema>;
export type AnalyzeLogsBatchResponse = z.infer<typeof AnalyzeLogsBatchResponseSchema>;
export type AnalyzeLogsStatusResponse = z.infer<typeof AnalyzeLogsStatusResponseSchema>;

export const LogExplainerJsonSchemas = {
  analyzeLogsTargetsResponse: {
    type: 'object',
    required: ['targets'],
    properties: {
      targets: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    additionalProperties: false
  },
  analyzeLogsResponse: {
    type: 'object',
    required: ['analysis'],
    properties: {
      analysis: { type: 'string' },
      safety: {
        type: 'object',
        required: ['redacted', 'reasons'],
        properties: {
          redacted: { type: 'boolean' },
          reasons: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  },
  analyzeLogsBatchResponse: {
    type: 'object',
    required: ['source', 'requestedTargets', 'analyzedTargets', 'ok', 'failed', 'results'],
    properties: {
      source: { const: 'file' },
      requestedTargets: { type: 'integer', minimum: 0 },
      analyzedTargets: { type: 'integer', minimum: 0 },
      ok: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      results: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['target', 'ok', 'analysis'],
              properties: {
                target: { type: 'string' },
                ok: { const: true },
                analysis: { type: 'string' },
                safety: {
                  type: 'object',
                  required: ['redacted', 'reasons'],
                  properties: {
                    redacted: { type: 'boolean' },
                    reasons: { type: 'array', items: { type: 'string' } }
                  },
                  additionalProperties: false
                }
              },
              additionalProperties: false
            },
            {
              type: 'object',
              required: ['target', 'ok', 'status', 'error'],
              properties: {
                target: { type: 'string' },
                ok: { const: false },
                status: { type: 'integer' },
                error: { type: 'string' }
              },
              additionalProperties: false
            }
          ]
        }
      }
    },
    additionalProperties: false
  }
} as const;
