import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('log.ts', () => {
  it('stores logs in buffer and trims to configured max size', async () => {
    vi.stubEnv('LOG_BUFFER_MAX_ENTRIES', '100')
    const { log, getRecentLogs } = await import('./log.js')

    for (let i = 0; i < 101; i++) {
      log.info(`msg_${i}`, { i })
    }

    const recent = getRecentLogs(200)
    expect(recent).toHaveLength(100)
    expect(recent[0].msg).toBe('msg_1')
    expect(recent[recent.length - 1].msg).toBe('msg_100')
  })

  it('includes error entries in metrics and recent logs', async () => {
    vi.stubEnv('LOG_BUFFER_MAX_ENTRIES', '100')
    const { log, getRecentLogs, getLogMetrics } = await import('./log.js')

    log.info('ok_event')
    log.error('bad_event', { code: 'E_TEST' })

    const recent = getRecentLogs(5)
    expect(recent.some((e) => e.level === 'error' && e.msg === 'bad_event')).toBe(true)

    const metrics = getLogMetrics('1h')
    expect(metrics.total).toBeGreaterThanOrEqual(2)
    expect(metrics.byLevel.error).toBeGreaterThanOrEqual(1)
    expect(metrics.byMessage.bad_event).toBeGreaterThanOrEqual(1)
  })
})
