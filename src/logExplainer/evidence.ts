import { BATCH_EVIDENCE_LINES_MAX } from './schema.js'
import { sanitizeReadOnlyEvidenceLine } from './outputSafety.js'

export type EvidenceLine = {
  ts: string
  line: string
}

export const MAX_EVIDENCE_LINE_CHARS = 2_000

function clampEvidenceLine(line: string): string {
  if (line.length <= MAX_EVIDENCE_LINE_CHARS) {
    return line
  }
  return `${line.slice(0, MAX_EVIDENCE_LINE_CHARS)} [truncated]`
}

export function parseEvidenceLine(rawLine: string): EvidenceLine {
  const ISO_OR_SHORT_TS_PREFIX = /^(\d{4}-\d{2}-\d{2}[ T][^\s]+)\s+(.*)$/
  const LOKI_NS_TS_PREFIX = /^(\d{16,20})\s+(.*)$/
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

export function buildEvidence(
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
