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

function missingConfigPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-runtime-config-'))
  tempDirs.push(dir)
  return path.join(dir, 'missing.yaml')
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
  preflightMaxAgeSeconds: 120
  maxPositionUsd: 2500
  signerKind: backend
  storageKind: sqlite
  storagePath: ./.tmp/execution-state.json
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
        preflightMaxAgeSeconds: 120,
        maxPositionUsd: 2500,
        signerKind: 'backend',
        storageKind: 'sqlite',
        storagePath: './.tmp/execution-state.json',
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
        preflightMaxAgeSeconds: 300,
        maxPositionUsd: 1000,
        signerKind: 'mock',
        storageKind: 'memory',
        storagePath: '',
      },
    })
  })

  it('fills valid defaults when optional sections are missing', async () => {
    const configFile = writeConfig(`version: 1
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(getRuntimeConfig()).toMatchObject({
      server: { port: 3000 },
      readiness: { timeoutMs: 1500, strict: true },
      ops: { enabled: false, logBufferMaxEntries: 2000 },
      debate: {
        maxConcurrent: 1,
        modelAllowlist: ['llama3.1:8b', 'qwen2.5:14b', 'qwen2.5-coder:14b'],
      },
      ollama: {
        baseUrl: 'http://192.168.1.230:11434',
        model: 'qwen2.5:14b',
      },
      execution: {
        defaultVenue: 'paper',
        allowedVenues: ['paper'],
      },
    })
  })

  it('aligns default allowed venues with a configured default venue', async () => {
    const configFile = writeConfig(`version: 1
execution:
  defaultVenue: sandbox
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(getRuntimeConfig()).toMatchObject({
      execution: {
        defaultVenue: 'sandbox',
        allowedVenues: ['sandbox'],
        storagePath: '',
      },
    })
  })

  it('reports YAML parse failures with the selected config file path', async () => {
    const configFile = writeConfig(`version: [
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(() => getRuntimeConfig()).toThrow(`Invalid config file ${configFile}: YAML parse error:`)
  })

  it('reports schema validation failures with field paths', async () => {
    const configFile = writeConfig(`version: 1
ops:
  logBufferMaxEntries: 10
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(() => getRuntimeConfig()).toThrow(/ops\.logBufferMaxEntries:/)
  })

  it('rejects unknown top-level config keys with a root-level message', async () => {
    const configFile = writeConfig(`version: 1
unexpected: true
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(() => getRuntimeConfig()).toThrow(/<root>: Unrecognized key/)
  })

  it('rejects empty execution venue allowlists after normalization', async () => {
    const configFile = writeConfig(`version: 1
execution:
  allowedVenues: []
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(() => getRuntimeConfig()).toThrow(/execution\.allowedVenues:/)
  })

  it('fails when BLACKICE_CONFIG_FILE selects a missing file', async () => {
    const configFile = missingConfigPath()

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { getRuntimeConfig } = await import('./config/runtimeConfig.js')

    expect(() => getRuntimeConfig()).toThrow(`Config file not found: ${configFile}`)
  })
})
