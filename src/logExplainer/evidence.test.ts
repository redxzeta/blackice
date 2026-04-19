import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function writeRuntimeConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-evidence-test-'))
  const configFile = path.join(dir, 'blackice.test.yaml')
  const rulesFile = path.join(dir, 'loki-rules.yaml')

  writeFileSync(
    configFile,
    `version: 1
loki:
  baseUrl: http://127.0.0.1:3100
  rulesFile: ./loki-rules.yaml
`
  )
writeFileSync(
    rulesFile,
    `allowedLabels:
  - job
  - host
  - unit
  - app
hosts:
  - node-1
`
  )

  tempDirs.push(dir)
  return configFile
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('log explainer evidence', () => {
  it('samples the newest lines, redacts secrets, and truncates long evidence', async () => {
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeRuntimeConfig())
    const { buildEvidence } = await import('./evidence.js')

    const evidence = buildEvidence(
      [
        '2026-04-18T12:00:00Z old line',
        '1744987200000000000 authorization: Bearer abc123',
        'x'.repeat(2100),
      ].join('\n'),
      2
    )

    expect(evidence).toHaveLength(2)
    expect(evidence?.[0]).toEqual({
      ts: '1744987200000000000',
      line: 'authorization: Bearer [REDACTED]',
    })
    expect(evidence?.[1].ts).toBe('')
    expect(evidence?.[1].line.startsWith('x'.repeat(2000))).toBe(true)
    expect(evidence?.[1].line.endsWith(' [truncated]')).toBe(true)
  })
})
