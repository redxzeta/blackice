import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./actions.js', () => ({
  executeAction: vi.fn(async () => ({ action: 'healthcheck', text: 'ok-healthcheck' })),
}))

function buildEnrichedCandidate() {
  return {
    marketId: 'market-http-1',
    eventId: 'event-http-1',
    slug: 'btc-above-100k',
    question: 'Will BTC close above 100k?',
    marketType: 'standard' as const,
    tradable: true,
    metadataComplete: true,
    tags: [],
    qualificationStatus: 'eligible' as const,
    qualificationReasons: [],
    orderbook: {
      bestBid: 0.48,
      bestAsk: 0.5,
      spreadBps: 400,
      depthUsd: 1200,
      asOf: '2026-04-23T00:00:00.000Z',
    },
    impliedProbability: 0.49,
  }
}

function buildPreflightResult(ok = true) {
  return {
    ok,
    checkedAt: '2026-04-23T00:01:00.000Z',
    venue: 'paper',
    checks: [
      {
        code: ok ? 'candidate_not_tradable' : 'spread_above_limit',
        ok,
        message: ok ? 'Candidate is tradable' : 'Spread exceeds configured limit',
      },
    ],
  }
}

describe('integration routes', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.doUnmock('./logExplainer/logCollector.js')
    vi.doUnmock('./logExplainer/ollamaClient.js')
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

  it('POST /v1/intents creates and returns an intent record', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-1',
      accountId: 'acct-primary',
      market: 'BTC-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 1,
      notionalUsd: 12000,
      ttlSeconds: 300,
    })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(res.body.intent.status).toBe('submitted')
    expect(res.body.policy.allowedVenues).toContain('paper')
  })

  it('POST /v1/intents is idempotent on repeated idempotency keys', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)
    const payload = {
      idempotencyKey: 'idem-http-2',
      accountId: 'acct-primary',
      market: 'ETH-USD',
      venue: 'paper',
      side: 'sell',
      quantity: 2,
      notionalUsd: 6000,
      ttlSeconds: 300,
    }

    const first = await request(app).post('/v1/intents').send(payload)
    const second = await request(app).post('/v1/intents').send(payload)

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
    expect(second.body.intent.intentId).toBe(first.body.intent.intentId)
  })

  it('POST /v1/intents/:intentId/confirm and /execute complete the lifecycle', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-3',
      accountId: 'acct-primary',
      market: 'SOL-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 10,
      notionalUsd: 1500,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    const confirm = await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    const preflight = await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    const execute = await request(app).post(`/v1/intents/${intentId}/execute`).send({})

    expect(confirm.status).toBe(200)
    expect(confirm.body.intent.status).toBe('confirmed')
    expect(preflight.status).toBe(200)
    expect(preflight.body.preflightRecord.result.ok).toBe(true)
    expect(execute.status).toBe(200)
    expect(execute.body.intent.status).toBe('executed')
    expect(execute.body.intent.orders).toHaveLength(1)
    expect(execute.body.preflightRecord.result.ok).toBe(true)
  })

  it('POST /v1/intents rejects disallowed venues', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-4',
      accountId: 'acct-primary',
      market: 'BTC-USD',
      venue: 'kraken',
      side: 'buy',
      quantity: 1,
      notionalUsd: 1000,
      ttlSeconds: 300,
    })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('venue_not_allowed')
  })

  it('GET /v1/candidates returns enriched candidates from the route adapter', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      candidateEnrichmentAdapter: {
        listEnrichedCandidates: vi.fn().mockResolvedValue([buildEnrichedCandidate()]),
      },
    })

    const res = await request(app).get('/v1/candidates?limit=5')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.candidates).toHaveLength(1)
    expect(res.body.candidates[0].marketId).toBe('market-http-1')
  })

  it('GET /v1/candidates rejects invalid query parameters', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      candidateEnrichmentAdapter: {
        listEnrichedCandidates: vi.fn().mockResolvedValue([]),
      },
    })

    const res = await request(app).get('/v1/candidates?limit=abc')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid query parameters')
  })

  it('POST /v1/preflight returns a structured preflight result', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const res = await request(app).post('/v1/preflight').send({
      candidate: buildEnrichedCandidate(),
      positionUsd: 250,
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.preflight.ok).toBe(true)
    expect(res.body.preflight.venue).toBe('paper')
  })

  it('POST /v1/intents/:intentId/preflight records a persisted preflight for the intent', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-5',
      accountId: 'acct-primary',
      market: 'DOGE-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 5,
      notionalUsd: 250,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    const preflight = await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
      venue: 'kraken',
      positionUsd: 1,
    })

    expect(preflight.status).toBe(200)
    expect(preflight.body.preflightRecord.intentId).toBe(intentId)
    expect(preflight.body.preflightRecord.request.venue).toBe('paper')
    expect(preflight.body.preflightRecord.request.positionUsd).toBe(250)
    expect(preflight.body.preflightRecord.result.ok).toBe(true)
  })

  it('POST /v1/intents/:intentId/execute blocks execution when persisted preflight is missing or failed', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(false)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-6',
      accountId: 'acct-primary',
      market: 'DOGE-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 5,
      notionalUsd: 250,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})

    const missingPreflight = await request(app).post(`/v1/intents/${intentId}/execute`).send({})
    const failedPreflight = await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    const executeAfterFailedPreflight = await request(app)
      .post(`/v1/intents/${intentId}/execute`)
      .send({})

    expect(missingPreflight.status).toBe(422)
    expect(missingPreflight.body.code).toBe('preflight_required')
    expect(failedPreflight.status).toBe(200)
    expect(failedPreflight.body.preflightRecord.result.ok).toBe(false)
    expect(executeAfterFailedPreflight.status).toBe(422)
    expect(executeAfterFailedPreflight.body.code).toBe('preflight_failed')
  })

  it('POST /v1/intents/:intentId/execute blocks stale persisted preflights', async () => {
    const repoRoot = process.cwd()
    const configPath = path.join(repoRoot, '.tmp-preflight-stale-config.yaml')
    try {
      await writeFile(
        configPath,
        ['version: 1', 'execution:', '  preflightMaxAgeSeconds: 1'].join('\n')
      )
      vi.stubEnv('BLACKICE_CONFIG_FILE', configPath)

      let now = Date.parse('2026-04-23T00:00:00.000Z')
      const { ExecutionService } = await import('./execution/service.js')
      const { createApp } = await import('./app.js')
      const app = createApp(1, {
        executionService: new ExecutionService({
          now: () => new Date(now),
        }),
        preflightEvaluator: {
          evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
        },
      })

      const submit = await request(app).post('/v1/intents').send({
        idempotencyKey: 'idem-http-stale-preflight',
        accountId: 'acct-primary',
        market: 'DOGE-USD',
        venue: 'paper',
        side: 'buy',
        quantity: 5,
        notionalUsd: 250,
        ttlSeconds: 300,
      })
      const intentId = submit.body.intent.intentId

      await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
      await request(app).post(`/v1/intents/${intentId}/preflight`).send({
        candidate: buildEnrichedCandidate(),
      })
      now += 2_000
      const executeAfterStalePreflight = await request(app)
        .post(`/v1/intents/${intentId}/execute`)
        .send({})

      expect(executeAfterStalePreflight.status).toBe(422)
      expect(executeAfterStalePreflight.body.code).toBe('preflight_stale')
    } finally {
      await rm(configPath, { force: true })
    }
  })

  it('POST /v1/intents/:intentId/execute is retry-safe after terminal execution', async () => {
    const placeOrder = vi.fn(async () => ({
      logId: 'log-duplicate-filled',
      intentId: 'intent-duplicate-http',
      venue: 'paper',
      status: 'filled' as const,
      recordedAt: '2026-04-23T00:02:00.000Z',
      orderId: 'venue-duplicate-http-1',
      requestId: 'req-execute',
      preflightOk: true,
      details: {},
    }))
    const service = new (await import('./execution/service.js')).ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return {
            ...request,
            signerRef: 'mock:paper',
            signature: `sig:${request.requestId}`,
          }
        },
      },
      executionAdapter: {
        placeOrder,
        async cancelOrder() {
          return {
            logId: 'log-duplicate-cancelled',
            intentId: 'intent-duplicate-http',
            venue: 'paper',
            status: 'cancelled' as const,
            recordedAt: '2026-04-23T00:03:00.000Z',
            orderId: 'venue-duplicate-http-1',
            requestId: 'req-cancel',
            preflightOk: true,
            details: {},
          }
        },
        async getOrderStatus() {
          return null
        },
      },
    })
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      executionService: service,
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      intentId: 'intent-duplicate-http',
      idempotencyKey: 'idem-http-duplicate-execute',
      accountId: 'acct-primary',
      market: 'SOL-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 10,
      notionalUsd: 1500,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })

    const firstExecute = await request(app).post(`/v1/intents/${intentId}/execute`).send({})
    const secondExecute = await request(app).post(`/v1/intents/${intentId}/execute`).send({})
    const executionLogs = await request(app).get(`/v1/intents/${intentId}/execution-logs`)

    expect(firstExecute.status).toBe(200)
    expect(secondExecute.status).toBe(200)
    expect(secondExecute.body.intent.status).toBe('executed')
    expect(secondExecute.body.intent.orders).toHaveLength(1)
    expect(executionLogs.body.executionLogs).toHaveLength(1)
    expect(placeOrder).toHaveBeenCalledTimes(1)
  })

  it('POST /v1/intents/:intentId/refresh returns updated intent state when venue status advances', async () => {
    const service = new (await import('./execution/service.js')).ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return {
            ...request,
            signerRef: 'mock:paper',
            signature: `sig:${request.requestId}`,
          }
        },
      },
      executionAdapter: {
        async placeOrder() {
          return {
            logId: 'log-placed',
            intentId: 'intent-refresh-http',
            venue: 'paper',
            status: 'accepted' as const,
            recordedAt: '2026-04-23T00:02:00.000Z',
            orderId: 'venue-refresh-http-1',
            requestId: 'req-execute',
            preflightOk: true,
            details: {},
          }
        },
        async cancelOrder() {
          return {
            logId: 'log-cancelled',
            intentId: 'intent-refresh-http',
            venue: 'paper',
            status: 'cancelled' as const,
            recordedAt: '2026-04-23T00:04:00.000Z',
            orderId: 'venue-refresh-http-1',
            requestId: 'req-cancel',
            preflightOk: true,
            details: {},
          }
        },
        async getOrderStatus(orderId) {
          return {
            logId: 'log-filled',
            intentId: 'intent-refresh-http',
            venue: 'paper',
            status: 'filled' as const,
            recordedAt: '2026-04-23T00:03:00.000Z',
            orderId,
            requestId: 'req-refresh',
            preflightOk: true,
            details: {},
          }
        },
      },
    })
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      executionService: service,
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      intentId: 'intent-refresh-http',
      idempotencyKey: 'idem-http-7',
      accountId: 'acct-primary',
      market: 'SOL-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 10,
      notionalUsd: 1500,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    await request(app).post(`/v1/intents/${intentId}/execute`).send({})

    const refresh = await request(app).post(`/v1/intents/${intentId}/refresh`).send({})

    expect(refresh.status).toBe(200)
    expect(refresh.body.executionLog.status).toBe('filled')
    expect(refresh.body.intent.status).toBe('executed')
    expect(refresh.body.intent.orders.at(-1).status).toBe('filled')
  })

  it('POST /v1/intents/:intentId/refresh is read-only after terminal execution', async () => {
    const getOrderStatus = vi.fn(async () => ({
      logId: 'log-terminal-refresh',
      intentId: 'intent-terminal-refresh-http',
      venue: 'paper',
      status: 'filled' as const,
      recordedAt: '2026-04-23T00:04:00.000Z',
      orderId: 'venue-terminal-refresh-http-1',
      requestId: 'req-refresh',
      preflightOk: true,
      details: {},
    }))
    const service = new (await import('./execution/service.js')).ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return {
            ...request,
            signerRef: 'mock:paper',
            signature: `sig:${request.requestId}`,
          }
        },
      },
      executionAdapter: {
        async placeOrder() {
          return {
            logId: 'log-terminal-filled',
            intentId: 'intent-terminal-refresh-http',
            venue: 'paper',
            status: 'filled' as const,
            recordedAt: '2026-04-23T00:03:00.000Z',
            orderId: 'venue-terminal-refresh-http-1',
            requestId: 'req-execute',
            preflightOk: true,
            details: {},
          }
        },
        async cancelOrder() {
          return {
            logId: 'log-terminal-cancelled',
            intentId: 'intent-terminal-refresh-http',
            venue: 'paper',
            status: 'cancelled' as const,
            recordedAt: '2026-04-23T00:05:00.000Z',
            orderId: 'venue-terminal-refresh-http-1',
            requestId: 'req-cancel',
            preflightOk: true,
            details: {},
          }
        },
        getOrderStatus,
      },
    })
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      executionService: service,
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      intentId: 'intent-terminal-refresh-http',
      idempotencyKey: 'idem-http-terminal-refresh',
      accountId: 'acct-primary',
      market: 'SOL-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 10,
      notionalUsd: 1500,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    await request(app).post(`/v1/intents/${intentId}/execute`).send({})

    const refresh = await request(app).post(`/v1/intents/${intentId}/refresh`).send({})

    expect(refresh.status).toBe(200)
    expect(refresh.body.executionLog).toBeUndefined()
    expect(refresh.body.intent.status).toBe('executed')
    expect(getOrderStatus).not.toHaveBeenCalled()
  })

  it('POST /v1/intents/:intentId/cancel rejects terminal executed intents', async () => {
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      idempotencyKey: 'idem-http-cancel-executed',
      accountId: 'acct-primary',
      market: 'BTC-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 1,
      notionalUsd: 1000,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    await request(app).post(`/v1/intents/${intentId}/execute`).send({})

    const cancel = await request(app).post(`/v1/intents/${intentId}/cancel`).send({})
    const executionLogs = await request(app).get(`/v1/intents/${intentId}/execution-logs`)

    expect(cancel.status).toBe(409)
    expect(cancel.body.error).toContain('cannot be cancelled from status executed')
    expect(executionLogs.body.executionLogs).toHaveLength(1)
    expect(executionLogs.body.executionLogs[0].status).toBe('filled')
  })

  it('GET /v1/intents/:intentId/preflights and /execution-logs return persisted operator history', async () => {
    const service = new (await import('./execution/service.js')).ExecutionService({
      signingAdapter: {
        async signExecutionRequest(request) {
          return {
            ...request,
            signerRef: 'mock:paper',
            signature: `sig:${request.requestId}`,
          }
        },
      },
      executionAdapter: {
        async placeOrder() {
          return {
            logId: 'log-history-filled',
            intentId: 'intent-history-http',
            venue: 'paper',
            status: 'filled' as const,
            recordedAt: '2026-04-23T00:05:00.000Z',
            orderId: 'venue-history-http-1',
            requestId: 'req-execute',
            preflightOk: true,
            details: {},
          }
        },
        async cancelOrder() {
          return {
            logId: 'log-history-cancelled',
            intentId: 'intent-history-http',
            venue: 'paper',
            status: 'cancelled' as const,
            recordedAt: '2026-04-23T00:06:00.000Z',
            orderId: 'venue-history-http-1',
            requestId: 'req-cancel',
            preflightOk: true,
            details: {},
          }
        },
        async getOrderStatus() {
          return null
        },
      },
    })
    const { createApp } = await import('./app.js')
    const app = createApp(1, {
      executionService: service,
      preflightEvaluator: {
        evaluate: vi.fn().mockResolvedValue(buildPreflightResult(true)),
      },
    })

    const submit = await request(app).post('/v1/intents').send({
      intentId: 'intent-history-http',
      idempotencyKey: 'idem-http-8',
      accountId: 'acct-primary',
      market: 'BTC-USD',
      venue: 'paper',
      side: 'buy',
      quantity: 1,
      notionalUsd: 1000,
      ttlSeconds: 300,
    })
    const intentId = submit.body.intent.intentId

    await request(app).post(`/v1/intents/${intentId}/confirm`).send({})
    await request(app).post(`/v1/intents/${intentId}/preflight`).send({
      candidate: buildEnrichedCandidate(),
    })
    await request(app).post(`/v1/intents/${intentId}/execute`).send({})

    const preflights = await request(app).get(`/v1/intents/${intentId}/preflights`)
    const executionLogs = await request(app).get(`/v1/intents/${intentId}/execution-logs`)

    expect(preflights.status).toBe(200)
    expect(preflights.body.preflightRecords).toHaveLength(1)
    expect(preflights.body.preflightRecords[0].intentId).toBe(intentId)
    expect(executionLogs.status).toBe(200)
    expect(executionLogs.body.executionLogs).toHaveLength(1)
    expect(executionLogs.body.executionLogs[0].intentId).toBe(intentId)
    expect(executionLogs.body.executionLogs[0].status).toBe('filled')
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
    try {
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
      vi.stubEnv('BLACKICE_CONFIG_FILE', configPath)

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
    } finally {
      await rm(configPath, { force: true })
    }
  })

  it('GET /analyze/logs/targets includes Loki regex allowlists when configured', async () => {
    const repoRoot = process.cwd()
    const configPath = path.join(repoRoot, '.tmp-targets-regex-config.yaml')
    const rulesPath = path.join(repoRoot, '.tmp-targets-regex-rules.yaml')
    try {
      await writeFile(
        rulesPath,
        [
          'job: journald',
          'allowedLabels:',
          '  - job',
          '  - host',
          '  - unit',
          'hostsRegex: "^prod-(api|worker)-\\\\d+$"',
          'unitsRegex: "^[a-z0-9-]+\\\\.service$"',
        ].join('\n')
      )

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

      vi.stubEnv('BLACKICE_CONFIG_FILE', configPath)

      const { createApp } = await import('./app.js')
      const app = createApp(1)

      const res = await request(app).get('/analyze/logs/targets')

      expect(res.status).toBe(200)
      expect(res.body.discovery).toEqual({
        job: 'journald',
        allowedLabels: ['host', 'job', 'unit'],
        hosts: [],
        units: [],
        hostsRegex: '^prod-(api|worker)-\\d+$',
        unitsRegex: '^[a-z0-9-]+\\.service$',
        hasHostsRegex: true,
        hasUnitsRegex: true,
        requireScopeLabels: true,
      })
    } finally {
      await Promise.all([rm(configPath, { force: true }), rm(rulesPath, { force: true })])
    }
  })

  it('GET /analyze/logs/targets stays available when Loki is disabled', async () => {
    const repoRoot = process.cwd()
    const configPath = path.join(repoRoot, '.tmp-targets-disabled-config.yaml')
    try {
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
          '  baseUrl: ""',
          '  timeoutMs: 10000',
          '  maxWindowMinutes: 60',
          '  defaultWindowMinutes: 15',
          '  maxLinesCap: 2000',
          '  maxResponseBytes: 2000000',
          '  requireScopeLabels: true',
          '  rulesFile: ""',
          'limits:',
          '  logCollectionTimeoutMs: 15000',
          '  maxCommandBytes: 2000000',
          '  maxQueryHours: 168',
          '  maxLinesCap: 2000',
          '  maxConcurrency: 5',
          '  maxLogChars: 40000',
        ].join('\n')
      )
      vi.stubEnv('BLACKICE_CONFIG_FILE', configPath)

      const { createApp } = await import('./app.js')
      const app = createApp(1)

      const res = await request(app).get('/analyze/logs/targets')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        targets: [],
        discovery: {
          allowedLabels: [],
          hosts: [],
          units: [],
          hasHostsRegex: false,
          hasUnitsRegex: false,
          requireScopeLabels: true,
        },
      })
    } finally {
      await rm(configPath, { force: true })
    }
  })
  it('POST /analyze/logs redacts secrets before prompting and before responding', async () => {
    vi.doMock('./logExplainer/logCollector.js', () => ({
      checkLokiHealth: vi.fn(),
      collectLogs: vi.fn(async () => 'authorization: Bearer prompt-secret'),
      collectLokiBatchLogs: vi.fn(),
      ensureLokiRulesConfigured: vi.fn(),
      getLokiSyntheticTargets: vi.fn(() => []),
    }))
    vi.doMock('./logExplainer/ollamaClient.js', () => ({
      analyzeLogsWithOllama: vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
        expect(userPrompt).not.toContain('prompt-secret')
        expect(userPrompt).toContain('[REDACTED]')
        return 'Summary\nauthorization: Bearer response-secret'
      }),
    }))

    const { createApp } = await import('./app.js')
    const app = createApp(1)

    const res = await request(app).post('/analyze/logs').send({
      source: 'journald',
      target: 'ssh.service',
      hours: 1,
      maxLines: 20,
    })

    expect(res.status).toBe(200)
    expect(res.body.analysis).toContain('Bearer [REDACTED]')
    expect(res.body.analysis).not.toContain('response-secret')
    expect(res.body.safety).toEqual({
      redacted: true,
      reasons: expect.arrayContaining(['authorization_header']),
    })
  })

  it('GET /analyze/logs/metadata stays aligned with status endpoint list', async () => {
    const { createApp } = await import('./app.js')
    const { AnalyzeLogsMetadataResponseSchema } = await import('./logExplainer/schema.js')
    const app = createApp(1)

    const [statusRes, metadataRes] = await Promise.all([
      request(app).get('/analyze/logs/status'),
      request(app).get('/analyze/logs/metadata'),
    ])

    expect(statusRes.status).toBe(200)
    expect(metadataRes.status).toBe(200)
    expect(() => AnalyzeLogsMetadataResponseSchema.parse(metadataRes.body)).not.toThrow()

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

  it('POST /analyze/logs/batch raw mode marks empty journald results as no_logs', async () => {
    const collectLogsMock = vi.fn(async () => '')
    const analyzeLogsWithOllamaMock = vi.fn(async () => 'should-not-run')

    vi.doMock('./logExplainer/logCollector.js', () => ({
      checkLokiHealth: vi.fn(),
      collectLogs: collectLogsMock,
      collectLokiBatchLogs: vi.fn(),
      ensureLokiRulesConfigured: vi.fn(),
      getLokiSyntheticTargets: vi.fn(() => []),
    }))
    vi.doMock('./logExplainer/ollamaClient.js', () => ({
      analyzeLogsWithOllama: analyzeLogsWithOllamaMock,
    }))

    const { createApp } = await import('./app.js')
    const app = createApp(1)
    const payload = {
      source: 'journald',
      targets: ['ssh.service'],
      mode: 'raw',
      hours: 1,
      maxLines: 20,
      concurrency: 1,
    }

    const res = await request(app).post('/analyze/logs/batch').send(payload)

    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0]).toMatchObject({
      target: 'ssh.service',
      ok: true,
      no_logs: true,
      message: 'No logs collected (raw mode)',
      evidence: [],
    })
    expect(res.body.results[0].logs).toBeUndefined()
    expect(collectLogsMock).toHaveBeenCalledTimes(1)
    expect(analyzeLogsWithOllamaMock).not.toHaveBeenCalled()
  })

  it('POST /analyze/logs/batch raw mode marks empty loki results as no_logs', async () => {
    const collectLokiBatchLogsMock = vi.fn(async () => ({
      query: '{job="journald",unit="ssh.service"}',
      logs: '',
      limit: 2000,
      hours: 1,
    }))
    const analyzeLogsWithOllamaMock = vi.fn(async () => 'should-not-run')

    vi.doMock('./logExplainer/logCollector.js', () => ({
      checkLokiHealth: vi.fn(),
      collectLogs: vi.fn(),
      collectLokiBatchLogs: collectLokiBatchLogsMock,
      ensureLokiRulesConfigured: vi.fn(),
      getLokiSyntheticTargets: vi.fn(() => []),
    }))
    vi.doMock('./logExplainer/ollamaClient.js', () => ({
      analyzeLogsWithOllama: analyzeLogsWithOllamaMock,
    }))

    const { createApp } = await import('./app.js')
    const app = createApp(1)
    const payload = {
      source: 'loki',
      filters: {
        job: 'journald',
        unit: 'ssh.service',
      },
      mode: 'raw',
    }

    const res = await request(app).post('/analyze/logs/batch').send(payload)

    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0]).toMatchObject({
      target: '{job="journald",unit="ssh.service"}',
      ok: true,
      no_logs: true,
      message: 'No logs collected (raw mode)',
      evidence: [],
    })
    expect(res.body.results[0].logs).toBeUndefined()
    expect(collectLokiBatchLogsMock).toHaveBeenCalledTimes(1)
    expect(analyzeLogsWithOllamaMock).not.toHaveBeenCalled()
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
