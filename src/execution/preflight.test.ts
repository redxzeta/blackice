import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedCandidateRecord, PreflightRequest, SigningAdapter } from './contracts.js'

const tempDirs: string[] = []

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-preflight-config-'))
  const file = path.join(dir, 'blackice.preflight.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

function buildCandidate(overrides: Partial<EnrichedCandidateRecord> = {}): EnrichedCandidateRecord {
  return {
    marketId: 'market-147',
    eventId: 'event-147',
    slug: 'btc-above-150k',
    question: 'Will BTC close above 150k?',
    marketType: 'standard',
    tradable: true,
    metadataComplete: true,
    tags: [],
    qualificationStatus: 'eligible',
    qualificationReasons: [],
    orderbook: {
      bestBid: 0.47,
      bestAsk: 0.49,
      spreadBps: 408.16,
      depthUsd: 2_000,
      asOf: '2026-04-23T01:00:00.000Z',
    },
    impliedProbability: 0.48,
    ...overrides,
  }
}

function buildPreflightRequest(overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    candidate: buildCandidate(),
    venue: 'paper',
    positionUsd: 250,
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

describe('CandidatePreflightEngine', () => {
  it('passes all checks for an eligible candidate with an available signer', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 1000
  maxSpreadBps: 500
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 1000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidatePreflightEngine } = await import('./preflight.js')
    const signingAdapter: SigningAdapter = {
      async signExecutionRequest(request) {
        return {
          ...request,
          signerRef: 'mock:paper',
          signature: 'sig-147',
        }
      },
    }

    const engine = new CandidatePreflightEngine({
      signingAdapter,
      now: () => new Date('2026-04-23T01:05:00.000Z'),
    })
    const result = await engine.evaluate({
      candidate: buildCandidate(),
      positionUsd: 250,
    })

    expect(result.ok).toBe(true)
    expect(result.venue).toBe('paper')
    expect(result.checks.every((check) => check.ok)).toBe(true)
  })

  it('returns deterministic failures for candidate quality and position limits', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 1000
  maxSpreadBps: 300
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 500
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidatePreflightEngine } = await import('./preflight.js')
    const engine = new CandidatePreflightEngine({
      signingAdapter: {
        async signExecutionRequest(request) {
          return {
            ...request,
            signerRef: 'mock:paper',
            signature: 'sig-147',
          }
        },
      },
      now: () => new Date('2026-04-23T01:10:00.000Z'),
    })

    const result = await engine.evaluate({
      candidate: buildCandidate({
        tradable: false,
        metadataComplete: false,
        qualificationStatus: 'blocked',
        qualificationReasons: ['candidate_not_tradable', 'metadata_incomplete'],
        orderbook: {
          bestBid: null,
          bestAsk: 0.49,
          spreadBps: 800,
          depthUsd: 125,
          asOf: '2026-04-23T01:09:00.000Z',
        },
        impliedProbability: 0.49,
      }),
      positionUsd: 750,
    })

    expect(result.ok).toBe(false)
    expect(result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      'candidate_not_tradable',
      'metadata_incomplete',
      'spread_above_limit',
      'depth_below_minimum',
      'position_above_limit',
    ])
  })

  it('fails venue and signing checks when the venue is disallowed or signing setup is broken', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 0
  maxSpreadBps: 500
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 1000
  signerKind: backend
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidatePreflightEngine } = await import('./preflight.js')
    const engine = new CandidatePreflightEngine({
      now: () => new Date('2026-04-23T01:15:00.000Z'),
    })

    const result = await engine.evaluate({
      candidate: buildCandidate(),
      venue: 'live',
      positionUsd: 100,
    })

    expect(result.ok).toBe(false)
    expect(result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      'venue_not_allowed',
      'signing_unavailable',
    ])
    expect(result.checks.find((check) => check.code === 'signing_unavailable')?.message).toContain(
      'BLACKICE_EXECUTION_SIGNER_REF is required for backend signing'
    )
  })

  it('turns unsupported signer kinds into a failed signing check instead of throwing', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 0
  maxSpreadBps: 500
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 1000
  signerKind: remote-kms
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidatePreflightEngine } = await import('./preflight.js')
    const engine = new CandidatePreflightEngine({
      now: () => new Date('2026-04-23T01:20:00.000Z'),
    })

    const result = await engine.evaluate({
      candidate: buildCandidate(),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.code === 'signing_unavailable')?.message).toContain(
      'Unsupported execution.signerKind: remote-kms'
    )
  })

  it('computes stable policy fingerprints and changes them when config changes', async () => {
    const firstConfigFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 1000
  maxSpreadBps: 500
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 1000
  signerKind: mock
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', firstConfigFile)
    const { computePreflightPolicyFingerprint } = await import('./preflight.js')
    const firstFingerprint = computePreflightPolicyFingerprint(buildPreflightRequest())
    const secondFingerprint = computePreflightPolicyFingerprint(buildPreflightRequest())

    expect(firstFingerprint).toBe(secondFingerprint)

    vi.resetModules()
    const secondConfigFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 1500
  maxSpreadBps: 500
execution:
  defaultVenue: paper
  allowedVenues:
    - paper
  maxPositionUsd: 1000
  signerKind: mock
`)
    vi.stubEnv('BLACKICE_CONFIG_FILE', secondConfigFile)

    const { computePreflightPolicyFingerprint: computeWithChangedConfig } = await import(
      './preflight.js'
    )
    const changedFingerprint = computeWithChangedConfig(buildPreflightRequest())

    expect(changedFingerprint).not.toBe(firstFingerprint)
  })
})
