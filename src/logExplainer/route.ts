import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import { AnalyzeLogsBatchRequestSchema, AnalyzeLogsRequestSchema, type AnalyzeLogsRequest } from './schema.js';
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

type AnalysisResult = {
  analysis: string;
  safety?: {
    redacted: boolean;
    reasons: string[];
  };
};

async function analyzeOneRequest(request: AnalyzeLogsRequest): Promise<AnalysisResult> {
  const rawLogs = await collectLogs(request);

  if (!rawLogs.trim()) {
    const err = new Error('No logs were collected for the given query') as Error & { status: number };
    err.status = 422;
    throw err;
  }

  const { text: logs, truncated } = truncateLogs(rawLogs);
  const userPrompt = buildUserPrompt({ ...request, logs, truncated });
  const analysis = await analyzeLogsWithOllama({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt
  });

  const safety = ensureReadOnlyAnalysisOutput(analysis);
  if (!safety.safe) {
    const sanitized = sanitizeReadOnlyAnalysisOutput(analysis);

    log.info('log_explainer_output_redacted', {
      reason: safety.reason,
      redacted: sanitized.redacted,
      reasons: sanitized.reasons
    });

    return {
      analysis: sanitized.analysis,
      safety: {
        redacted: sanitized.redacted,
        reasons: sanitized.reasons
      }
    };
  }

  return { analysis };
}

async function runConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;

      if (current >= items.length) {
        break;
      }

      results[current] = await worker(items[current]);
    }
  });

  await Promise.all(runners);
  return results;
}

export function registerLogExplainerRoutes(app: Express): void {
  app.get('/analyze/logs/targets', (_req: Request, res: Response) => {
    const targets = getAllowedLogFileTargets();
    res.status(200).json({ targets });
  });

  app.post('/analyze/logs/batch', async (req: Request, res: Response) => {
    try {
      const parsed = AnalyzeLogsBatchRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
        return;
      }

      const body = parsed.data;
      const allowedTargets = getAllowedLogFileTargets();
      const allowedSet = new Set(allowedTargets);
      const candidateTargets = body.targets && body.targets.length > 0 ? body.targets : allowedTargets;
      const targets = candidateTargets.filter((target) => allowedSet.has(target));

      if (targets.length === 0) {
        res.status(400).json({
          error: 'No valid targets to analyze',
          details: 'Provide targets listed in GET /analyze/logs/targets'
        });
        return;
      }

      const results = await runConcurrent(targets, body.concurrency, async (target) => {
        const request: AnalyzeLogsRequest = {
          source: 'file',
          target,
          hours: body.hours,
          maxLines: body.maxLines
        };

        try {
          const analyzed = await analyzeOneRequest(request);
          return {
            target,
            ok: true,
            ...analyzed
          };
        } catch (error: unknown) {
          return {
            target,
            ok: false,
            error: errMessage(error),
            status: errStatus(error)
          };
        }
      });

      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      res.status(200).json({
        source: 'file',
        requestedTargets: candidateTargets.length,
        analyzedTargets: results.length,
        ok,
        failed,
        results
      });
    } catch (error: unknown) {
      const status = errStatus(error);
      const message = errMessage(error);

      log.error('log_explainer_batch_failed', { status, message });
      res.status(status).json({ error: message });
    }
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

      const analyzed = await analyzeOneRequest(parsed.data);
      res.status(200).json(analyzed);
    } catch (error: unknown) {
      const status = errStatus(error);
      const message = errMessage(error);

      log.error('log_explainer_failed', { status, message });
      res.status(status).json({ error: message });
    }
  });
}
