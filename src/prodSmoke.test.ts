import { describe, expect, it, vi } from 'vitest'
import { formatSmokeResult, runProdSmoke } from './prodSmoke.js'

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function buildFetch(overrides: Record<string, Response> = {}) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, init })

    if (overrides[url.pathname]) {
      return overrides[url.pathname]
    }

    if (url.pathname === '/metrics') {
      return textResponse('# TYPE blackice_http_requests_total counter\n')
    }

    if (url.pathname === '/v1/intents') {
      return jsonResponse(
        {
          ok: true,
          intent: { intentId: 'intent-smoke-1' },
        },
        { status: 201 }
      )
    }

    if (url.pathname.endsWith('/preflight')) {
      return jsonResponse({
        ok: true,
        preflightRecord: { preflightId: 'preflight-smoke-1' },
      })
    }

    return jsonResponse({ ok: true, intent: { intentId: 'intent-smoke-1' } })
  })
  return { fetchImpl, calls }
}

describe('prod smoke harness', () => {
  it('requires a base URL before making requests', async () => {
    const fetchImpl = vi.fn()

    const result = await runProdSmoke({ fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.steps).toEqual([
      { name: 'config', ok: false, message: 'BLACKICE_BASE_URL is required' },
    ])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses non-paper venues unless explicitly allowed', async () => {
    const fetchImpl = vi.fn()

    const result = await runProdSmoke({
      baseUrl: 'http://127.0.0.1:3000',
      venue: 'live',
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({
      name: 'config',
      ok: false,
      message: 'Non-paper smoke venues require BLACKICE_SMOKE_ALLOW_NON_PAPER=1',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runs the full paper-mode route sequence with bearer auth', async () => {
    const { fetchImpl, calls } = buildFetch()

    const result = await runProdSmoke({
      baseUrl: 'http://127.0.0.1:3000/',
      apiToken: 'secret-token',
      fetchImpl,
      now: () => new Date('2026-04-25T00:00:00.000Z'),
    })

    expect(result.ok).toBe(true)
    expect(result.steps.map((step) => step.name)).toEqual([
      'config',
      'healthz',
      'readyz',
      'version',
      'model_check',
      'metrics',
      'intent_create',
      'intent_preflight',
      'intent_confirm',
      'intent_execute',
      'intent_refresh',
      'intent_preflight_history',
      'intent_execution_logs',
    ])
    expect(calls.map((call) => call.path)).toEqual([
      '/healthz',
      '/readyz',
      '/version',
      '/v1/models/check',
      '/metrics',
      '/v1/intents',
      '/v1/intents/intent-smoke-1/preflight',
      '/v1/intents/intent-smoke-1/confirm',
      '/v1/intents/intent-smoke-1/execute',
      '/v1/intents/intent-smoke-1/refresh',
      '/v1/intents/intent-smoke-1/preflights',
      '/v1/intents/intent-smoke-1/execution-logs',
    ])
    expect(calls.every((call) => call.init?.headers instanceof Object)).toBe(true)
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    })
  })

  it('reports named failed steps and stops before intent mutation when readiness fails', async () => {
    const { fetchImpl } = buildFetch({
      '/readyz': jsonResponse({ ok: false }, { status: 503 }),
    })

    const result = await runProdSmoke({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.steps.find((step) => step.name === 'readyz')).toMatchObject({
      ok: false,
      message: '/readyz returned HTTP 503; expected 200',
    })
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/intents',
      expect.anything()
    )
    expect(formatSmokeResult(result)).toContain('FAIL readyz:')
  })

  it('surfaces request timeout failures with the step name', async () => {
    const timeoutError = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    })
    const fetchImpl = vi.fn(async () => {
      throw timeoutError
    })

    const result = await runProdSmoke({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl,
      timeoutMs: 1,
    })

    expect(result.ok).toBe(false)
    expect(result.steps.find((step) => step.name === 'healthz')).toMatchObject({
      ok: false,
      message: 'This operation was aborted',
    })
  })
})
