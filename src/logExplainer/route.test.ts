import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function writeRuntimeConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-log-route-test-'))
  const configFile = path.join(dir, 'blackice.test.yaml')

  writeFileSync(
    configFile,
    `version: 1
loki:
  baseUrl: ''
`
  )

  tempDirs.push(dir)
  return configFile
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.stubEnv('BLACKICE_CONFIG_FILE', writeRuntimeConfig())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('log explainer route helpers', () => {
  it('resolves legacy batch flags without overriding explicit mode', async () => {
    const { resolveBatchMode } = await import('./route.js')

    expect(resolveBatchMode({})).toEqual({ mode: 'analyze', legacyCollectOnly: false })
    expect(resolveBatchMode({ analyze: false })).toEqual({
      mode: 'raw',
      legacyCollectOnly: true,
    })
    expect(resolveBatchMode({ collectOnly: true })).toEqual({
      mode: 'raw',
      legacyCollectOnly: true,
    })
    expect(resolveBatchMode({ mode: 'both', analyze: false, collectOnly: true })).toEqual({
      mode: 'both',
      legacyCollectOnly: false,
    })
  })

  it('only enables evidence defaults for raw or both batch modes', async () => {
    const { BATCH_EVIDENCE_LINES_DEFAULT } = await import('./schema.js')
    const { resolveEvidenceLinesForMode } = await import('./route.js')

    expect(resolveEvidenceLinesForMode('analyze', undefined)).toBeUndefined()
    expect(resolveEvidenceLinesForMode('raw', undefined)).toBe(BATCH_EVIDENCE_LINES_DEFAULT)
    expect(resolveEvidenceLinesForMode('both', undefined)).toBe(BATCH_EVIDENCE_LINES_DEFAULT)
    expect(resolveEvidenceLinesForMode('raw', 3)).toBe(3)
    expect(resolveEvidenceLinesForMode('both', 4)).toBe(4)
  })
})
