import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  modelFactory: vi.fn((modelId: string) => ({ modelId })),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  streamText: mocks.streamText,
}))

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => mocks.modelFactory),
}))

describe('runWorkerText policy fallback', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  it('falls back when structured cyber policy violation is returned', async () => {
    mocks.generateText
      .mockRejectedValueOnce({
        error: {
          error_code: 'cyber_policy_violation',
          param: 'safety_identifier',
          message: 'blocked by policy',
        },
      })
      .mockResolvedValueOnce({ text: 'fallback-ok' })

    const { runWorkerText } = await import('./ollama.js')

    const result = await runWorkerText({
      modelId: 'gpt-5.3-codex',
      input: 'hello world',
      requestId: 'req-123',
      safetyIdentifier: 'usr_123',
      routeKind: 'chat',
    })

    expect(result.text).toBe('fallback-ok')
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    expect(mocks.generateText.mock.calls[0][0].model).toEqual({ modelId: 'gpt-5.3-codex' })
    expect(mocks.generateText.mock.calls[1][0].model).toEqual({ modelId: 'qwen2.5:14b' })
    expect(mocks.generateText.mock.calls[0][0].headers).toMatchObject({
      'X-Request-ID': 'req-123',
      'X-Safety-Identifier': 'usr_123',
    })
  })

  it('does not fallback for non-policy errors', async () => {
    mocks.generateText.mockRejectedValueOnce(new Error('network down'))
    const { runWorkerText } = await import('./ollama.js')

    await expect(
      runWorkerText({
        modelId: 'gpt-5.3-codex',
        input: 'hello world',
        requestId: 'req-123',
        safetyIdentifier: 'usr_123',
        routeKind: 'chat',
      })
    ).rejects.toThrow('network down')

    expect(mocks.generateText).toHaveBeenCalledTimes(1)
  })

  it('records LLM metrics for successful non-stream requests', async () => {
    mocks.generateText.mockResolvedValueOnce({ text: 'ok' })

    const { resetHttpMetrics, renderPrometheusMetrics } = await import('./http/metrics.js')
    resetHttpMetrics()
    const { runWorkerText } = await import('./ollama.js')

    await expect(
      runWorkerText({
        modelId: 'qwen2.5:14b',
        input: 'hello world',
        routeKind: 'chat',
      })
    ).resolves.toEqual({ text: 'ok' })

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('llm_request_total{model="qwen2.5:14b",status="success"} 1')
    expect(metrics).toContain('llm_request_latency_seconds_count{model="qwen2.5:14b"} 1')
  })

  it('records LLM metrics for failed non-stream requests', async () => {
    mocks.generateText.mockRejectedValueOnce(new Error('network down'))

    const { resetHttpMetrics, renderPrometheusMetrics } = await import('./http/metrics.js')
    resetHttpMetrics()
    const { runWorkerText } = await import('./ollama.js')

    await expect(
      runWorkerText({
        modelId: 'qwen2.5:14b',
        input: 'hello world',
        routeKind: 'chat',
      })
    ).rejects.toThrow('network down')

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('llm_request_total{model="qwen2.5:14b",status="failure"} 1')
    expect(metrics).toContain('llm_request_latency_seconds_count{model="qwen2.5:14b"} 1')
  })

  it('records LLM metrics after stream consumption completes', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* stream() {
        yield { type: 'text-delta', textDelta: 'ok' }
      })(),
    })

    const { resetHttpMetrics, renderPrometheusMetrics } = await import('./http/metrics.js')
    resetHttpMetrics()
    const { runWorkerTextStream } = await import('./ollama.js')

    const result = runWorkerTextStream({
      modelId: 'qwen2.5:14b',
      input: 'hello world',
      routeKind: 'chat',
    })

    for await (const _part of result.fullStream) {
      // Consume the stream so completion can be observed.
    }

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('llm_request_total{model="qwen2.5:14b",status="success"} 1')
    expect(metrics).toContain('llm_request_latency_seconds_count{model="qwen2.5:14b"} 1')
  })

  it('records LLM metrics when stream consumption fails', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* stream() {
        yield { type: 'text-delta', textDelta: 'before failure' }
        throw new Error('stream failed')
      })(),
    })

    const { resetHttpMetrics, renderPrometheusMetrics } = await import('./http/metrics.js')
    resetHttpMetrics()
    const { runWorkerTextStream } = await import('./ollama.js')

    const result = runWorkerTextStream({
      modelId: 'qwen2.5:14b',
      input: 'hello world',
      routeKind: 'chat',
    })

    await expect(async () => {
      for await (const _part of result.fullStream) {
        // Consume the stream so failure can be observed.
      }
    }).rejects.toThrow('stream failed')

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('llm_request_total{model="qwen2.5:14b",status="failure"} 1')
    expect(metrics).toContain('llm_request_latency_seconds_count{model="qwen2.5:14b"} 1')
  })

  it('checks model availability against Ollama tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen2.5:14b' }, { model: 'llama3.1:8b' }],
        }),
      })
    )

    const { checkModelAvailability } = await import('./ollama.js')
    const result = await checkModelAvailability('llama3.1:8b')

    expect(result.ok).toBe(true)
    expect(result.available).toBe(true)
    expect(result.model).toBe('llama3.1:8b')
    expect(result.baseUrl).toBe('http://192.168.1.230:11434/api')
  })

  it('maps fetch aborts to upstream timeout errors for availability checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new Error('timed out'), {
          name: 'AbortError',
        })
      )
    )

    const { checkModelAvailability } = await import('./ollama.js')

    await expect(checkModelAvailability()).rejects.toMatchObject({
      name: 'ModelAvailabilityCheckError',
      code: 'upstream_timeout',
    })
  })
})
