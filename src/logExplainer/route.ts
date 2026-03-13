import type { Request, Response, Express } from 'express'
import { log } from '../log.js'
import {
  BATCH_EVIDENCE_LINES_DEFAULT,
  BATCH_EVIDENCE_LINES_MAX,
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsBatchResponseSchema,
  AnalyzeLogsRequestSchema,
  AnalyzeLogsResponseSchema,
  AnalyzeLogsTargetsResponseSchema,
  LogExplainerJsonSchemas,
  type AnalyzeLogsBatchResultError,
  type AnalyzeLogsBatchResultOk,
  type AnalyzeLogsRequest,
} from './schema.js'
import {
  checkLokiHealth,
  collectLogs,
  collectLokiBatchLogs,
  ensureLokiRulesConfigured,
  getLokiSyntheticTargets,
} from './logCollector.js'
import { analyzeLogsWithOllama } from './ollamaClient.js'
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  truncateLogs,
  type AnalyzePromptRequest,
} from './promptTemplates.js'
import {
  ensureReadOnlyAnalysisOutput,
  sanitizeReadOnlyAnalysisOutput,
  sanitizeReadOnlyEvidenceLine,
} from './outputSafety.js'
import { errMessage, toHttpError } from '../http/errors.js'
import { getRequestId } from '../http/requestLogging.js'
import { parseBodyOrRespond } from '../http/validation.js'
import { buildLogExplainerStatus, LOG_EXPLAINER_ENDPOINTS } from './status.js'
import { resolveSafetyIdentifier } from '../ai/safetyIdentifier.js'

type AnalysisResult = {
  analysis: string
  no_logs?: boolean
  message?: string
  safety?: {
    redacted: boolean
    reasons: string[]
  }
}

type BatchMode = 'analyze' | 'raw' | 'both'
type EvidenceLine = {
  ts: string
  line: string
}

const ISO_OR_SHORT_TS_PREFIX = /^(\d{4}-\d{2}-\d{2}[ T][^\s]+)\s+(.*)$/
const LOKI_NS_TS_PREFIX = /^(\d{16,20})\s+(.*)$/
const MAX_EVIDENCE_LINE_CHARS = 2_000
const RATE_LIMIT_RESPONSE_TYPE = 'rate_limit_exceeded'
const RATE_LIMIT_POLICIES: Record<'analyze' | 'batch', RateLimitPolicy> = {
  analyze: {
    key: 'analyze',
    path: '/analyze/logs',
    maxRequests: 5,
    windowMs: 60_000,
  },
  batch: {
    key: 'batch',
    path: '/analyze/logs/batch',
    maxRequests: 2,
    windowMs: 60_000,
  },
}
const rateLimitBuckets = new Map<string, RateLimitBucket>()

function clampEvidenceLine(line: string): string {
  if (line.length <= MAX_EVIDENCE_LINE_CHARS) {
    return line
  }
  return `${line.slice(0, MAX_EVIDENCE_LINE_CHARS)} [truncated]`
}

function parseEvidenceLine(rawLine: string): EvidenceLine {
  const trimmed = rawLine.trim()

  const isoMatch = trimmed.match(ISO_OR_SHORT_TS_PREFIX)
  if (isoMatch) {
    return {
      ts: isoMatch[1],
      line: clampEvidenceLine(sanitizeReadOnlyEvidenceLine(isoMatch[2])),
    }
  }

  const lokiMatch = trimmed.match(LOKI_NS_TS_PREFIX)
  if (lokiMatch) {
    return {
      ts: lokiMatch[1],
      line: clampEvidenceLine(sanitizeReadOnlyEvidenceLine(lokiMatch[2])),
    }
  }

  return {
    ts: '',
    line: clampEvidenceLine(sanitizeReadOnlyEvidenceLine(trimmed)),
  }
}

function buildEvidence(
  rawLogs: string,
  requestedLines: number | undefined
): EvidenceLine[] | undefined {
  if (requestedLines === undefined) {
    return undefined
  }

  const boundedCount = Math.max(1, Math.min(requestedLines, BATCH_EVIDENCE_LINES_MAX))
  const lines = rawLogs
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  const sampled = lines.slice(-boundedCount)
  return sampled.map((line) => parseEvidenceLine(line))
}

