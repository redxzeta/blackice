import { z } from 'zod';

export const AnalyzeLogsRequestSchema = z
  .object({
    source: z.enum(['journalctl', 'docker', 'file']),
    target: z.string().min(1).max(300),
    hours: z.number().positive().max(168),
    maxLines: z.number().int().positive().max(5000)
  })
  .strict();

export type AnalyzeLogsRequest = z.infer<typeof AnalyzeLogsRequestSchema>;
