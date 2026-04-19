import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-runtime-config-'))
  const file = path.join(dir, 'blackice.test.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

const tempDirs: string[] = []

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('getRuntimeConfig', () => {
  it('loads centralized runtime knobs from YAML', async () => {
    const configFile = writeConfig(`version: 1
server:
  port: 4010
readiness:
  timeoutMs: 25000
  strict: false
ops:
  enabled: true
  logBufferMaxEntries: 150

debate:
  maxConcurrent: 3
  modelAllowlist:
    - llama3.1:8b
    - qwen2.5:14b

ollama:
  baseUrl: http://127.0.0.1:11434
  model: qwen2.5:14b

loki:
  baseUrl: http://127.0.0.1:3100
  rulesFile: ./rules.yaml

limits:
  maxConcurrency: 7
marketData:
  discoveryBaseUrl: http://127.0.0.1:3101
  orderbookBaseUrl: http://127.0.0.1:3201
  maxCandidates: 40
  minLiquidityUsd: 250
  minDepthUsd: 125
  maxSpreadBps: 120
  excludedEventTypes:
    - sports
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
    - sandbox
  requirePreflight: false
  maxPositionUsd: 2500
  signerKind: backend
  storageKind: sqlite
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(getRuntimeConfig()).toMatchObject({
      server: { port: 4010 },
      readiness: { timeoutMs: 10000, strict: false },
      ops: { enabled: true, logBufferMaxEntries: 150 },
      debate: {
        maxConcurrent: 3,
        modelAllowlist: ['llama3.1:8b', 'qwen2.5:14b'],
      },
      marketData: {
        discoveryBaseUrl: 'http://127.0.0.1:3101',
        orderbookBaseUrl: 'http://127.0.0.1:3201',
        maxCandidates: 40,
        minLiquidityUsd: 250,
        minDepthUsd: 125,
        maxSpreadBps: 120,
        excludedEventTypes: ['sports'],
      },
      execution: {
        defaultVenue: 'paper',
        allowedVenues: ['paper', 'sandbox'],
        requirePreflight: false,
        maxPositionUsd: 2500,
        signerKind: 'backend',
        storageKind: 'sqlite',
      },
      limits: { maxConcurrency: 7 },
    })
  })

  it('fills defaults for the new market data and execution sections', async () => {
    const configFile = writeConfig(`version: 1
server:
  port: 3000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(getRuntimeConfig()).toMatchObject({
      marketData: {
        discoveryBaseUrl: '',
        orderbookBaseUrl: '',
        maxCandidates: 25,
        minLiquidityUsd: 0,
        minDepthUsd: 0,
        maxSpreadBps: 500,
        excludedEventTypes: [],
      },
      execution: {
        defaultVenue: 'paper',
        allowedVenues: ['paper'],
        requirePreflight: true,
        maxPositionUsd: 1000,
        signerKind: 'mock',
        storageKind: 'memory',
      },
    })
  })
})
