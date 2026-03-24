import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('env preflight timeout', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('clamps MODEL_PREFLIGHT_TIMEOUT_MS to the supported max', async () => {
    process.env.MODEL_PREFLIGHT_TIMEOUT_MS = '15000'

    const { env } = await import('./env.js')

    expect(env.MODEL_PREFLIGHT_TIMEOUT_MS).toBe(10_000)
  })

  it('clamps MODEL_PREFLIGHT_TIMEOUT_MS to the supported min', async () => {
    process.env.MODEL_PREFLIGHT_TIMEOUT_MS = '100'

    const { env } = await import('./env.js')

    expect(env.MODEL_PREFLIGHT_TIMEOUT_MS).toBe(200)
  })

  it('ignores deprecated runtime env vars moved to YAML config', async () => {
    process.env.PORT = 'not-a-number'
    process.env.DEBATE_MAX_CONCURRENT = 'NaN'
    process.env.LOG_BUFFER_MAX_ENTRIES = 'oops'

    const { env } = await import('./env.js')

    expect(env.LOG_LEVEL).toBe('info')
    expect(env.MODEL_PREFLIGHT_TIMEOUT_MS).toBe(2_000)
  })
})
