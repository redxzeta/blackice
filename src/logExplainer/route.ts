import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import { AnalyzeLogsRequestSchema } from './schema.js';
import { collectLogs } from './logCollector.js';
import { analyzeLogsWithOllama } from './ollamaClient.js';
import { SYSTEM_PROMPT, buildUserPrompt, truncateLogs } from './promptTemplates.js';

function errStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return 500;
}

function errMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function registerLogExplainerRoutes(app: Express): void {
  app.post('/analyze/logs', async (req: Request, res: Response) => {
    try {
      const parsed = AnalyzeLogsRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
        return;
      }

      const request = parsed.data;
      const rawLogs = await collectLogs(request);

      if (!rawLogs.trim()) {
        res.status(422).json({ error: 'No logs were collected for the given query' });
        return;
      }

      const { text: logs, truncated } = truncateLogs(rawLogs);
      const userPrompt = buildUserPrompt({ ...request, logs, truncated });
      const analysis = await analyzeLogsWithOllama({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt
      });

      // Requirement: return model markdown output verbatim.
      res.status(200).json({ analysis });
    } catch (error: unknown) {
      const status = errStatus(error);
      const message = errMessage(error);

      log.error('log_explainer_failed', { status, message });
      res.status(status).json({ error: message });
    }
  });
}
