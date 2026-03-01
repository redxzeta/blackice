import { type Request, type Response, type Express } from 'express';
import { log } from '../log.js';
import {
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsBatchResponseSchema,
  BATCH_EVIDENCE_LINES_DEFAULT,
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
  collectLokiBatchLogs,
  collectLokiLogs,
  getAllowedLogFileTargets,
  getLokiSyntheticTargets,
  validateAllowedLokiSelector
} from './logCollector.js';
import { analyzeLogsWithOllama } from './ollamaClient.js';
import { SYSTEM_PROMPT, buildUserPrompt, truncateLogs, type AnalyzePromptRequest } from './promptTemplates.js';
import {
  ensureReadOnlyAnalysisOutput,
  sanitizeReadOnlyAnalysisOutput,
  sanitizeReadOnlyEvidenceLine
} from './outputSafety.js';
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

type BatchMode = 'analyze' | 'raw' | 'both';
type EvidenceLine = { ts: string; line: string };

function resolveBatchMode(input: { mode?: BatchMode; analyze?: boolean; collectOnly?: boolean }): BatchMode {
  if (input.mode) {
    return input.mode;
  }
  if (input.collectOnly === true || input.analyze === false) {
    return 'raw';
  }
  return 'analyze';
}

function buildEvidence(rawLogs: string, requestedLines?: number): EvidenceLine[] {
  const lines = rawLogs
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-Math.max(1, requestedLines ?? BATCH_EVIDENCE_LINES_DEFAULT));

  return lines.map((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
    if (match) {
      return { ts: match[1], line: sanitizeReadOnlyEvidenceLine(match[2]) };
    }
    return { ts: '', line: sanitizeReadOnlyEvidenceLine(line) };
  });
}

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
            query: 'string (optional; raw LogQL for source=loki)',
            filters: 'record<string,string> (optional; source=loki selector labels)',
            contains: 'string (optional; source=loki line filter)',
            start: 'ISO-8601 datetime (optional; source=loki)',
            end: 'ISO-8601 datetime (optional; source=loki)',
            limit: 'number (optional; source=loki)',
            allowUnscoped: 'boolean (optional; source=loki)',
            hours: 'number (optional)',
            sinceMinutes: 'number (optional; overrides hours for source=loki)',
            maxLines: 'number (optional)',
            concurrency: 'number (optional)',
            mode: 'analyze | raw | both (optional; default analyze)',
            evidenceLines: 'number (optional; default 10, max 50)'
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
      log.error('log_explainer_incremental_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message
      });
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
      const mode = resolveBatchMode({
        mode: body.mode,
        analyze: body.analyze,
        collectOnly: body.collectOnly
      });

      if (
        source === 'loki' &&
        ((typeof body.query === 'string' && body.query.trim().length > 0) || body.filters !== undefined)
      ) {
        const lokiRequest = {
          source: 'loki' as const,
          query: body.query,
          filters: body.filters,
          contains: body.contains,
          start: body.start,
          end: body.end,
          limit: body.limit,
          allowUnscoped: body.allowUnscoped
        };
        let fallbackTarget = 'loki';
        if (typeof body.query === 'string' && body.query.trim().length > 0) {
          fallbackTarget = body.query.trim();
        }
        let result: AnalyzeLogsBatchResultOk | AnalyzeLogsBatchResultError;
        try {
          const collected = await collectLokiBatchLogs(lokiRequest);
          fallbackTarget = collected.query;
          const evidence = buildEvidence(collected.logs, body.evidenceLines);

          if (mode === 'raw') {
            result = {
              target: collected.query,
              ok: true,
              evidence,
              message: collected.logs.trim() ? 'Logs collected (raw mode)' : 'No logs collected (raw mode)'
            };
          } else if (mode === 'both') {
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
              evidence,
              ...analysisResult
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
          source: source === 'journald' ? 'journalctl' : 'file'
        };

        try {
          const rawLogs = source === 'loki'
            ? await collectLokiLogs({
                selector: target,
                hours: body.hours,
                sinceMinutes: body.sinceMinutes,
                maxLines: body.maxLines
              })
            : await collectLogs(collectorRequest);

          const evidence = buildEvidence(rawLogs, body.evidenceLines);

          if (mode === 'raw') {
            return {
              target,
              ok: true,
              evidence,
              message: rawLogs.trim() ? 'Logs collected (raw mode)' : 'No logs collected (raw mode)'
            };
          }

          const analysisResult = await analyzeFromRawLogs(analysisRequest, rawLogs);

          if ('no_logs' in analysisResult && analysisResult.no_logs) {
            return {
              target,
              ok: true,
              evidence: mode === 'both' ? evidence : undefined,
              no_logs: true,
              message: analysisResult.message
            };
          }

          return {
            target,
            ok: true,
            evidence: mode === 'both' ? evidence : undefined,
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
