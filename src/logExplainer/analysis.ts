import { log } from '../log.js'
import { collectLogs } from './logCollector.js'
import { analyzeLogsWithOllama } from './ollamaClient.js'
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  truncateLogs,
  type AnalyzePromptRequest,
} from './promptTemplates.js'
import { ensureReadOnlyAnalysisOutput, sanitizeReadOnlyAnalysisOutput } from './outputSafety.js'
import type { AnalyzeLogsRequest } from './schema.js'

export type AnalysisContext = {
  requestId?: string
  safetyIdentifier?: string
}

export type AnalysisResult = {
  analysis: string
  no_logs?: boolean
  message?: string
  safety?: {
    redacted: boolean
    reasons: string[]
  }
}

export async function analyzeOneRequest(
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

export async function analyzeFromRawLogs(
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
