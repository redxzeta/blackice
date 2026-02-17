import { z } from 'zod';

export const AnalyzeLogsRequestSchema = z
  .object({
    source: z.enum(['journalctl', 'docker', 'file']),
    target: z.string().min(1).max(300),
    hours: z.number().positive().max(168),
    maxLines: z.number().int().positive().max(5000)
  })
  .strict();

export const AnalyzeLogsBatchRequestSchema = z
  .object({
    source: z.literal('file').optional().default('file'),
    targets: z.array(z.string().min(1).max(300)).optional(),
    hours: z.number().positive().max(168).optional().default(6),
    maxLines: z.number().int().positive().max(5000).optional().default(300),
    concurrency: z.number().int().min(1).max(5).optional().default(2)
  })
  .strict();

export type AnalyzeLogsRequest = z.infer<typeof AnalyzeLogsRequestSchema>;
export type AnalyzeLogsBatchRequest = z.infer<typeof AnalyzeLogsBatchRequestSchema>;
