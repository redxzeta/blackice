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
    vi.unstubAllEnvs()
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

  it('GET /metrics exposes Prometheus text when enabled', async () => {
    vi.stubEnv('METRICS_ENABLED', '1')
    vi.stubEnv('METRICS_EXPOSE_PATH', '/metrics')

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const metricsRes = await request(app).get('/metrics')
    expect(metricsRes.status).toBe(200)
    expect(metricsRes.headers['content-type']).toContain('text/plain')
    expect(metricsRes.text).toContain('# TYPE blackice_http_requests_total counter')

    const healthRes = await request(app).get('/healthz')
    expect(healthRes.status).toBe(200)

    const metricsAfterTraffic = await request(app).get('/metrics')
    expect(metricsAfterTraffic.text).toContain(
      'blackice_http_requests_total{route="/healthz",method="GET",status="200"} 1'
    )
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
