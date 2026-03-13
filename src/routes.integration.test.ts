import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./actions.js', () => ({
  executeAction: vi.fn(async () => ({ action: 'healthcheck', text: 'ok-healthcheck' })),
}))

describe('integration routes', () => {
  beforeEach(() => {
    vi.resetModules()
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
})