function resolveBatchMode(input: { mode?: BatchMode; analyze?: boolean; collectOnly?: boolean }): {
  mode: BatchMode
  legacyCollectOnly: boolean
} {
  if (input.mode) {
    return {
      mode: input.mode,
      legacyCollectOnly: false,
    }
  }

  if (input.collectOnly === true || input.analyze === false) {
    return {
      mode: 'raw',
      legacyCollectOnly: true,
    }
  }

  return {
    mode: 'analyze',
    legacyCollectOnly: false,
  }
}

function resolveEvidenceLinesForMode(
  mode: BatchMode,
  requested: number | undefined
): number | undefined {
  if (mode === 'analyze') {
    return undefined
  }
  return requested ?? BATCH_EVIDENCE_LINES_DEFAULT
}

function getRateLimitClientKey(req: Request): string {
  const forwardedFor = req.header('x-forwarded-for')
  if (typeof forwardedFor === 'string') {
    const first = forwardedFor
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.length > 0)
    if (first) {
      return first
    }
  }

  if (typeof req.ip === 'string' && req.ip.length > 0) {
    return req.ip
  }

  return 'unknown'
}

function enforceLogAnalysisRateLimit(
  req: Request,
  res: Response,
  policy: RateLimitPolicy
): boolean {
  const now = Date.now()
  const clientKey = getRateLimitClientKey(req)
  const bucketKey = `${policy.key}:${clientKey}`
  const existing = rateLimitBuckets.get(bucketKey)
  const windowStartedAt =
    existing && now - existing.windowStartedAt < policy.windowMs ? existing.windowStartedAt : now
  const hits =
    existing && now - existing.windowStartedAt < policy.windowMs ? existing.hits + 1 : 1

  rateLimitBuckets.set(bucketKey, {
    windowStartedAt,
    hits,
  })

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStartedAt + policy.windowMs - now) / 1000)
  )
  const remaining = Math.max(0, policy.maxRequests - hits)

  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('X-RateLimit-Limit', String(policy.maxRequests))
  res.setHeader('X-RateLimit-Remaining', String(remaining))
  res.setHeader('X-RateLimit-Reset', String(windowStartedAt + policy.windowMs))

  if (hits <= policy.maxRequests) {
    return true
  }

  const requestId = getRequestId(res)
  log.info('log_explainer_rate_limit_hit', {
    request_id: requestId,
    path: policy.path,
    client: clientKey,
    limit: policy.maxRequests,
    window_ms: policy.windowMs,
    retry_after_seconds: retryAfterSeconds,
  })

  res.status(429).json({
    error: 'Rate limit exceeded',
    type: RATE_LIMIT_RESPONSE_TYPE,
    path: policy.path,
    retryAfterSeconds,
  })
  return false
}

type AnalysisContext = {
  requestId?: string
  safetyIdentifier?: string
}

type RateLimitBucket = {
  windowStartedAt: number
  hits: number
}

type RateLimitPolicy = {
  key: 'analyze' | 'batch'
  path: '/analyze/logs' | '/analyze/logs/batch'
  maxRequests: number
  windowMs: number
}

type LogExplainerMetadataEndpoint = {
  method: 'GET' | 'POST'
  path: string
  requestSchema?: Record<string, string>
  responseSchema?: unknown
}

