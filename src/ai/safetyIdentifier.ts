import { createHash } from 'node:crypto'
import type { Request } from 'express'

const MAX_IDENTIFIER_LEN = 128
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@-]+$/
const CANDIDATE_HEADERS = [
  'x-user-id',
  'x-authenticated-user',
  'x-openai-user',
  'x-openai-user-id',
] as const

function normalizeIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_LEN) {
    return undefined
  }

  if (!SAFE_IDENTIFIER_PATTERN.test(trimmed)) {
    return undefined
  }

  return trimmed
}

function firstHeaderValue(req: Request, header: string): string | undefined {
  const raw = req.header(header)
  if (typeof raw !== 'string') {
    return undefined
  }
  return raw
}

function hashToSafetyIdentifier(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 24)
  return `usr_${hash}`
}

export function resolveSafetyIdentifier(args: {
  request: Request
  explicitUser?: string
  requestId: string
}): string {
  const fromBody = normalizeIdentifier(args.explicitUser)
  if (fromBody) {
    return hashToSafetyIdentifier(fromBody)
  }

  for (const header of CANDIDATE_HEADERS) {
    const value = normalizeIdentifier(firstHeaderValue(args.request, header))
    if (value) {
      return hashToSafetyIdentifier(value)
    }
  }

  const ip = args.request.ip?.trim()
  if (ip) {
    return hashToSafetyIdentifier(ip)
  }

  return hashToSafetyIdentifier(args.requestId)
}
