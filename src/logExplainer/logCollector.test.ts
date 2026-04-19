import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function writeRuntimeConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-loki-test-'))
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
units:
  - blackice.service
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('log explainer Loki helpers', () => {
  it('normalizes selectors, escapes filters, and returns sorted Loki output', async () => {
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeRuntimeConfig())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { unit: 'blackice.service', host: 'node-1' },
                values: [
                  ['2000000', 'second'],
                  ['1000000', 'first'],
                ],
              },
            ],
          },
        }),
      })
    )

    const { buildEffectiveLokiQuery, collectLokiBatchLogs } = await import('./logCollector.js')

    expect(
      buildEffectiveLokiQuery({
        source: 'loki',
        filters: { job: 'blackice', host: 'node-1', app: 'api' },
        contains: 'foo "bar" \\ baz',
        regex: 'error\\d+',
      })
    ).toBe('{app="api",host="node-1",job="blackice"} |= "foo \\"bar\\" \\\\ baz" |~ "error\\\\d+"')

    const result = await collectLokiBatchLogs({
      source: 'loki',
      filters: { job: 'blackice', host: 'node-1', app: 'api' },
      contains: 'hello',
      limit: 10,
    })

    expect(result.query).toBe('{app="api",host="node-1",job="blackice"} |= "hello"')
    expect(result.logs).toContain(
      '1970-01-01T00:00:00.001Z [host=node-1,unit=blackice.service] first'
    )
    expect(result.logs).toContain(
      '1970-01-01T00:00:00.002Z [host=node-1,unit=blackice.service] second'
    )
  })

  it('rejects unscoped Loki filters before issuing a query', async () => {
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeRuntimeConfig())
    const { collectLokiBatchLogs } = await import('./logCollector.js')

    await expect(
      collectLokiBatchLogs({
        source: 'loki',
        filters: { job: 'blackice', app: 'api' },
        limit: 10,
      })
    ).rejects.toThrow('Loki query must include host or unit label')
  })

  it('resolves sinceSeconds windows from the current clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'))
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeRuntimeConfig())
    const { resolveLokiTimeRange } = await import('./logCollector.js')

    const range = resolveLokiTimeRange({ sinceSeconds: 90 })

    expect(range.hours).toBeCloseTo(0.025, 6)
    expect(BigInt(range.endNs) - BigInt(range.startNs)).toBe(90_000_000_000n)
  })
})