function buildMetadataEndpoints(): Record<string, LogExplainerMetadataEndpoint> {
  const endpointEntries: Array<[string, LogExplainerMetadataEndpoint]> =
    LOG_EXPLAINER_ENDPOINTS.map((endpoint) => {
      switch (endpoint) {
        case 'GET /analyze/logs/targets':
          return [
            'targets',
            {
              method: 'GET',
              path: '/analyze/logs/targets',
              responseSchema: LogExplainerJsonSchemas.analyzeLogsTargetsResponse,
            },
          ]
        case 'POST /analyze/logs':
          return [
            'analyze',
            {
              method: 'POST',
              path: '/analyze/logs',
              requestSchema: {
                source: 'journalctl | journald | docker',
                target: 'string',
                hours: 'number',
                maxLines: 'number',
              },
              responseSchema: LogExplainerJsonSchemas.analyzeLogsResponse,
            },
          ]
        case 'POST /analyze/logs/batch':
          return [
            'batch',
            {
              method: 'POST',
              path: '/analyze/logs/batch',
              requestSchema: {
                source: 'journald | loki',
                targets: 'string[] (optional; journald units)',
                filters: 'record<string,string> (required when source=loki; selector labels)',
                contains: 'string (optional; source=loki line filter)',
                regex: 'string (optional; source=loki regex line filter)',
                start: 'ISO-8601 datetime (optional; source=loki)',
                end: 'ISO-8601 datetime (optional; source=loki)',
                sinceSeconds: 'number (optional; source=loki relative time window)',
                limit: 'number (optional; source=loki)',
                allowUnscoped: 'boolean (optional; source=loki)',
                hours: 'number (optional)',
                sinceMinutes: 'number (optional; overrides hours for source=loki)',
                maxLines: 'number (optional)',
                mode: 'analyze | raw | both (optional; default analyze)',
                evidenceLines:
                  'number (optional; max 50; includes evidence excerpts per success result)',
                concurrency: 'number (optional)',
              },
              responseSchema: LogExplainerJsonSchemas.analyzeLogsBatchResponse,
            },
          ]
        case 'GET /analyze/logs/status':
          return [
            'status',
            {
              method: 'GET',
              path: '/analyze/logs/status',
            },
          ]
        case 'GET /analyze/logs/metadata':
          return [
            'metadata',
            {
              method: 'GET',
              path: '/analyze/logs/metadata',
            },
          ]
        case 'GET /health/loki':
          return [
            'healthLoki',
            {
              method: 'GET',
              path: '/health/loki',
            },
          ]
      }
    })

  return Object.fromEntries(endpointEntries)
}

async function analyzeOneRequest(
  request: AnalyzeLogsRequest,
  ctx: AnalysisContext
): Promise<AnalysisResult> {
  const rawLogs = await collectLogs(request)

  const shouldAnalyze = request.analyze !== false && request.collectOnly !== true

  if (!shouldAnalyze) {
    return { analysis: rawLogs }
  }

  return analyzeFromRawLogs(request, rawLogs, ctx)
}

async function analyzeFromRawLogs(
  request: AnalyzePromptRequest,
  rawLogs: string,
  ctx: AnalysisContext
): Promise<AnalysisResult> {
  if (!rawLogs.trim()) {
    return {
      analysis: '',
      no_logs: true,
      message: 'No logs were collected for the given query',
    }
  }

  const { text: logs, truncated } = truncateLogs(rawLogs)
  const userPrompt = buildUserPrompt({ ...request, logs, truncated })
  const analysis = await analyzeLogsWithOllama({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    requestId: ctx.requestId,
    safetyIdentifier: ctx.safetyIdentifier,
  })

  const safety = ensureReadOnlyAnalysisOutput(analysis)
  if (!safety.safe) {
    const sanitized = sanitizeReadOnlyAnalysisOutput(analysis)

    log.info('log_explainer_output_redacted', {
      reason: safety.reason,
      redacted: sanitized.redacted,
      reasons: sanitized.reasons,
    })

    return {
      analysis: sanitized.analysis,
      safety: {
        redacted: sanitized.redacted,
        reasons: sanitized.reasons,
      },
    }
  }

  return { analysis }
}

async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index
      index += 1

      if (current >= items.length) {
        break
      }

      results[current] = await worker(items[current])
    }
  })

  await Promise.all(runners)
  return results
}

