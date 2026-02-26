import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import {
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsBatchResponseSchema,
  AnalyzeLogsIncrementalRequestSchema,
  AnalyzeLogsIncrementalResponseSchema,
  AnalyzeLogsRequestSchema,
  AnalyzeLogsResponseSchema,
  AnalyzeLogsTargetsResponseSchema,
  LogExplainerJsonSchemas,
  type AnalyzeLogsBatchResultError,
  type AnalyzeLogsBatchResultOk,
  type AnalyzeLogsIncrementalResponse,
  type AnalyzeLogsRequest
} from './schema.js';
import {
  checkLokiHealth,
  collectFileLogsIncremental,
  collectLogs,
  collectLokiLogs,
  getAllowedLogFileTargets,
  getLokiSyntheticTargets,
  validateAllowedLokiSelector
} from './logCollector.js';
import { analyzeLogsWithOllama } from './ollamaClient.js';
import { SYSTEM_PROMPT, buildUserPrompt, truncateLogs } from './promptTemplates.js';
import { ensureReadOnlyAnalysisOutput, sanitizeReadOnlyAnalysisOutput } from './outputSafety.js';
import { errMessage, toHttpError } from '../http/errors.js';
import { parseBodyOrRespond } from '../http/validation.js';
import { buildLogExplainerStatus } from './status.js';

type AnalysisResult = {
  analysis: string;
  no_logs?: boolean;
  message?: string;
  safety?: {
    redacted: boolean;
    reasons: string[];
  };
};

function extractSelectorFromLokiTarget(target: string): string {
  if (!target.startsWith('loki:')) {
    throw Object.assign(new Error(`invalid loki target: ${target}`), { status: 400 });
  }

  const selector = target.slice('loki:'.length).trim();
  if (!selector) {
    throw Object.assign(new Error('loki target selector cannot be empty'), { status: 400 });
  }

  return selector;
}

async function analyzeOneRequest(request: AnalyzeLogsRequest): Promise<AnalysisResult> {
  const rawLogs = await collectLogs(request);

  const shouldAnalyze = request.analyze !== false && request.collectOnly !== true;

  if (!shouldAnalyze) {
    return { analysis: rawLogs };
  }

  return analyzeFromRawLogs(request, rawLogs);
}

