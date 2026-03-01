import { z } from 'zod';

export const ANALYZE_MAX_HOURS = 168;
export const ANALYZE_MAX_LINES_REQUEST = 5000;
export const BATCH_CONCURRENCY_MIN = 1;
export const LOKI_MAX_LIMIT_REQUEST = 5000;
const ENV_MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 5);
export const BATCH_CONCURRENCY_MAX = Number.isFinite(ENV_MAX_CONCURRENCY) && ENV_MAX_CONCURRENCY >= BATCH_CONCURRENCY_MIN
  ? Math.floor(ENV_MAX_CONCURRENCY)
  : 5;
const BATCH_CONCURRENCY_DEFAULT = Math.min(2, BATCH_CONCURRENCY_MAX);

const LokiFiltersSchema = z
  .record(
    z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'filter keys must be valid Loki label names')
      .min(1)
      .max(60),
    z.string().min(1).max(300)
  )
  .refine((filters) => Object.keys(filters).length > 0, 'filters must include at least one label');

export const AnalyzeLogsRequestSchema = z
  .object({
    source: z.enum(['journalctl', 'journald', 'docker']),
    target: z.string().min(1).max(300),
    hours: z.number().positive().max(ANALYZE_MAX_HOURS),
    maxLines: z.number().int().positive().max(ANALYZE_MAX_LINES_REQUEST),
    analyze: z.boolean().optional(),
    collectOnly: z.boolean().optional()
  })
  .strict();

export const AnalyzeLogsBatchRequestSchema = z
  .object({
    source: z.enum(['journald', 'loki']),
    targets: z.array(z.string().min(1).max(600)).optional(),
    selectors: z.array(z.string().min(1).max(600)).optional(),
    query: z.string().min(1).max(4_000).optional(),
    filters: LokiFiltersSchema.optional(),
    contains: z.string().min(1).max(500).optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().positive().max(LOKI_MAX_LIMIT_REQUEST).optional().default(2_000),
    allowUnscoped: z.boolean().optional().default(false),
    hours: z.number().positive().max(ANALYZE_MAX_HOURS).optional().default(6),
    sinceMinutes: z.number().int().positive().max(ANALYZE_MAX_HOURS * 60).optional(),
    maxLines: z.number().int().positive().max(ANALYZE_MAX_LINES_REQUEST).optional().default(300),
    concurrency: z.number().int().min(BATCH_CONCURRENCY_MIN).max(BATCH_CONCURRENCY_MAX).optional().default(BATCH_CONCURRENCY_DEFAULT),
    analyze: z.boolean().optional().default(true),
    collectOnly: z.boolean().optional()
  })
  .superRefine((value, ctx) => {
    if (value.source !== 'loki') {
      return;
    }

    const hasQuery = typeof value.query === 'string' && value.query.trim().length > 0;
    const hasFilters = value.filters !== undefined;
    const hasSelectors = (value.selectors?.length ?? 0) > 0;
    const hasTargets = (value.targets?.length ?? 0) > 0;

    if (hasQuery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['query'],
        message: 'query is not allowed for source=loki; use filters'
      });
    }

    if (hasSelectors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectors'],
        message: 'selectors are not allowed for source=loki; use filters'
      });
    }

    if (hasTargets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'targets are not allowed for source=loki; use filters'
      });
    }

    if (!hasFilters) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters'],
        message: 'filters are required for source=loki'
      });
    }
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
    no_logs: z.boolean().optional(),
    message: z.string().optional(),
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
    analysis: z.string().optional(),
    safety: z
      .object({
        redacted: z.boolean(),
        reasons: z.array(z.string()),
      })
      .optional(),
    no_logs: z.boolean().optional(),
    logs: z.string().optional(),
    message: z.string().optional()
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
    source: z.enum(['journald', 'loki']),
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
      batchConcurrencyMax: z.number().int().positive(),
      loki: z.object({
        enabled: z.boolean(),
        timeoutMs: z.number().int().positive(),
        maxWindowMinutes: z.number().int().positive(),
        defaultWindowMinutes: z.number().int().positive(),
        maxLinesCap: z.number().int().positive(),
        maxResponseBytes: z.number().int().positive(),
        requireScopeLabels: z.boolean()
      })
    }),
    targets: z.object({
      count: z.number().int().nonnegative(),
      items: z.array(z.string())
    }),
    llm: z.object({
      baseUrl: z.string(),
      model: z.string(),
      timeoutMs: z.number().int().positive(),
      retryAttempts: z.number().int().nonnegative(),
      retryBackoffMs: z.number().int().positive()
    })
  })
  .strict();

export type AnalyzeLogsRequest = z.infer<typeof AnalyzeLogsRequestSchema>;
export type AnalyzeLogsBatchRequest = z.infer<typeof AnalyzeLogsBatchRequestSchema>;
export type AnalyzeLogsBatchLokiRequest = {
  source: 'loki';
  query?: string;
  filters?: Record<string, string>;
  contains?: string;
  start?: string;
  end?: string;
  limit?: number;
  allowUnscoped?: boolean;
};
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
      no_logs: { type: 'boolean' },
      message: { type: 'string' },
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
      source: { enum: ['journald', 'loki'] },
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
              required: ['target', 'ok'],
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
                },
                no_logs: { type: 'boolean' },
                logs: { type: 'string' },
                message: { type: 'string' }
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
