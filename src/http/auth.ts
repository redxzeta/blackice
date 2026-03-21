import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { sendOpenAIError } from './errors.js'

const DEFAULT_AUTH_EXEMPT_PATHS = ['/healthz', '/readyz', '/version']

function normalizePathname(value: string): string {
  if (value === '/') {
    return value
  }

  return value.replace(/\/+$/, '') || '/'
}

function parseExemptPaths(value: string | undefined): string[] {
  const raw = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizePathname)

  return raw.length > 0 ? raw : DEFAULT_AUTH_EXEMPT_PATHS
}

function isExemptPath(requestPath: string, exemptPaths: string[]): boolean {
  const rawRequestPath = String(requestPath)
  const normalizedRequestPath = normalizePathname(rawRequestPath)
  return exemptPaths.some((exemptPath) => {
    const normalizedExemptPath = normalizePathname(exemptPath)
    return (
      rawRequestPath === normalizedExemptPath ||
      rawRequestPath === `${normalizedExemptPath}/` ||
      normalizedRequestPath === normalizedExemptPath
    )
  })
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
  if (isExemptPath(req.path, exemptPaths)) {
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
