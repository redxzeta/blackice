import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkModelAvailability: vi.fn(),
  getConfiguredOllamaModel: vi.fn(() => 'qwen2.5:14b'),
  logInfo: vi.fn(),
}))

vi.mock('./ollama.js', () => ({
  checkModelAvailability: mocks.checkModelAvailability,
  getConfiguredOllamaModel: mocks.getConfiguredOllamaModel,
  ollamaBaseURL: 'http://192.168.1.230:11434/api',
}))

vi.mock('./log.js', () => ({
  log: {
    info: mocks.logInfo,
  },
}))

describe('runStartupModelPreflight', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env = {
      ...originalEnv,
      MODEL_PREFLIGHT_ON_START: '1',
    }
  })

  it('returns early when startup preflight is disabled', async () => {
    process.env.MODEL_PREFLIGHT_ON_START = '0'

    const { runStartupModelPreflight } = await import('./startupPreflight.js')
    await runStartupModelPreflight()

    expect(mocks.checkModelAvailability).not.toHaveBeenCalled()
  })

  it('fails startup when the configured model is missing', async () => {
    mocks.checkModelAvailability.mockResolvedValue({
      ok: false,
      model: 'missing-model',
      baseUrl: 'http://192.168.1.230:11434/api',
      available: false,
      latencyMs: 12,
    })

    const { runStartupModelPreflight } = await import('./startupPreflight.js')

    await expect(runStartupModelPreflight()).rejects.toThrow(
      'startup_preflight_failed_model_not_found:missing-model'
    )
  })

  it('logs success when the configured model is available', async () => {
    mocks.checkModelAvailability.mockResolvedValue({
      ok: true,
      model: 'qwen2.5:14b',
      baseUrl: 'http://192.168.1.230:11434/api',
      available: true,
      latencyMs: 21,
    })

    const { runStartupModelPreflight } = await import('./startupPreflight.js')
    await runStartupModelPreflight()

    expect(mocks.logInfo).toHaveBeenCalledWith('startup_model_preflight_ok', {
      model: 'qwen2.5:14b',
      latency_ms: 21,
      ollama_base_url: 'http://192.168.1.230:11434/api',
    })
  })
})
