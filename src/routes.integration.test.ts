import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./actions.js', () => ({
  executeAction: vi.fn(async () => ({ action: 'healthcheck', text: 'ok-healthcheck' })),
}))

describe('integration routes', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('GET /healthz returns ok', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/healthz')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers['x-blackice-version']).toBeDefined()
  })

  it('POST /v1/chat/completions supports action happy path', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({
        model: 'router/default',
        messages: [
          {
            role: 'user',
            content: '{"action":"healthcheck","input":"","options":{}}',
          },
        ],
      })

    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('ok-healthcheck')
  })

  it('POST /v1/chat/completions rejects invalid payload', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'router/default', messages: 'not-an-array' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('POST /v1/policy/dry-run returns route decision', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/v1/policy/dry-run')
      .send({
        model: 'router/default',
        messages: [{ role: 'user', content: 'hello there' }],
      })

    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('dry_run')
    expect(res.body.route).toBeDefined()
  })

  it('POST /analyze/logs returns validation error for bad payload', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/analyze/logs')
      .send({ source: 'invalid-source', target: '/tmp/x' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('GET /analyze/logs/metadata stays aligned with status endpoint list', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const [statusRes, metadataRes] = await Promise.all([
      request(app).get('/analyze/logs/status'),
      request(app).get('/analyze/logs/metadata'),
    ])

    expect(statusRes.status).toBe(200)
    expect(metadataRes.status).toBe(200)

    const metadataEndpoints = Object.values(metadataRes.body.endpoints) as Array<{
      method: string
      path: string
    }>
    const metadataPaths = metadataEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)

    expect(metadataPaths.sort()).toEqual([...statusRes.body.endpoints].sort())
  })

  it('POST /analyze/logs enforces per client rate limits with retry guidance and telemetry', async () => {
    vi.doMock('./logExplainer/logCollector.js', () => ({
      checkLokiHealth: vi.fn(),
      collectLogs: vi.fn(async () => 'line 1'),
      collectLokiBatchLogs: vi.fn(),
      ensureLokiRulesConfigured: vi.fn(),
      getLokiSyntheticTargets: vi.fn(() => []),
    }))
    vi.doMock('./logExplainer/ollamaClient.js', () => ({
      analyzeLogsWithOllama: vi.fn(async () => 'ok'),
    }))

    const { createApp } = await import('./app.js')
    const { getRecentLogs } = await import('./log.js')
    const app = createApp(1)
    const payload = {
      source: 'journald',
      target: 'ssh.service',
      hours: 1,
      maxLines: 20,
    }

    for (let i = 0; i < 5; i += 1) {
      const okRes = await request(app)
        .post('/analyze/logs')
        .set('x-forwarded-for', '198.51.100.10')
        .send(payload)
      expect(okRes.status).toBe(200)
    }

    const limitedRes = await request(app)
      .post('/analyze/logs')
      .set('x-forwarded-for', '198.51.100.10')
      .send(payload)

    expect(limitedRes.status).toBe(429)
    expect(limitedRes.body).toEqual({
      error: 'Rate limit exceeded',
      type: 'rate_limit_exceeded',
      path: '/analyze/logs',
      retryAfterSeconds: expect.any(Number),
    })
    expect(Number(limitedRes.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(limitedRes.headers['x-ratelimit-limit']).toBe('5')
    expect(limitedRes.headers['x-ratelimit-remaining']).toBe('0')

    expect(getRecentLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          msg: 'log_explainer_rate_limit_hit',
          fields: expect.objectContaining({
            path: '/analyze/logs',
            client: '198.51.100.10',
            limit: 5,
          }),
        }),
      ])
    )
  })

  it('POST /analyze/logs/batch uses a stricter limit than single target analysis', async () => {
    vi.doMock('./logExplainer/logCollector.js', () => ({
      checkLokiHealth: vi.fn(),
      collectLogs: vi.fn(async () => 'line 1'),
      collectLokiBatchLogs: vi.fn(),
      ensureLokiRulesConfigured: vi.fn(),
      getLokiSyntheticTargets: vi.fn(() => []),
    }))
    vi.doMock('./logExplainer/ollamaClient.js', () => ({
      analyzeLogsWithOllama: vi.fn(async () => 'ok'),
    }))

    const { createApp } = await import('./app.js')
    const app = createApp(1)
    const payload = {
      source: 'journald',
      targets: ['ssh.service'],
      hours: 1,
      maxLines: 20,
      concurrency: 1,
    }

    for (let i = 0; i < 2; i += 1) {
      const okRes = await request(app)
        .post('/analyze/logs/batch')
        .set('x-forwarded-for', '198.51.100.11')
        .send(payload)
      expect(okRes.status).toBe(200)
    }

    const limitedRes = await request(app)
      .post('/analyze/logs/batch')
      .set('x-forwarded-for', '198.51.100.11')
      .send(payload)

    expect(limitedRes.status).toBe(429)
    expect(limitedRes.body.path).toBe('/analyze/logs/batch')
    expect(limitedRes.headers['x-ratelimit-limit']).toBe('2')
  })

  it('GET /v1/models/check returns availability for the configured model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen2.5:14b' }],
        }),
      })
    )

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/v1/models/check')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      model: 'qwen2.5:14b',
      available: true,
      baseUrl: 'http://192.168.1.230:11434/api',
    })
  })

  it('GET /v1/models/check returns 404 when the requested model is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen2.5:14b' }],
        }),
      })
    )

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/v1/models/check').query({ model: 'missing-model' })

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({
      ok: false,
      model: 'missing-model',
      available: false,
      error: 'model_not_found',
    })
  })

  it('GET /v1/models/check returns 504 when the upstream probe times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new Error('timed out'), {
          name: 'AbortError',
        })
      )
    )

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/v1/models/check')

    expect(res.status).toBe(504)
    expect(res.body).toEqual({
      ok: false,
      available: false,
      error: 'upstream_timeout',
    })
  })
})
