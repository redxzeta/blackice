type SmokeStepName =
  | 'config'
  | 'healthz'
  | 'readyz'
  | 'version'
  | 'metrics'
  | 'model_check'
  | 'intent_create'
  | 'intent_preflight'
  | 'intent_confirm'
  | 'intent_execute'
  | 'intent_refresh'
  | 'intent_preflight_history'
  | 'intent_execution_logs'

type SmokeStepResult = {
  name: SmokeStepName
  ok: boolean
  message: string
}

type SmokeHttpClient = typeof fetch

type SmokeOptions = {
  baseUrl?: string
  apiToken?: string
  venue?: string
  allowNonPaperVenue?: boolean
  timeoutMs?: number
  fetchImpl?: SmokeHttpClient
  now?: () => Date
}

type SmokeResult = {
  ok: boolean
  steps: SmokeStepResult[]
}

type JsonRecord = Record<string, unknown>

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_VENUE = 'paper'

function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authHeaders(apiToken?: string): Record<string, string> {
  if (!apiToken?.trim()) {
    return {}
  }
  return { Authorization: `Bearer ${apiToken.trim()}` }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return null
  }
  return JSON.parse(text) as unknown
}

async function requestJson(
  fetchImpl: SmokeHttpClient,
  baseUrl: string,
  path: string,
  options: {
    apiToken?: string
    method?: string
    body?: unknown
    timeoutMs: number
  }
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...authHeaders(options.apiToken),
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })

    return {
      status: response.status,
      body: await readJson(response),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function requestText(
  fetchImpl: SmokeHttpClient,
  baseUrl: string,
  path: string,
  options: {
    apiToken?: string
    timeoutMs: number
  }
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        Accept: 'text/plain',
        ...authHeaders(options.apiToken),
      },
      signal: controller.signal,
    })
    return {
      status: response.status,
      body: await response.text(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function stepOk(name: SmokeStepName, message = 'ok'): SmokeStepResult {
  return { name, ok: true, message }
}

function stepFailed(name: SmokeStepName, message: string): SmokeStepResult {
  return { name, ok: false, message }
}

async function captureStep(
  name: SmokeStepName,
  run: () => Promise<unknown>
): Promise<SmokeStepResult> {
  try {
    const message = await run()
    return stepOk(name, typeof message === 'string' ? message : 'ok')
  } catch (error) {
    return stepFailed(name, formatError(error))
  }
}

function assertStatus(name: string, status: number, allowed: number[]): void {
  if (!allowed.includes(status)) {
    throw new Error(`${name} returned HTTP ${status}; expected ${allowed.join(' or ')}`)
  }
}

function requireResponseRecord(step: string, body: unknown): JsonRecord {
  if (!isRecord(body)) {
    throw new Error(`${step} returned a non-object response`)
  }
  return body
}

function extractIntentId(body: unknown): string {
  const response = requireResponseRecord('intent_create', body)
  const intent = response.intent
  if (!isRecord(intent) || typeof intent.intentId !== 'string' || !intent.intentId) {
    throw new Error('intent_create response did not include intent.intentId')
  }
  return intent.intentId
}

function buildSmokeCandidate(marketId: string) {
  return {
    marketId,
    eventId: 'prod-smoke-event',
    slug: 'prod-smoke-paper-market',
    question: 'Production smoke test paper market?',
    marketType: 'standard',
    tradable: true,
    metadataComplete: true,
    tags: ['prod-smoke'],
    qualificationStatus: 'eligible',
    qualificationReasons: [],
    orderbook: {
      bestBid: 0.49,
      bestAsk: 0.5,
      spreadBps: 200,
      depthUsd: 10_000,
      asOf: new Date().toISOString(),
    },
    impliedProbability: 0.5,
  }
}

function buildIntentPayload(venue: string, now: Date) {
  const stamp = now.toISOString().replaceAll(/[^0-9A-Za-z]/g, '')
  return {
    idempotencyKey: `prod-smoke-${stamp}`,
    accountId: 'prod-smoke',
    market: `PROD-SMOKE-${stamp}`,
    venue,
    side: 'buy',
    quantity: 1,
    limitPrice: 0.5,
    notionalUsd: 1,
    ttlSeconds: 300,
    metadata: {
      source: 'prod-smoke',
    },
  }
}

export function formatSmokeResult(result: SmokeResult): string {
  const lines = result.steps.map((step) => {
    const prefix = step.ok ? 'PASS' : 'FAIL'
    return `${prefix} ${step.name}: ${step.message}`
  })
  return lines.join('\n')
}

export async function runProdSmoke(options: SmokeOptions = {}): Promise<SmokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const venue = options.venue?.trim() || DEFAULT_VENUE
  const steps: SmokeStepResult[] = []

  if (!options.baseUrl?.trim()) {
    return {
      ok: false,
      steps: [stepFailed('config', 'BLACKICE_BASE_URL is required')],
    }
  }

  if (venue !== 'paper' && !options.allowNonPaperVenue) {
    return {
      ok: false,
      steps: [
        stepFailed('config', 'Non-paper smoke venues require BLACKICE_SMOKE_ALLOW_NON_PAPER=1'),
      ],
    }
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const common = {
    apiToken: options.apiToken,
    timeoutMs,
  }

  steps.push(stepOk('config', `base=${baseUrl} venue=${venue}`))

  for (const [name, path] of [
    ['healthz', '/healthz'],
    ['readyz', '/readyz'],
    ['version', '/version'],
    ['model_check', '/v1/models/check'],
  ] as const) {
    steps.push(
      await captureStep(name, async () => {
        const response = await requestJson(fetchImpl, baseUrl, path, common)
        assertStatus(path, response.status, [200])
      })
    )
  }

  steps.push(
    await captureStep('metrics', async () => {
      const response = await requestText(fetchImpl, baseUrl, '/metrics', common)
      assertStatus('/metrics', response.status, [200])
      if (!response.body.includes('# TYPE')) {
        throw new Error('/metrics did not return Prometheus exposition text')
      }
    })
  )

  if (steps.some((step) => !step.ok)) {
    return { ok: false, steps }
  }

  const intentPayload = buildIntentPayload(venue, options.now?.() ?? new Date())
  let intentId = ''

  steps.push(
    await captureStep('intent_create', async () => {
      const response = await requestJson(fetchImpl, baseUrl, '/v1/intents', {
        ...common,
        method: 'POST',
        body: intentPayload,
      })
      assertStatus('/v1/intents', response.status, [200, 201])
      intentId = extractIntentId(response.body)
      return `intent=${intentId}`
    })
  )

  if (!intentId) {
    return { ok: false, steps }
  }

  steps.push(
    await captureStep('intent_preflight', async () => {
      const response = await requestJson(fetchImpl, baseUrl, `/v1/intents/${intentId}/preflight`, {
        ...common,
        method: 'POST',
        body: {
          candidate: buildSmokeCandidate(intentPayload.market),
        },
      })
      assertStatus(`/v1/intents/${intentId}/preflight`, response.status, [200])
      const body = requireResponseRecord('intent_preflight', response.body)
      if (!isRecord(body.preflightRecord)) {
        throw new Error('intent_preflight response did not include preflightRecord')
      }
    })
  )

  for (const [name, path, method] of [
    ['intent_confirm', `/v1/intents/${intentId}/confirm`, 'POST'],
    ['intent_execute', `/v1/intents/${intentId}/execute`, 'POST'],
    ['intent_refresh', `/v1/intents/${intentId}/refresh`, 'POST'],
    ['intent_preflight_history', `/v1/intents/${intentId}/preflights`, 'GET'],
    ['intent_execution_logs', `/v1/intents/${intentId}/execution-logs`, 'GET'],
  ] as const) {
    steps.push(
      await captureStep(name, async () => {
        const response = await requestJson(fetchImpl, baseUrl, path, {
          ...common,
          method,
          body: method === 'POST' ? {} : undefined,
        })
        assertStatus(path, response.status, [200])
      })
    )
  }

  return {
    ok: steps.every((step) => step.ok),
    steps,
  }
}

export type { SmokeOptions, SmokeResult, SmokeStepResult }
