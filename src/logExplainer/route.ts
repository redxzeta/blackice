import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import {
  ANALYZE_MAX_LINES_REQUEST,
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsBatchResponseSchema,
  AnalyzeLogsRequestSchema,
  AnalyzeLogsResponseSchema,
  AnalyzeLogsStatusResponseSchema,
  AnalyzeLogsTargetsResponseSchema,
  BATCH_CONCURRENCY_MAX,
  BATCH_CONCURRENCY_MIN,
  LogExplainerJsonSchemas,
  type AnalyzeLogsBatchResultError,
  type AnalyzeLogsBatchResultOk,
  type AnalyzeLogsRequest
} from './schema.js';
import { collectLogs, getAllowedLogFileTargets, getLogCollectorLimits } from './logCollector.js';
import { analyzeLogsWithOllama, getOllamaRuntimeMetadata } from './ollamaClient.js';
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
    const body = AnalyzeLogsTargetsResponseSchema.parse({ targets });
    res.status(200).json(body);
  });

  app.get('/analyze/logs/status', (_req: Request, res: Response) => {
    const targets = getAllowedLogFileTargets();
    const collectorLimits = getLogCollectorLimits();
    const ollama = getOllamaRuntimeMetadata();
    const endpoints = [
      'GET /analyze/logs/targets',
      'GET /analyze/logs/status',
      'GET /analyze/logs/metadata',
      'POST /analyze/logs',
      'POST /analyze/logs/batch'
    ];

    const body = AnalyzeLogsStatusResponseSchema.parse({
      endpoints,
      limits: {
        maxHours: collectorLimits.maxHours,
        maxLinesRequest: ANALYZE_MAX_LINES_REQUEST,
        maxLinesEffectiveCap: collectorLimits.maxLinesCap,
        batchConcurrencyMin: BATCH_CONCURRENCY_MIN,
        batchConcurrencyMax: BATCH_CONCURRENCY_MAX
      },
      targets: {
        count: targets.length,
        items: targets
      },
      llm: ollama
    });

    res.status(200).json(body);
  });

  app.get('/analyze/logs/metadata', (_req: Request, res: Response) => {
    const status = AnalyzeLogsStatusResponseSchema.parse({
      endpoints: [
        'GET /analyze/logs/targets',
        'GET /analyze/logs/status',
        'GET /analyze/logs/metadata',
        'POST /analyze/logs',
        'POST /analyze/logs/batch'
      ],
      limits: {
        maxHours: getLogCollectorLimits().maxHours,
        maxLinesRequest: ANALYZE_MAX_LINES_REQUEST,
        maxLinesEffectiveCap: getLogCollectorLimits().maxLinesCap,
        batchConcurrencyMin: BATCH_CONCURRENCY_MIN,
        batchConcurrencyMax: BATCH_CONCURRENCY_MAX
      },
      targets: {
        count: getAllowedLogFileTargets().length,
        items: getAllowedLogFileTargets()
      },
      llm: getOllamaRuntimeMetadata()
    });

    res.status(200).json({
      name: 'blackice-log-explainer',
      version: 1,
      description: 'Read-only log analysis service for OpenClaw integration',
      endpoints: {
        targets: {
          method: 'GET',
          path: '/analyze/logs/targets',
          responseSchema: LogExplainerJsonSchemas.analyzeLogsTargetsResponse
        },
        analyze: {
          method: 'POST',
          path: '/analyze/logs',
          requestSchema: {
            source: 'journalctl | docker | file',
            target: 'string',
            hours: 'number',
            maxLines: 'number'
          },
          responseSchema: LogExplainerJsonSchemas.analyzeLogsResponse
        },
        batch: {
          method: 'POST',
          path: '/analyze/logs/batch',
          requestSchema: {
            source: 'file',
            targets: 'string[] (optional)',
            hours: 'number (optional)',
            maxLines: 'number (optional)',
            concurrency: 'number (optional)'
          },
          responseSchema: LogExplainerJsonSchemas.analyzeLogsBatchResponse
        },
        status: {
          method: 'GET',
          path: '/analyze/logs/status'
        }
      },
      status,
      schemas: LogExplainerJsonSchemas
    });
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
          const okResult: AnalyzeLogsBatchResultOk = {
            target,
            ok: true,
            ...analyzed
          };
          return okResult;
        } catch (error: unknown) {
          const errorResult: AnalyzeLogsBatchResultError = {
            target,
            ok: false,
            error: errMessage(error),
            status: errStatus(error)
          };
          return errorResult;
        }
      });

      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      const bodyOut = AnalyzeLogsBatchResponseSchema.parse({
        source: 'file',
        requestedTargets: candidateTargets.length,
        analyzedTargets: results.length,
        ok,
        failed,
        results
      });
      res.status(200).json(bodyOut);
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

      const analyzed = AnalyzeLogsResponseSchema.parse(await analyzeOneRequest(parsed.data));
      res.status(200).json(analyzed);
    } catch (error: unknown) {
      const status = errStatus(error);
      const message = errMessage(error);

      log.error('log_explainer_failed', { status, message });
      res.status(status).json({ error: message });
    }
  });
}
