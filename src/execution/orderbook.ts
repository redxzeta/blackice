import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  OrderbookSnapshotSchema,
  type CandidateRecord,
  type OrderbookReadAdapter,
  type OrderbookSnapshot,
} from './contracts.js'

type OrderbookFetch = typeof fetch
type Clock = () => Date

type OrderbookAdapterOptions = {
  fetchImpl?: OrderbookFetch
  now?: Clock
}

type RawOrderbookPayload = Record<string, unknown>
type RawPriceLevel = {
  price: number
  size: number
}

export class OrderbookAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderbookAdapterError'
  }
}

export class PublicOrderbookReadAdapter implements OrderbookReadAdapter {
  private readonly fetchImpl: OrderbookFetch
  private readonly now: Clock

  constructor(options: OrderbookAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getSnapshot(candidate: CandidateRecord): Promise<OrderbookSnapshot> {
    const runtimeConfig = getRuntimeConfig()
    const orderbookBaseUrl = runtimeConfig.marketData.orderbookBaseUrl.trim()

    if (!orderbookBaseUrl) {
      throw new OrderbookAdapterError('marketData.orderbookBaseUrl is not configured')
    }

    const response = await this.fetchImpl(buildOrderbookUrl(orderbookBaseUrl, candidate))
    if (!response.ok) {
      throw new OrderbookAdapterError(
        `Orderbook request failed with status ${response.status} ${response.statusText}`
      )
    }

    const payload = await response.json()
    const orderbookPayload = extractOrderbookPayload(payload)
    const timestamp = resolveSnapshotTimestamp(orderbookPayload, this.now)
    const bids = parseSideLevels(orderbookPayload, 'bids')
    const asks = parseSideLevels(orderbookPayload, 'asks')

    return buildSnapshot(bids, asks, timestamp)
  }
}

function buildOrderbookUrl(baseUrl: string, candidate: CandidateRecord): string {
  const url = new URL(baseUrl)
  url.searchParams.set('marketId', candidate.marketId)
  url.searchParams.set('eventId', candidate.eventId)
  return url.toString()
}

function extractOrderbookPayload(payload: unknown): RawOrderbookPayload {
  if (!isRecord(payload)) {
    throw new OrderbookAdapterError('Orderbook response must be an object payload')
  }

  const nested = payload.orderbook
  if (isRecord(nested)) {
    return nested
  }

  if ('bids' in payload || 'asks' in payload) {
    return payload
  }

  throw new OrderbookAdapterError('Orderbook response did not contain bid/ask data')
}

function parseSideLevels(payload: RawOrderbookPayload, side: 'bids' | 'asks'): RawPriceLevel[] {
  const rawLevels = payload[side]
  if (rawLevels === undefined) {
    return []
  }

  if (!Array.isArray(rawLevels)) {
    throw new OrderbookAdapterError(`Orderbook ${side} must be an array`)
  }

  return rawLevels
    .map((level) => parsePriceLevel(level, side))
    .filter((level): level is RawPriceLevel => level !== null)
}

function parsePriceLevel(level: unknown, side: 'bids' | 'asks'): RawPriceLevel | null {
  if (Array.isArray(level)) {
    const [priceValue, sizeValue] = level
    return normalizePriceLevel(priceValue, sizeValue, side)
  }

  if (isRecord(level)) {
    return normalizePriceLevel(
      firstDefined(level.price, level.p),
      firstDefined(level.size, level.quantity, level.amount, level.shares, level.q),
      side
    )
  }

  throw new OrderbookAdapterError(`Orderbook ${side} level must be an array or object`)
}

function normalizePriceLevel(
  priceValue: unknown,
  sizeValue: unknown,
  side: 'bids' | 'asks'
): RawPriceLevel | null {
  const price = parseFiniteNumber(priceValue)
  const size = parseFiniteNumber(sizeValue)

  if (price === null || size === null) {
    return null
  }

  if (price < 0 || size < 0) {
    throw new OrderbookAdapterError(`Orderbook ${side} level values must be non-negative`)
  }

  if (size === 0) {
    return null
  }

  return { price, size }
}

function buildSnapshot(
  bids: RawPriceLevel[],
  asks: RawPriceLevel[],
  asOf: string
): OrderbookSnapshot {
  const bestBid = selectBestPrice(bids, 'bids')
  const bestAsk = selectBestPrice(asks, 'asks')
  const spreadBps =
    bestBid === null || bestAsk === null || bestAsk === 0
      ? null
      : roundToBasisPoints(((bestAsk - bestBid) / bestAsk) * 10_000)
  const depthUsd = roundToCents(computeDepthUsd(bids) + computeDepthUsd(asks))

  return OrderbookSnapshotSchema.parse({
    bestBid,
    bestAsk,
    spreadBps,
    depthUsd,
    asOf,
  })
}

function selectBestPrice(levels: RawPriceLevel[], side: 'bids' | 'asks'): number | null {
  if (levels.length === 0) {
    return null
  }

  const prices = levels.map((level) => level.price)
  const bestPrice = side === 'bids' ? Math.max(...prices) : Math.min(...prices)
  return roundToPrice(bestPrice)
}

function computeDepthUsd(levels: RawPriceLevel[]): number {
  return levels.reduce((sum, level) => sum + level.price * level.size, 0)
}

function resolveSnapshotTimestamp(payload: RawOrderbookPayload, now: Clock): string {
  for (const key of ['asOf', 'as_of', 'timestamp', 'updatedAt', 'updated_at']) {
    const rawValue = payload[key]
    const timestamp = parseTimestamp(rawValue)
    if (timestamp) {
      return timestamp
    }
  }

  return now().toISOString()
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return null
  }

  return timestamp.toISOString()
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function roundToPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100
}

function roundToBasisPoints(value: number): number {
  return Math.round(value * 100) / 100
}
