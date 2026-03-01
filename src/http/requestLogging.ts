import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../log.js';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_MAX_LEN = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function parseRequestIdHeader(req: Request): string | undefined {
  const value = req.header(REQUEST_ID_HEADER);
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim();
}

function normalizeRequestId(raw: string | undefined): string | undefined {
  if (!raw || raw.length > REQUEST_ID_MAX_LEN) {
    return undefined;
  }

  if (!REQUEST_ID_PATTERN.test(raw)) {
    return undefined;
  }

  return raw;
}

function formatRoute(req: Request): string {
  const routePath = req.route?.path;
  const base = req.baseUrl ?? '';

  if (typeof routePath === 'string') {
    return `${base}${routePath}`;
  }

  if (Array.isArray(routePath)) {
    return routePath.map((segment) => `${base}${String(segment)}`).join('|');
  }

  return req.path;
}

export function getRequestId(res: Response): string {
  const value = res.locals.requestId;
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  const generated = randomUUID();
  res.locals.requestId = generated;
  res.setHeader(REQUEST_ID_HEADER, generated);
  return generated;
}

export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const requestId = normalizeRequestId(parseRequestIdHeader(req)) ?? randomUUID();

  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    log.info('http_request', {
      request_id: requestId,
      method: req.method,
      path: req.path,
      route: formatRoute(req),
      status: res.statusCode,
      latency_ms: Number(latencyMs.toFixed(3)),
      timestamp: new Date().toISOString()
    });
  });

  next();
}