async function analyzeFromRawLogs(request: AnalyzeLogsRequest, rawLogs: string): Promise<AnalysisResult> {
  if (!rawLogs.trim()) {
    return {
      analysis: '',
      no_logs: true,
      message: 'No logs were collected for the given query'
    };
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
    const targets = [...getAllowedLogFileTargets(), ...getLokiSyntheticTargets()];
    const body = AnalyzeLogsTargetsResponseSchema.parse({ targets });
    res.status(200).json(body);
  });

  app.get('/health/loki', async (_req: Request, res: Response) => {
    const health = await checkLokiHealth();
    res.status(health.ok ? 200 : health.status).json(health);
  });

  app.get('/analyze/logs/status', (_req: Request, res: Response) => {
    res.status(200).json(buildLogExplainerStatus());
  });

  app.get('/analyze/logs/metadata', (_req: Request, res: Response) => {
    const status = buildLogExplainerStatus();

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
            source: 'journalctl | journald | docker | file',
            target: 'string',
            hours: 'number',
            maxLines: 'number'
          },
          responseSchema: LogExplainerJsonSchemas.analyzeLogsResponse
        },
        incremental: {
          method: 'POST',
          path: '/analyze/logs/incremental',
          requestSchema: {
            source: 'file',
            target: 'string',
            cursor: 'number (optional)',
            hours: 'number (optional)',
            maxLines: 'number (optional)'
          },
          responseSchema: LogExplainerJsonSchemas.analyzeLogsIncrementalResponse
        },
        batch: {
          method: 'POST',
          path: '/analyze/logs/batch',
          requestSchema: {
            source: 'file | journald | loki',
            targets: 'string[] (optional; file paths, journald units, or synthetic loki:{...} targets)',
            selectors: 'string[] (optional; direct Loki selectors when source=loki)',
            hours: 'number (optional)',
            sinceMinutes: 'number (optional; overrides hours for source=loki)',
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

  app.post('/analyze/logs/incremental', async (req: Request, res: Response) => {
    try {
      const body = parseBodyOrRespond(AnalyzeLogsIncrementalRequestSchema, req.body, res);
      if (!body) {
        return;
      }

      const collected = await collectFileLogsIncremental({
        target: body.target,
        cursor: body.cursor,
        maxLines: body.maxLines
      });

      if (!collected.logs.trim()) {
        const noLogsOut: AnalyzeLogsIncrementalResponse = {
          source: 'file',
          target: body.target,
          cursor: body.cursor,
          fromCursor: collected.fromCursor,
          nextCursor: collected.nextCursor,
          rotated: collected.rotated,
          truncatedByBytes: collected.truncatedByBytes,
          noNewLogs: true
        };
        res.status(200).json(AnalyzeLogsIncrementalResponseSchema.parse(noLogsOut));
        return;
      }

      const analyzed = await analyzeFromRawLogs(
        {
          source: 'file',
          target: body.target,
          hours: body.hours,
          maxLines: body.maxLines
        },
        collected.logs
      );

      const bodyOut: AnalyzeLogsIncrementalResponse = {
        source: 'file',
        target: body.target,
        cursor: body.cursor,
        fromCursor: collected.fromCursor,
        nextCursor: collected.nextCursor,
        rotated: collected.rotated,
        truncatedByBytes: collected.truncatedByBytes,
        noNewLogs: false,
        ...analyzed
      };
      res.status(200).json(AnalyzeLogsIncrementalResponseSchema.parse(bodyOut));
    } catch (error: unknown) {
      const httpError = toHttpError(error);
      log.error('log_explainer_incremental_failed', { status: httpError.status, message: httpError.message });
      res.status(httpError.status).json({ error: httpError.message });
    }
  });

  app.post('/analyze/logs/batch', async (req: Request, res: Response) => {
    try {
      const body = parseBodyOrRespond(AnalyzeLogsBatchRequestSchema, req.body, res);
      if (!body) {
        return;
      }

      const source = body.source;

      let candidateTargets: string[];
      let targets: string[];

      if (source === 'file') {
        const allowedTargets = getAllowedLogFileTargets();
        const allowedSet = new Set(allowedTargets);
        candidateTargets = body.targets && body.targets.length > 0 ? body.targets : allowedTargets;
        targets = candidateTargets.filter((target) => allowedSet.has(target));

        if (targets.length === 0) {
          res.status(400).json({
            error: 'No valid targets to analyze',
            details: 'Provide targets listed in GET /analyze/logs/targets'
          });
          return;
        }
      } else if (source === 'journald') {
        candidateTargets = body.targets && body.targets.length > 0 ? body.targets : ['all'];
        targets = candidateTargets;
      } else {
        const selectorInputs = body.selectors && body.selectors.length > 0
          ? body.selectors
          : (body.targets && body.targets.length > 0
            ? body.targets.map((target) => extractSelectorFromLokiTarget(target))
            : []);

        if (selectorInputs.length === 0) {
          res.status(400).json({
            error: 'No Loki selectors provided',
            details: 'Provide selectors[] or loki:{...} entries in targets[]'
          });
          return;
        }

        candidateTargets = selectorInputs;
        targets = selectorInputs.map((selector) => validateAllowedLokiSelector(selector));
      }

      const results = await runConcurrent(targets, body.concurrency, async (target) => {
        const request: AnalyzeLogsRequest = {
          source: source === 'journald' ? 'journalctl' : 'file',
          target,
          hours: body.hours,
          maxLines: body.maxLines,
          analyze: body.analyze,
          collectOnly: body.collectOnly
        };

        try {
          const rawLogs = source === 'loki'
            ? await collectLokiLogs({
                selector: target,
                hours: body.hours,
                sinceMinutes: body.sinceMinutes,
                maxLines: body.maxLines
              })
            : await collectLogs(request);

          const shouldAnalyze = request.analyze !== false && request.collectOnly !== true;

          if (!shouldAnalyze) {
            return {
              target,
              ok: true,
              logs: rawLogs,
              message: rawLogs.trim() ? 'Logs collected' : 'No logs collected (collect-only mode)'
            };
          }

          const analysisResult = await analyzeFromRawLogs(request, rawLogs);

          if ('no_logs' in analysisResult && analysisResult.no_logs) {
            return {
              target,
              ok: true,
              no_logs: true,
              message: analysisResult.message
            };
          }

          return {
            target,
            ok: true,
            ...analysisResult
          } as AnalyzeLogsBatchResultOk;
        } catch (error: unknown) {
          const httpError = toHttpError(error);
          const errorResult: AnalyzeLogsBatchResultError = {
            target,
            ok: false,
            error: httpError.message,
            status: httpError.status
          };
          return errorResult;
        }
      });

      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;

      const bodyOut = AnalyzeLogsBatchResponseSchema.parse({
        source,
        requestedTargets: candidateTargets.length,
        analyzedTargets: results.length,
        ok,
        failed,
        results
      });
      res.status(200).json(bodyOut);
    } catch (error: unknown) {
      const httpError = toHttpError(error);
      log.error('log_explainer_batch_failed', { status: httpError.status, message: httpError.message });
      res.status(httpError.status).json({ error: httpError.message });
    }
  });

  app.post('/analyze/logs', async (req: Request, res: Response) => {
    try {
      const body = parseBodyOrRespond(AnalyzeLogsRequestSchema, req.body, res);
      if (!body) {
        return;
      }

      const analyzed = await analyzeOneRequest(body);
      res.status(200).json(AnalyzeLogsResponseSchema.parse(analyzed));
    } catch (error: unknown) {
      const httpError = toHttpError(error);
      log.error('log_explainer_failed', { status: httpError.status, message: httpError.message });
      res.status(httpError.status).json({ error: httpError.message });
    }
  });
}
