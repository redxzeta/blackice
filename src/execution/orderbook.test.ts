import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-orderbook-config-'))
  const file = path.join(dir, 'blackice.orderbook.yaml')
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

describe('PublicOrderbookReadAdapter', () => {
  it('normalizes best bid, best ask, spread, depth, and timestamp', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  orderbookBaseUrl: https://example.test/orderbook
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicOrderbookReadAdapter } = await import('./orderbook.js')
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        orderbook: {
          bids: [
            { price: '0.42', size: '100' },
            { price: '0.41', size: 80 },
          ],
          asks: [
            { price: 0.47, size: 110 },
            { price: 0.49, size: 50 },
          ],
          updated_at: '2026-04-21T18:30:00Z',
        },
      })
    )

    const adapter = new PublicOrderbookReadAdapter({ fetchImpl })
    const result = await adapter.getSnapshot({
      marketId: 'market-1',
      eventId: 'event-1',
      slug: 'btc-above-100k',
      question: 'Will BTC close above 100k?',
      marketType: 'standard',
      tradable: true,
      metadataComplete: true,
      tags: [],
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/orderbook?marketId=market-1&eventId=event-1'
    )
    expect(result).toEqual({
      bestBid: 0.42,
      bestAsk: 0.47,
      spreadBps: 1063.83,
      depthUsd: 151,
      asOf: '2026-04-21T18:30:00.000Z',
    })
  })

  it('returns null best prices and zero depth for an empty book', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  orderbookBaseUrl: https://example.test/orderbook
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicOrderbookReadAdapter } = await import('./orderbook.js')
    const adapter = new PublicOrderbookReadAdapter({
      fetchImpl: vi.fn().mockResolvedValue(createJsonResponse({ bids: [], asks: [] })),
      now: () => new Date('2026-04-21T20:00:00.000Z'),
    })

    await expect(
      adapter.getSnapshot({
        marketId: 'market-2',
        eventId: 'event-2',
        slug: 'empty',
        question: 'Empty?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).resolves.toEqual({
      bestBid: null,
      bestAsk: null,
      spreadBps: null,
      depthUsd: 0,
      asOf: '2026-04-21T20:00:00.000Z',
    })
  })

  it('handles missing sides by preserving the available best price and null spread', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  orderbookBaseUrl: https://example.test/orderbook
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicOrderbookReadAdapter } = await import('./orderbook.js')
    const adapter = new PublicOrderbookReadAdapter({
      fetchImpl: vi.fn().mockResolvedValue(
        createJsonResponse({
          bids: [[0.44, 150]],
        })
      ),
      now: () => new Date('2026-04-21T20:05:00.000Z'),
    })

    await expect(
      adapter.getSnapshot({
        marketId: 'market-3',
        eventId: 'event-3',
        slug: 'bid-only',
        question: 'Bid only?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).resolves.toEqual({
      bestBid: 0.44,
      bestAsk: null,
      spreadBps: null,
      depthUsd: 66,
      asOf: '2026-04-21T20:05:00.000Z',
    })
  })

  it('ignores malformed levels with missing numeric values but rejects malformed side containers', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  orderbookBaseUrl: https://example.test/orderbook
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicOrderbookReadAdapter, OrderbookAdapterError } = await import('./orderbook.js')
    const adapter = new PublicOrderbookReadAdapter({
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            bids: [
              { price: 'oops', size: 100 },
              { price: 0.4, size: 50 },
            ],
            asks: [
              { price: 0.45, size: 20 },
              { price: 0.5, size: 0 },
            ],
          })
        )
        .mockResolvedValueOnce(createJsonResponse({ bids: 'bad-side', asks: [] })),
      now: () => new Date('2026-04-21T20:10:00.000Z'),
    })

    await expect(
      adapter.getSnapshot({
        marketId: 'market-4',
        eventId: 'event-4',
        slug: 'mixed-levels',
        question: 'Mixed levels?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).resolves.toEqual({
      bestBid: 0.4,
      bestAsk: 0.45,
      spreadBps: 1111.11,
      depthUsd: 29,
      asOf: '2026-04-21T20:10:00.000Z',
    })

    await expect(
      adapter.getSnapshot({
        marketId: 'market-5',
        eventId: 'event-5',
        slug: 'bad-side',
        question: 'Bad side?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).rejects.toThrow(OrderbookAdapterError)
  })

  it('rejects malformed payloads and surfaces upstream failures clearly', async () => {
    const configFile = writeConfig(`version: 1
marketData:
  orderbookBaseUrl: https://example.test/orderbook
`)

    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)
    const { PublicOrderbookReadAdapter, OrderbookAdapterError } = await import('./orderbook.js')
    const adapter = new PublicOrderbookReadAdapter({
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(createJsonResponse('bad-payload'))
        .mockResolvedValueOnce(
          createJsonResponse({}, { ok: false, status: 502, statusText: 'Bad Gateway' })
        ),
    })

    await expect(
      adapter.getSnapshot({
        marketId: 'market-6',
        eventId: 'event-6',
        slug: 'bad-payload',
        question: 'Bad payload?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).rejects.toThrow(OrderbookAdapterError)

    await expect(
      adapter.getSnapshot({
        marketId: 'market-7',
        eventId: 'event-7',
        slug: 'upstream-fail',
        question: 'Upstream fail?',
        marketType: 'standard',
        tradable: true,
        metadataComplete: true,
        tags: [],
      })
    ).rejects.toThrow('Orderbook request failed with status 502 Bad Gateway')
  })
})
