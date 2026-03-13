import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { sendOpenAIError } from './errors.js'

const DEFAULT_AUTH_EXEMPT_PATHS = ['/healthz', '/readyz', '/version']

function parseExemptPaths(value: string | undefined): string[] {
  const raw = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return raw.length > 0 ? raw : DEFAULT_AUTH_EXEMPT_PATHS
}

function isAuthorized(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)

  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function getBearerToken(req: Request): string | null {
  const header = req.header('authorization')
  if (!header) {
    return null
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

export function bearerTokenAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiToken = String(process.env.API_TOKEN ?? '').trim()
  if (!apiToken) {
    next()
    return
  }

  const exemptPaths = parseExemptPaths(process.env.AUTH_EXEMPT_PATHS)
  if (exemptPaths.includes(req.path)) {
    next()
    return
  }

  const providedToken = getBearerToken(req)
  if (!providedToken) {
    sendOpenAIError(res, 401, 'Unauthorized', 'authentication_error')
    return
  }

  if (!isAuthorized(providedToken, apiToken)) {
    sendOpenAIError(res, 403, 'Unauthorized', 'authentication_error')
    return
  }

  next()
}
