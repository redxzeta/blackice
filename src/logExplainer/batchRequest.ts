import { toHttpError } from '../http/errors.js'
import { analyzeFromRawLogs, type AnalysisContext } from './analysis.js'
import { buildEvidence, resolveBatchMode, resolveEvidenceLinesForMode } from './evidence.js'
import { collectLogs, collectLokiBatchLogs } from './logCollector.js'
import type { AnalyzePromptRequest } from './promptTemplates.js'
import {
  AnalyzeLogsBatchResponseSchema,
  type AnalyzeLogsBatchRequest,
  type AnalyzeLogsBatchResponse,
  type AnalyzeLogsBatchResultError,
  type AnalyzeLogsBatchResultOk,
  type AnalyzeLogsRequest,
} from './schema.js'

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

function validateLokiRequestBody(body: AnalyzeLogsBatchRequest): void {
  if (typeof body.query === 'string' && body.query.trim().length > 0) {
    throw Object.assign(new Error('Raw Loki query is not allowed'), {
      status: 403,
      details: 'Use filters so BlackIce can construct a validated selector internally',
    })
  }

  if ((body.selectors && body.selectors.length > 0) || (body.targets && body.targets.length > 0)) {
    throw Object.assign(new Error('Direct Loki selectors are not allowed'), {
      status: 403,
      details: 'Use source=loki with filters instead of selectors[] or loki:{...} targets',
    })
  }

  if (!body.filters) {
    throw Object.assign(new Error('Missing Loki filters'), {
      status: 400,
      details: 'Provide filters for source=loki',
    })
  }
}

async function executeLokiBatch(
  body: AnalyzeLogsBatchRequest,
  ctx: AnalysisContext
): Promise<AnalyzeLogsBatchResponse> {
  validateLokiRequestBody(body)

  const modeInfo = resolveBatchMode({
    mode: body.mode,
    analyze: body.analyze,
    collectOnly: body.collectOnly,
  })
  const mode = modeInfo.mode
  let fallbackTarget = 'loki'
  let result: AnalyzeLogsBatchResultOk | AnalyzeLogsBatchResultError

  try {
    const collected = await collectLokiBatchLogs({
      source: 'loki',
      filters: body.filters,
      contains: body.contains,
      regex: body.regex,
      start: body.start,
      end: body.end,
      sinceSeconds: body.sinceSeconds,
      limit: body.limit,
      allowUnscoped: body.allowUnscoped,
    })
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
    } else {
      const analysisResult = await analyzeFromRawLogs(
        {
          source: 'loki',
          target: collected.query,
          hours: collected.hours,
          maxLines: collected.limit,
          analyze: body.analyze,
          collectOnly: body.collectOnly,
        },
        collected.logs,
        ctx
      )
      result =
        mode === 'both'
          ? {
              target: collected.query,
              ok: true,
              evidence,
              ...analysisResult,
            }
          : {
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

  return AnalyzeLogsBatchResponseSchema.parse({
    source: 'loki',
    requestedTargets: 1,
    analyzedTargets: 1,
    ok: result.ok ? 1 : 0,
    failed: result.ok ? 0 : 1,
    results: [result],
  })
}

async function executeJournaldTarget(
  body: AnalyzeLogsBatchRequest,
  target: string,
  modeInfo: ReturnType<typeof resolveBatchMode>,
  ctx: AnalysisContext
): Promise<AnalyzeLogsBatchResultOk | AnalyzeLogsBatchResultError> {
  const analysisRequest: AnalyzePromptRequest = {
    source: 'journalctl',
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
      resolveEvidenceLinesForMode(modeInfo.mode, body.evidenceLines)
    )

    if (modeInfo.mode === 'raw') {
      return {
        target,
        ok: true,
        ...(modeInfo.legacyCollectOnly ? { logs: rawLogs } : {}),
        evidence,
        message: rawLogs.trim() ? 'Logs collected (raw mode)' : 'No logs collected (raw mode)',
      }
    }

    const analysisResult = await analyzeFromRawLogs(analysisRequest, rawLogs, ctx)
    if ('no_logs' in analysisResult && analysisResult.no_logs) {
      return {
        target,
        ok: true,
        no_logs: true,
        ...(modeInfo.mode === 'both' ? { evidence } : {}),
        message: analysisResult.message,
      }
    }

    return modeInfo.mode === 'both'
      ? {
          target,
          ok: true,
          evidence,
          ...analysisResult,
        }
      : {
          target,
          ok: true,
          ...analysisResult,
        }
  } catch (error: unknown) {
    const httpError = toHttpError(error)
    return {
      target,
      ok: false,
      error: httpError.message,
      status: httpError.status,
    }
  }
}

async function executeJournaldBatch(
  body: AnalyzeLogsBatchRequest,
  ctx: AnalysisContext
): Promise<AnalyzeLogsBatchResponse> {
  const candidateTargets = body.targets && body.targets.length > 0 ? body.targets : ['all']
  const modeInfo = resolveBatchMode({
    mode: body.mode,
    analyze: body.analyze,
    collectOnly: body.collectOnly,
  })

  const results = await runConcurrent(candidateTargets, body.concurrency, async (target) =>
    executeJournaldTarget(body, target, modeInfo, ctx)
  )
  const ok = results.filter((result) => result.ok).length

  return AnalyzeLogsBatchResponseSchema.parse({
    source: 'journald',
    requestedTargets: candidateTargets.length,
    analyzedTargets: results.length,
    ok,
    failed: results.length - ok,
    results,
  })
}

export async function executeAnalyzeLogsBatch(
  body: AnalyzeLogsBatchRequest,
  ctx: AnalysisContext
): Promise<AnalyzeLogsBatchResponse> {
  if (body.source === 'loki') {
    return executeLokiBatch(body, ctx)
  }

  if (body.source === 'journald') {
    return executeJournaldBatch(body, ctx)
  }

  throw new Error(`Unsupported source: ${body.source}`)
}
