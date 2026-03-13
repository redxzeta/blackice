import { writeFile } from 'node:fs/promises'
import path from 'node:path'
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

  it('API auth stays disabled when API_TOKEN is unset', async () => {
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

  it('API auth returns 401 when bearer token is missing', async () => {
    vi.stubEnv('API_TOKEN', 'supersecret')

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

    expect(res.status).toBe(401)
    expect(res.body).toEqual({
      error: {
        message: 'Unauthorized',
        type: 'authentication_error',
      },
    })
  })

  it('API auth returns 403 when bearer token is wrong', async () => {
    vi.stubEnv('API_TOKEN', 'supersecret')

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer wrongtoken')
      .send({
        model: 'router/default',
        messages: [
          {
            role: 'user',
            content: '{"action":"healthcheck","input":"","options":{}}',
          },
        ],
      })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: {
        message: 'Unauthorized',
        type: 'authentication_error',
      },
    })
  })

  it('API auth allows exempt paths and honors AUTH_EXEMPT_PATHS', async () => {
    vi.stubEnv('API_TOKEN', 'supersecret')
    vi.stubEnv('AUTH_EXEMPT_PATHS', '/healthz,/v1/models/check')
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

    const [healthRes, modelsRes] = await Promise.all([
      request(app).get('/healthz'),
      request(app).get('/v1/models/check'),
    ])

    expect(healthRes.status).toBe(200)
    expect(modelsRes.status).toBe(200)
  })

  it('API auth treats exempt paths with trailing slashes as equivalent', async () => {
    vi.stubEnv('API_TOKEN', 'supersecret')

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/healthz/')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('API auth allows requests with the correct bearer token', async () => {
    vi.stubEnv('API_TOKEN', 'supersecret')

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer supersecret')
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

  it('GET /analyze/logs/targets returns structured Loki discovery metadata', async () => {
    const repoRoot = process.cwd()
    const configPath = path.join(repoRoot, '.tmp-targets-test-config.yaml')
    const rulesPath = path.join(repoRoot, 'config', 'loki-rules.local.yaml')
    await writeFile(
      configPath,
      [
        'version: 1',
        'ollama:',
        '  baseUrl: "http://127.0.0.1:11434"',
        '  model: "qwen2.5:14b"',
        '  timeoutMs: 45000',
        '  retryAttempts: 2',
        '  retryBackoffMs: 1000',
        'loki:',
        '  baseUrl: "http://127.0.0.1:3100"',
        '  timeoutMs: 10000',
        '  maxWindowMinutes: 60',
        '  defaultWindowMinutes: 15',
        '  maxLinesCap: 2000',
        '  maxResponseBytes: 2000000',
        '  requireScopeLabels: true',
        `  rulesFile: "${rulesPath}"`,
        'limits:',
        '  logCollectionTimeoutMs: 15000',
        '  maxCommandBytes: 2000000',
        '  maxQueryHours: 168',
        '  maxLinesCap: 2000',
        '  maxConcurrency: 5',
        '  maxLogChars: 40000',
      ].join('\n')
    )
    process.env.BLACKICE_CONFIG_FILE = configPath

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).get('/analyze/logs/targets')

    expect(res.status).toBe(200)
    expect(res.body.targets).toEqual([])
    expect(res.body.discovery).toEqual({
      job: 'journald',
      allowedLabels: ['app', 'host', 'job', 'service_name', 'unit'],
      hosts: ['owonto', 'uwuntu'],
      units: ['blackice-router.service', 'openclaw.service', 'promtail.service'],
      hasHostsRegex: false,
      hasUnitsRegex: false,
      requireScopeLabels: true,
    })
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
        .set('x-forwarded-for', `198.51.100.${10 + i}`)
        .send(payload)
      expect(okRes.status).toBe(200)
    }

    const limitedRes = await request(app)
      .post('/analyze/logs')
      .set('x-forwarded-for', '203.0.113.200')
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
            client: expect.stringMatching(/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/),
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
        .set('x-forwarded-for', `198.51.100.${20 + i}`)
        .send(payload)
      expect(okRes.status).toBe(200)
    }

    const limitedRes = await request(app)
      .post('/analyze/logs/batch')
      .set('x-forwarded-for', '203.0.113.201')
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
