import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRequest } from './contracts.js'
import {
  BackendSigningAdapter,
  EnvironmentSigningCredentialsProvider,
  MockSigningAdapter,
  SigningAdapterError,
  canonicalizeExecutionRequest,
  createSigningAdapter,
} from './signing.js'

const tempDirs: string[] = []

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-signing-config-'))
  const file = path.join(dir, 'blackice.test.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

function buildExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: 'req-149',
    intentId: 'intent-149',
    venue: 'paper',
    marketId: 'market-149',
    side: 'buy',
    quantity: 12,
    limitPrice: 0.47,
    executionMode: 'taker',
    submittedAt: '2026-04-21T16:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('signing adapters', () => {
  it('signs execution requests with backend credentials without leaking secrets', async () => {
    const adapter = new BackendSigningAdapter({
      credentialsProvider: {
        async getCredentials() {
          return {
            signerRef: 'backend-signer-1',
            secret: 'super-secret-key',
          }
        },
      },
    })

    const signed = await adapter.signExecutionRequest(buildExecutionRequest())

    expect(signed).toMatchObject({
      signerRef: 'backend-signer-1',
      requestId: 'req-149',
      intentId: 'intent-149',
    })
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(signed)).not.toContain('super-secret-key')
  })

  it('creates deterministic mock signatures from the canonical request', async () => {
    const adapter = new MockSigningAdapter()
    const request = buildExecutionRequest()

    const first = await adapter.signExecutionRequest(request)
    const second = await adapter.signExecutionRequest(request)

    expect(first).toEqual(second)
    expect(first.signerRef).toBe('mock:paper')
    expect(first.signature).toMatch(/^mock:[a-f0-9]{64}$/)
  })

  it('reads backend credentials from environment variables', async () => {
    vi.stubEnv('BLACKICE_EXECUTION_SIGNER_REF', 'env-signer')
    vi.stubEnv('BLACKICE_EXECUTION_SIGNING_SECRET', 'env-secret')
    const provider = new EnvironmentSigningCredentialsProvider()

    await expect(provider.getCredentials()).resolves.toEqual({
      signerRef: 'env-signer',
      secret: 'env-secret',
    })
  })

  it('fails clearly when backend signing credentials are missing', async () => {
    const provider = new EnvironmentSigningCredentialsProvider()

    await expect(provider.getCredentials()).rejects.toThrow(SigningAdapterError)
    await expect(provider.getCredentials()).rejects.toThrow(
      'BLACKICE_EXECUTION_SIGNER_REF is required for backend signing'
    )
  })

  it('creates a backend adapter from runtime config when signerKind=backend', async () => {
    const configFile = writeConfig(`version: 1
execution:
  signerKind: backend
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    vi.stubEnv('BLACKICE_EXECUTION_SIGNER_REF', 'runtime-signer')
    vi.stubEnv('BLACKICE_EXECUTION_SIGNING_SECRET', 'runtime-secret')

    const { createSigningAdapter: createFromModule } = await import('./signing.js')
    const adapter = createFromModule()
    const signed = await adapter.signExecutionRequest(buildExecutionRequest())

    expect(signed.signerRef).toBe('runtime-signer')
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects unsupported signer kinds', () => {
    expect(() => createSigningAdapter({ signerKind: 'remote-kms' })).toThrow(
      'Unsupported execution.signerKind: remote-kms'
    )
  })

  it('canonicalizes requests with explicit field ordering', () => {
    const canonical = canonicalizeExecutionRequest(
      buildExecutionRequest({
        limitPrice: undefined,
      })
    )

    expect(canonical).toBe(
      JSON.stringify({
        requestId: 'req-149',
        intentId: 'intent-149',
        venue: 'paper',
        marketId: 'market-149',
        side: 'buy',
        quantity: 12,
        limitPrice: null,
        executionMode: 'taker',
        submittedAt: '2026-04-21T16:00:00.000Z',
      })
    )
  })
})
