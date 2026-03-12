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
})
