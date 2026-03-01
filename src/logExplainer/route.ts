import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import {
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsBatchResponseSchema,
  AnalyzeLogsRequestSchema,
  AnalyzeLogsResponseSchema,
  AnalyzeLogsTargetsResponseSchema,
  LogExplainerJsonSchemas,
  type AnalyzeLogsBatchResultError,
  type AnalyzeLogsBatchResultOk,
  type AnalyzeLogsRequest
} from './schema.js';
import {
  checkLokiHealth,
  collectLogs,
  collectLokiBatchLogs,
  getLokiSyntheticTargets
} from './logCollector.js';
import { analyzeLogsWithOllama } from './ollamaClient.js';
import { SYSTEM_PROMPT, buildUserPrompt, truncateLogs, type AnalyzePromptRequest } from './promptTemplates.js';
import { ensureReadOnlyAnalysisOutput, sanitizeReadOnlyAnalysisOutput } from './outputSafety.js';
import { errMessage, toHttpError } from '../http/errors.js';
import { getRequestId } from '../http/requestLogging.js';
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

async function analyzeOneRequest(request: AnalyzeLogsRequest): Promise<AnalysisResult> {
  const rawLogs = await collectLogs(request);

  const shouldAnalyze = request.analyze !== false && request.collectOnly !== true;

  if (!shouldAnalyze) {
    return { analysis: rawLogs };
  }

  return analyzeFromRawLogs(request, rawLogs);
}

async function analyzeFromRawLogs(request: AnalyzePromptRequest, rawLogs: string): Promise<AnalysisResult> {
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
    const targets = [...getLokiSyntheticTargets()];
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
            source: 'journalctl | journald | docker',
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
            source: 'journald | loki',
            targets: 'string[] (optional; journald units)',
            filters: 'record<string,string> (required when source=loki; selector labels)',
            contains: 'string (optional; source=loki line filter)',
            start: 'ISO-8601 datetime (optional; source=loki)',
            end: 'ISO-8601 datetime (optional; source=loki)',
            limit: 'number (optional; source=loki)',
            allowUnscoped: 'boolean (optional; source=loki)',
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

  app.post('/analyze/logs/batch', async (req: Request, res: Response) => {
    try {
      const body = parseBodyOrRespond(AnalyzeLogsBatchRequestSchema, req.body, res);
      if (!body) {
        return;
      }

      const source = body.source;

      if (source === 'loki') {
        if (typeof body.query === 'string' && body.query.trim().length > 0) {
          res.status(403).json({
            error: 'Raw Loki query is not allowed',
            details: 'Use filters so BlackIce can construct a validated selector internally'
          });
          return;
        }

        if ((body.selectors && body.selectors.length > 0) || (body.targets && body.targets.length > 0)) {
          res.status(403).json({
            error: 'Direct Loki selectors are not allowed',
            details: 'Use source=loki with filters instead of selectors[] or loki:{...} targets'
          });
          return;
        }

        if (!body.filters) {
          res.status(400).json({
            error: 'Missing Loki filters',
            details: 'Provide filters for source=loki'
          });
          return;
        }

        const lokiRequest = {
          source: 'loki' as const,
          filters: body.filters,
          contains: body.contains,
          start: body.start,
          end: body.end,
          limit: body.limit,
          allowUnscoped: body.allowUnscoped
        };
        let fallbackTarget = 'loki';
        let result: AnalyzeLogsBatchResultOk | AnalyzeLogsBatchResultError;
        try {
          const collected = await collectLokiBatchLogs(lokiRequest);
          fallbackTarget = collected.query;
          const shouldAnalyze = body.analyze !== false && body.collectOnly !== true;

          if (!shouldAnalyze) {
            result = {
              target: collected.query,
              ok: true,
              logs: collected.logs,
              message: collected.logs.trim() ? 'Logs collected' : 'No logs collected (collect-only mode)'
            };
          } else {
            const analysisRequest: AnalyzePromptRequest = {
              source: 'loki',
              target: collected.query,
              hours: collected.hours,
              maxLines: collected.limit,
              analyze: body.analyze,
              collectOnly: body.collectOnly
            };
            const analysisResult = await analyzeFromRawLogs(analysisRequest, collected.logs);
            result = {
              target: collected.query,
              ok: true,
              ...analysisResult
            };
          }
        } catch (error: unknown) {
          const httpError = toHttpError(error);
          result = {
            target: fallbackTarget,
            ok: false,
            error: httpError.message,
            status: httpError.status
          };
        }

        const bodyOut = AnalyzeLogsBatchResponseSchema.parse({
          source: 'loki',
          requestedTargets: 1,
          analyzedTargets: 1,
          ok: result.ok ? 1 : 0,
          failed: result.ok ? 0 : 1,
          results: [result]
        });
        res.status(200).json(bodyOut);
        return;
      }

      let candidateTargets: string[];
      let targets: string[];

      if (source === 'journald') {
        candidateTargets = body.targets && body.targets.length > 0 ? body.targets : ['all'];
        targets = candidateTargets;
      } else {
        res.status(400).json({
          error: `Unsupported source: ${source}`
        });
        return;
      }

      const results = await runConcurrent(targets, body.concurrency, async (target) => {
        const analysisRequest: AnalyzePromptRequest = {
          source: source === 'journald' ? 'journalctl' : source,
          target,
          hours: body.hours,
          maxLines: body.maxLines,
          analyze: body.analyze,
          collectOnly: body.collectOnly
        };

        const collectorRequest: AnalyzeLogsRequest = {
          ...analysisRequest,
          source: 'journalctl'
        };

        try {
          const rawLogs = await collectLogs(collectorRequest);

          const shouldAnalyze = analysisRequest.analyze !== false && analysisRequest.collectOnly !== true;

          if (!shouldAnalyze) {
            return {
              target,
              ok: true,
              logs: rawLogs,
              message: rawLogs.trim() ? 'Logs collected' : 'No logs collected (collect-only mode)'
            };
          }

          const analysisResult = await analyzeFromRawLogs(analysisRequest, rawLogs);

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
      log.error('log_explainer_batch_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message
      });
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
      log.error('log_explainer_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message
      });
      res.status(httpError.status).json({ error: httpError.message });
    }
  });
}
