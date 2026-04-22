import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CandidateDiscoveryAdapter,
  CandidateRecord,
  OrderbookReadAdapter,
  OrderbookSnapshot,
} from './contracts.js'

const tempDirs: string[] = []

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-enrichment-config-'))
  const file = path.join(dir, 'blackice.enrichment.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

function buildCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    marketId: 'market-1',
    eventId: 'event-1',
    slug: 'btc-above-100k',
    question: 'Will BTC close above 100k?',
    marketType: 'standard',
    tradable: true,
    metadataComplete: true,
    tags: [],
    ...overrides,
  }
}

function buildSnapshot(overrides: Partial<OrderbookSnapshot> = {}): OrderbookSnapshot {
  return {
    bestBid: 0.46,
    bestAsk: 0.5,
    spreadBps: 800,
    depthUsd: 2_500,
    asOf: '2026-04-22T01:45:00.000Z',
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

describe('CandidateEnrichmentPipeline', () => {
  it('builds eligible enriched candidates and preserves discovery order', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 1000
  maxSpreadBps: 1000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidateEnrichmentPipeline } = await import('./enrichment.js')
    const discoveryAdapter: CandidateDiscoveryAdapter = {
      listCandidates: vi.fn().mockResolvedValue([
        buildCandidate({
          marketId: 'market-1',
          eventId: 'event-1',
          slug: 'one',
          question: 'One?',
        }),
        buildCandidate({
          marketId: 'market-2',
          eventId: 'event-2',
          slug: 'two',
          question: 'Two?',
        }),
      ]),
    }
    const orderbookAdapter: OrderbookReadAdapter = {
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce(
          buildSnapshot({
            bestBid: 0.4,
            bestAsk: 0.5,
            spreadBps: 2000,
            depthUsd: 1500,
          })
        )
        .mockResolvedValueOnce(
          buildSnapshot({
            bestBid: 0.48,
            bestAsk: 0.5,
            spreadBps: 400,
            depthUsd: 2000,
          })
        ),
    }

    const pipeline = new CandidateEnrichmentPipeline({ discoveryAdapter, orderbookAdapter })
    const enrichedCandidates = await pipeline.listEnrichedCandidates({ limit: 2 })

    expect(discoveryAdapter.listCandidates).toHaveBeenCalledWith({ limit: 2 })
    expect(enrichedCandidates.map((candidate) => candidate.marketId)).toEqual([
      'market-1',
      'market-2',
    ])
    expect(enrichedCandidates[0]).toMatchObject({
      qualificationStatus: 'filtered',
      qualificationReasons: ['spread_above_limit'],
      impliedProbability: 0.45,
    })
    expect(enrichedCandidates[1]).toMatchObject({
      qualificationStatus: 'eligible',
      qualificationReasons: [],
      impliedProbability: 0.49,
    })
  })

  it('marks candidates as blocked when tradability or metadata is missing', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 0
  maxSpreadBps: 1000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidateEnrichmentPipeline } = await import('./enrichment.js')
    const discoveryAdapter: CandidateDiscoveryAdapter = {
      listCandidates: vi.fn().mockResolvedValue([
        buildCandidate({
          marketId: 'market-3',
          eventId: 'event-3',
          slug: 'blocked',
          question: 'Blocked?',
          tradable: false,
          metadataComplete: false,
        }),
      ]),
    }
    const orderbookAdapter: OrderbookReadAdapter = {
      getSnapshot: vi.fn().mockResolvedValue(buildSnapshot()),
    }

    const pipeline = new CandidateEnrichmentPipeline({ discoveryAdapter, orderbookAdapter })
    const [enrichedCandidate] = await pipeline.listEnrichedCandidates({})

    expect(enrichedCandidate).toMatchObject({
      qualificationStatus: 'blocked',
      qualificationReasons: ['candidate_not_tradable', 'metadata_incomplete'],
      impliedProbability: 0.48,
    })
  })

  it('flags low-depth books and returns null implied probability for out-of-range prices', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  minDepthUsd: 500
  maxSpreadBps: 1000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { CandidateEnrichmentPipeline } = await import('./enrichment.js')
    const discoveryAdapter: CandidateDiscoveryAdapter = {
      listCandidates: vi
        .fn()
        .mockResolvedValue([buildCandidate({ marketId: 'market-4', eventId: 'event-4' })]),
    }
    const orderbookAdapter: OrderbookReadAdapter = {
      getSnapshot: vi.fn().mockResolvedValue(
        buildSnapshot({
          bestBid: null,
          bestAsk: 1.25,
          spreadBps: null,
          depthUsd: 125,
        })
      ),
    }

    const pipeline = new CandidateEnrichmentPipeline({ discoveryAdapter, orderbookAdapter })
    const [enrichedCandidate] = await pipeline.listEnrichedCandidates({})

    expect(enrichedCandidate).toMatchObject({
      qualificationStatus: 'filtered',
      qualificationReasons: ['depth_below_minimum'],
      impliedProbability: null,
    })
  })
})