export function registerLogExplainerRoutes(app: Express): void {
  app.get('/analyze/logs/targets', (_req: Request, res: Response) => {
    try {
      ensureLokiRulesConfigured()
      const targets = [...getLokiSyntheticTargets()]
      const body = AnalyzeLogsTargetsResponseSchema.parse({ targets })
      res.status(200).json(body)
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      res.status(httpError.status).json({ error: httpError.message })
    }
  })

  app.get('/health/loki', async (_req: Request, res: Response) => {
    const health = await checkLokiHealth()
    res.status(health.ok ? 200 : health.status).json(health)
  })

  app.get('/analyze/logs/status', (_req: Request, res: Response) => {
    res.status(200).json(buildLogExplainerStatus())
  })

  app.get('/analyze/logs/metadata', (_req: Request, res: Response) => {
    const status = buildLogExplainerStatus()

    res.status(200).json({
      name: 'blackice-log-explainer',
      version: 1,
      description: 'Read-only log analysis service for OpenClaw integration',
      endpoints: buildMetadataEndpoints(),
      status,
      schemas: LogExplainerJsonSchemas,
    })
  })

  app.post('/analyze/logs/batch', async (req: Request, res: Response) => {
    try {
      if (!enforceLogAnalysisRateLimit(req, res, RATE_LIMIT_POLICIES.batch)) {
        return
      }

      const requestId = getRequestId(res)
      const safetyIdentifier = resolveSafetyIdentifier({
        request: req,
        explicitUser: undefined,
        requestId,
      })
      const body = parseBodyOrRespond(AnalyzeLogsBatchRequestSchema, req.body, res)
      if (!body) {
        return
      }

      const source = body.source
      const modeInfo = resolveBatchMode({
        mode: body.mode,
        analyze: body.analyze,
        collectOnly: body.collectOnly,
      })
      const mode = modeInfo.mode

      if (source === 'loki') {
        if (typeof body.query === 'string' && body.query.trim().length > 0) {
          res.status(403).json({
            error: 'Raw Loki query is not allowed',
            details: 'Use filters so BlackIce can construct a validated selector internally',
          })
          return
        }

        if (
          (body.selectors && body.selectors.length > 0) ||
          (body.targets && body.targets.length > 0)
        ) {
          res.status(403).json({
            error: 'Direct Loki selectors are not allowed',
            details: 'Use source=loki with filters instead of selectors[] or loki:{...} targets',
          })
          return
        }

        if (!body.filters) {
          res.status(400).json({
            error: 'Missing Loki filters',
            details: 'Provide filters for source=loki',
          })
          return
        }

        const lokiRequest = {
          source: 'loki' as const,
          filters: body.filters,
          contains: body.contains,
          regex: body.regex,
          start: body.start,
          end: body.end,
          sinceSeconds: body.sinceSeconds,
          limit: body.limit,
          allowUnscoped: body.allowUnscoped,
        }
        let fallbackTarget = 'loki'
        let result: AnalyzeLogsBatchResultOk | AnalyzeLogsBatchResultError
        try {
          const collected = await collectLokiBatchLogs(lokiRequest)
          fallbackTarget = collected.query
          const evidence = buildEvidence(
            collected.logs,
            resolveEvidenceLinesForMode(mode, body.evidenceLines)
          )

          if (mode === 'raw') {
            result = {
              target: collected.query,
              ok: true,
              ...(modeInfo.legacyCollectOnly ? { logs: collected.logs } : {}),
              evidence,
              message: collected.logs.trim()
                ? 'Logs collected (raw mode)'
                : 'No logs collected (raw mode)',
            }
          } else if (mode === 'both') {
            const analysisRequest: AnalyzePromptRequest = {
              source: 'loki',
              target: collected.query,
              hours: collected.hours,
              maxLines: collected.limit,
              analyze: body.analyze,
              collectOnly: body.collectOnly,
            }
            const analysisResult = await analyzeFromRawLogs(analysisRequest, collected.logs, {
              requestId,
              safetyIdentifier,
            })
            result = {
              target: collected.query,
              ok: true,
              evidence,
              ...analysisResult,
            }
          } else {
            const analysisRequest: AnalyzePromptRequest = {
              source: 'loki',
              target: collected.query,
              hours: collected.hours,
              maxLines: collected.limit,
              analyze: body.analyze,
              collectOnly: body.collectOnly,
            }
            const analysisResult = await analyzeFromRawLogs(analysisRequest, collected.logs, {
              requestId,
              safetyIdentifier,
            })
            result = {
              target: collected.query,
              ok: true,
              ...analysisResult,
            }
          }
        } catch (error: unknown) {
          const httpError = toHttpError(error)
          result = {
            target: fallbackTarget,
            ok: false,
            error: httpError.message,
            status: httpError.status,
          }
        }

        const bodyOut = AnalyzeLogsBatchResponseSchema.parse({
          source: 'loki',
          requestedTargets: 1,
          analyzedTargets: 1,
          ok: result.ok ? 1 : 0,
          failed: result.ok ? 0 : 1,
          results: [result],
        })
        res.status(200).json(bodyOut)
        return
      }

      let candidateTargets: string[]
      let targets: string[]

      if (source === 'journald') {
        candidateTargets = body.targets && body.targets.length > 0 ? body.targets : ['all']
        targets = candidateTargets
      } else {
        res.status(400).json({
          error: `Unsupported source: ${source}`,
        })
        return
      }

      const results = await runConcurrent(targets, body.concurrency, async (target) => {
        const analysisRequest: AnalyzePromptRequest = {
          source: source === 'journald' ? 'journalctl' : source,
          target,
          hours: body.hours,
          maxLines: body.maxLines,
          analyze: body.analyze,
          collectOnly: body.collectOnly,
        }

        const collectorRequest: AnalyzeLogsRequest = {
          ...analysisRequest,
          source: 'journalctl',
        }

        try {
          const rawLogs = await collectLogs(collectorRequest)
          const evidence = buildEvidence(
            rawLogs,
            resolveEvidenceLinesForMode(mode, body.evidenceLines)
          )

          if (mode === 'raw') {
            return {
              target,
              ok: true,
              ...(modeInfo.legacyCollectOnly ? { logs: rawLogs } : {}),
              evidence,
              message: rawLogs.trim()
                ? 'Logs collected (raw mode)'
                : 'No logs collected (raw mode)',
            }
          }

          const analysisResult = await analyzeFromRawLogs(analysisRequest, rawLogs, {
            requestId,
            safetyIdentifier,
          })

          if ('no_logs' in analysisResult && analysisResult.no_logs) {
            return {
              target,
              ok: true,
              no_logs: true,
              ...(mode === 'both' ? { evidence } : {}),
              message: analysisResult.message,
            }
          }

          if (mode === 'both') {
            return {
              target,
              ok: true,
              evidence,
              ...analysisResult,
            } as AnalyzeLogsBatchResultOk
          }

          return {
            target,
            ok: true,
            ...analysisResult,
          } as AnalyzeLogsBatchResultOk
        } catch (error: unknown) {
          const httpError = toHttpError(error)
          const errorResult: AnalyzeLogsBatchResultError = {
            target,
            ok: false,
            error: httpError.message,
            status: httpError.status,
          }
          return errorResult
        }
      })

      const ok = results.filter((r) => r.ok).length
      const failed = results.length - ok

      const bodyOut = AnalyzeLogsBatchResponseSchema.parse({
        source,
        requestedTargets: candidateTargets.length,
        analyzedTargets: results.length,
        ok,
        failed,
        results,
      })
      res.status(200).json(bodyOut)
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      log.error('log_explainer_batch_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message,
      })
      res.status(httpError.status).json({ error: httpError.message })
    }
  })

  app.post('/analyze/logs', async (req: Request, res: Response) => {
    try {
      if (!enforceLogAnalysisRateLimit(req, res, RATE_LIMIT_POLICIES.analyze)) {
        return
      }

      const requestId = getRequestId(res)
      const safetyIdentifier = resolveSafetyIdentifier({
        request: req,
        explicitUser: undefined,
        requestId,
      })
      const body = parseBodyOrRespond(AnalyzeLogsRequestSchema, req.body, res)
      if (!body) {
        return
      }

      const analyzed = await analyzeOneRequest(body, {
        requestId,
        safetyIdentifier,
      })
      res.status(200).json(AnalyzeLogsResponseSchema.parse(analyzed))
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      log.error('log_explainer_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message,
      })
      res.status(httpError.status).json({ error: httpError.message })
    }
  })
}
