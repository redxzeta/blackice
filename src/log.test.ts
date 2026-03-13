import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const tempDirs: string[] = []

function writeConfig(logBufferMaxEntries: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-log-test-'))
  const file = path.join(dir, 'blackice.test.yaml')
  writeFileSync(
    file,
    `version: 1
ops:
  logBufferMaxEntries: ${logBufferMaxEntries}
ollama:
  baseUrl: http://127.0.0.1:11434
  model: qwen2.5:14b
`
  )
  tempDirs.push(dir)
  return file
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('log.ts', () => {
  it('stores logs in buffer and trims to configured max size', async () => {
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeConfig(100))
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
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeConfig(100))
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
