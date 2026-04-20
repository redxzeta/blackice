import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-discovery-config-'))
  const file = path.join(dir, 'blackice.discovery.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

function createJsonResponse(
  payload: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string }
) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    json: async () => payload,
  } as Response
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

describe('PublicCandidateDiscoveryAdapter', () => {
  it('normalizes valid records into candidate records', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
  maxCandidates: 10
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        markets: [
          {
            id: 'market-1',
            event_id: 'event-1',
            slug: 'btc-above-100k',
            question: 'Will BTC close above 100k?',
            category: 'binary',
            tradable: true,
            tags: ['macro'],
            end_date: '2026-12-31T00:00:00Z',
          },
        ],
      })
    )

    const adapter = new PublicCandidateDiscoveryAdapter({ fetchImpl })
    const result = await adapter.listCandidates({})

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/discovery?limit=10')
    expect(result).toEqual([
      {
        marketId: 'market-1',
        eventId: 'event-1',
        slug: 'btc-above-100k',
        question: 'Will BTC close above 100k?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        endDate: '2026-12-31T00:00:00.000Z',
        tags: ['macro'],
      },
    ])
  })

  it('filters incomplete and excluded event types', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
  maxCandidates: 10
  excludedEventTypes:
    - sports
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 'market-1',
          event_id: 'event-1',
          slug: 'nba-finals',
          question: 'Will team A win?',
          category: 'sports',
          tradable: true,
        },
        {
          id: 'market-2',
          event_id: 'event-2',
          slug: 'missing-question',
          category: 'standard',
          tradable: true,
        },
        {
          id: 'market-3',
          event_id: 'event-3',
          slug: 'valid-market',
          question: 'Will CPI fall next month?',
          category: 'election',
          tradable: true,
        },
      ])
    )

    const adapter = new PublicCandidateDiscoveryAdapter({ fetchImpl })
    const result = await adapter.listCandidates({})

    expect(result).toEqual([
      {
        marketId: 'market-3',
        eventId: 'event-3',
        slug: 'valid-market',
        question: 'Will CPI fall next month?',
        marketType: 'election',
        tradable: true,
        metadataComplete: true,
        tags: [],
      },
    ])
  })

  it('clamps the requested limit to the configured maximum and preserves order', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
  maxCandidates: 2
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        data: [
          {
            id: 'market-1',
            event_id: 'event-1',
            slug: 'one',
            question: 'One?',
            tradable: true,
          },
          {
            id: 'market-2',
            event_id: 'event-2',
            slug: 'two',
            question: 'Two?',
            tradable: true,
          },
          {
            id: 'market-3',
            event_id: 'event-3',
            slug: 'three',
            question: 'Three?',
            tradable: true,
          },
        ],
      })
    )

    const adapter = new PublicCandidateDiscoveryAdapter({ fetchImpl })
    const result = await adapter.listCandidates({ limit: 25 })

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/discovery?limit=2')
    expect(result.map((candidate) => candidate.marketId)).toEqual(['market-1', 'market-2'])
  })

  it('rejects malformed payloads with a clear adapter error', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter, DiscoveryAdapterError } = await import(
      './discovery.js'
    )
    const adapter = new PublicCandidateDiscoveryAdapter({
      fetchImpl: vi.fn().mockResolvedValue(createJsonResponse('bad-payload')),
    })

    await expect(adapter.listCandidates({})).rejects.toThrow(DiscoveryAdapterError)
  })

  it('surfaces upstream fetch failures with a clear adapter error', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const adapter = new PublicCandidateDiscoveryAdapter({
      fetchImpl: vi
        .fn()
        .mockResolvedValue(createJsonResponse({}, { ok: false, status: 503, statusText: 'Down' })),
    })

    await expect(adapter.listCandidates({})).rejects.toThrow(
      'Discovery request failed with status 503 Down'
    )
  })

  it('supports query-level excluded event types and market type mapping edge cases', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  discoveryBaseUrl: https://example.test/discovery
  maxCandidates: 10
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const adapter = new PublicCandidateDiscoveryAdapter({
      fetchImpl: vi.fn().mockResolvedValue(
        createJsonResponse({
          items: [
            {
              id: 'market-1',
              event_id: 'event-1',
              slug: 'sports-tag',
              question: 'Will team A win?',
              tradable: true,
              tags: ['sports'],
            },
            {
              id: 'market-2',
              event_id: 'event-2',
              slug: 'politics-tag',
              question: 'Will candidate A win?',
              tradable: true,
              tags: ['politics'],
            },
            {
              id: 'market-3',
              event_id: 'event-3',
              slug: 'unknown-type',
              question: 'Will something happen?',
              tradable: true,
              category: 'novelty',
            },
          ],
        })
      ),
    })

    const result = await adapter.listCandidates({ excludedEventTypes: ['election'] })

    expect(result).toEqual([
      {
        marketId: 'market-1',
        eventId: 'event-1',
        slug: 'sports-tag',
        question: 'Will team A win?',
        marketType: 'sports',
        tradable: true,
        metadataComplete: true,
        tags: ['sports'],
      },
      {
        marketId: 'market-3',
        eventId: 'event-3',
        slug: 'unknown-type',
        question: 'Will something happen?',
        marketType: 'other',
        tradable: true,
        metadataComplete: true,
        tags: [],
      },
    ])
  })

  it('requires the discovery base URL to be configured', async () => {
    const configFile = writeConfig(`version: 1
server:
  port: 3000
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicCandidateDiscoveryAdapter } = await import('./discovery.js')
    const adapter = new PublicCandidateDiscoveryAdapter({
      fetchImpl: vi.fn(),
    })

    await expect(adapter.listCandidates({})).rejects.toThrow(
      'marketData.discoveryBaseUrl is not configured'
    )
  })
})
