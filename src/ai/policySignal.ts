export type PolicySignal = {
  isCyberPolicyViolation: boolean
  errorCode?: string
  param?: string
  message?: string
}

function normalizeString(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined
  }
  const value = input.trim()
  return value.length > 0 ? value : undefined
}

function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeString(record[key])
    if (value) {
      return value
    }
  }
  return undefined
}

function collectRecords(error: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<object>()
  const queue: unknown[] = [error]
  let depth = 0

  while (queue.length > 0 && depth < 5) {
    const current = queue.shift()
    depth += 1
    if (!current || typeof current !== 'object') {
      continue
    }
    if (seen.has(current)) {
      continue
    }
    seen.add(current)

    const record = current as Record<string, unknown>
    out.push(record)
    queue.push(record.error, record.data, record.response, record.body, record.cause)
  }

  return out
}

function parseMessageSignal(message: string | undefined): { errorCode?: string; param?: string } {
  if (!message) {
    return {}
  }

  const paramMatch = message.match(/["']?param["']?\s*[:=]\s*["']?([a-zA-Z0-9_:-]+)["']?/i)
  const codeMatch = message.match(/["']?error_code["']?\s*[:=]\s*["']?([a-zA-Z0-9_:-]+)["']?/i)
  return {
    errorCode: codeMatch?.[1],
    param: paramMatch?.[1],
  }
}

export function parsePolicySignal(error: unknown): PolicySignal {
  const records = collectRecords(error)
  const recordMessage = records.map((record) => firstStringField(record, ['message'])).find(Boolean)

  const message =
    (error instanceof Error ? normalizeString(error.message) : undefined) ??
    recordMessage ??
    normalizeString(error)

  const structuredErrorCode = records
    .map((record) => firstStringField(record, ['error_code', 'code']))
    .find(Boolean)
  const structuredParam = records
    .map((record) => firstStringField(record, ['param', 'parameter']))
    .find(Boolean)

  const fromMessage = parseMessageSignal(message)
  const errorCode = structuredErrorCode ?? fromMessage.errorCode
  const param = structuredParam ?? fromMessage.param
  const isCyberPolicyViolation =
    errorCode?.toLowerCase() === 'cyber_policy_violation' ||
    /cyber_policy_violation/i.test(message ?? '')

  return {
    isCyberPolicyViolation,
    errorCode,
    param,
    message,
  }
}
