import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import { AnalyzeLogsRequestSchema } from './schema.js';
import { collectLogs, getAllowedLogFileTargets } from './logCollector.js';
import { analyzeLogsWithOllama } from './ollamaClient.js';
import { SYSTEM_PROMPT, buildUserPrompt, truncateLogs } from './promptTemplates.js';
import { ensureReadOnlyAnalysisOutput, sanitizeReadOnlyAnalysisOutput } from './outputSafety.js';

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
  app.get('/analyze/logs/targets', (_req: Request, res: Response) => {
    const targets = getAllowedLogFileTargets();
    res.status(200).json({ targets });
  });

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

      const safety = ensureReadOnlyAnalysisOutput(analysis);
      let finalAnalysis = analysis;

      if (!safety.safe) {
        const sanitized = sanitizeReadOnlyAnalysisOutput(analysis);
        finalAnalysis = sanitized.analysis;

        log.info('log_explainer_output_redacted', {
          reason: safety.reason,
          redacted: sanitized.redacted,
          reasons: sanitized.reasons
        });

        res.status(200).json({
          analysis: finalAnalysis,
          safety: {
            redacted: sanitized.redacted,
            reasons: sanitized.reasons
          }
        });
        return;
      }

      // Return model markdown output verbatim only when it passes safety policy.
      res.status(200).json({ analysis: finalAnalysis });
    } catch (error: unknown) {
      const status = errStatus(error);
      const message = errMessage(error);

      log.error('log_explainer_failed', { status, message });
      res.status(status).json({ error: message });
    }
  });
}
