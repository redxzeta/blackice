import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  CandidateRecordSchema,
  type CandidateDiscoveryAdapter,
  type CandidateDiscoveryQuery,
  type CandidateRecord,
  MarketTypeSchema,
} from './contracts.js'

type DiscoveryFetch = typeof fetch

type DiscoveryAdapterOptions = {
  fetchImpl?: DiscoveryFetch
}

type RawDiscoveryRecord = Record<string, unknown>
type MarketType = 'standard' | 'sports' | 'election' | 'other'

export class DiscoveryAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoveryAdapterError'
  }
}

export class PublicCandidateDiscoveryAdapter implements CandidateDiscoveryAdapter {
  private readonly fetchImpl: DiscoveryFetch

  constructor(options: DiscoveryAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async listCandidates(query: CandidateDiscoveryQuery = {}): Promise<CandidateRecord[]> {
    const runtimeConfig = getRuntimeConfig()
    const discoveryBaseUrl = runtimeConfig.marketData.discoveryBaseUrl.trim()

    if (!discoveryBaseUrl) {
      throw new DiscoveryAdapterError('marketData.discoveryBaseUrl is not configured')
    }

    const effectiveLimit = resolveEffectiveLimit(
      query.limit,
      runtimeConfig.marketData.maxCandidates
    )
    const excludedEventTypes = resolveExcludedEventTypes(
      runtimeConfig.marketData.excludedEventTypes,
      query.excludedEventTypes ?? []
    )
    const endpoint = buildDiscoveryUrl(discoveryBaseUrl, effectiveLimit)

    const response = await this.fetchImpl(endpoint)
    if (!response.ok) {
      throw new DiscoveryAdapterError(
        `Discovery request failed with status ${response.status} ${response.statusText}`
      )
    }

    const payload = await response.json()
    const rawRecords = extractDiscoveryRecords(payload)

    return rawRecords
      .map((rawRecord) => ({
        rawRecord,
        candidate: normalizeDiscoveryRecord(rawRecord),
      }))
      .filter(
        (result): result is { rawRecord: RawDiscoveryRecord; candidate: CandidateRecord } =>
          result.candidate !== null &&
          shouldIncludeCandidate(
            result.candidate,
            result.rawRecord,
            excludedEventTypes,
            runtimeConfig.marketData.minLiquidityUsd
          )
      )
      .map((result) => result.candidate)
      .slice(0, effectiveLimit)
  }
}

function resolveEffectiveLimit(
  requestedLimit: number | undefined,
  configuredLimit: number
): number {
  if (requestedLimit === undefined) {
    return configuredLimit
  }

  return Math.max(1, Math.min(requestedLimit, configuredLimit))
}

function resolveExcludedEventTypes(configured: string[], requested: MarketType[]): Set<MarketType> {
  const configuredTypes = configured
    .map((value) => MarketTypeSchema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data)

  return new Set<MarketType>([...configuredTypes, ...requested])
}

function buildDiscoveryUrl(baseUrl: string, limit: number): string {
  const url = new URL(baseUrl)
  url.searchParams.set('limit', String(limit))
  return url.toString()
}

function extractDiscoveryRecords(payload: unknown): RawDiscoveryRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord)
  }

  if (!isRecord(payload)) {
    throw new DiscoveryAdapterError('Discovery response must be an array or object payload')
  }

  for (const key of ['markets', 'events', 'items', 'data']) {
    const candidate = payload[key]
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord)
    }
  }

  throw new DiscoveryAdapterError('Discovery response did not contain a supported record list')
}

function normalizeDiscoveryRecord(rawRecord: RawDiscoveryRecord): CandidateRecord | null {
  const marketId = readString(rawRecord, ['marketId', 'market_id', 'id'])
  const eventId = readString(rawRecord, ['eventId', 'event_id'])
  const slug = readString(rawRecord, ['slug', 'marketSlug'])
  const question = readString(rawRecord, ['question', 'title', 'name'])

  if (!marketId || !eventId || !slug || !question) {
    return null
  }

  const marketType = inferMarketType(rawRecord)
  const tradable = inferTradable(rawRecord)
  const metadataComplete = inferMetadataComplete(rawRecord, {
    marketId,
    eventId,
    slug,
    question,
  })
  const endDate = readIsoDate(rawRecord, ['endDate', 'end_date', 'endTime', 'end_time'])
  const tags = readTags(rawRecord)

  return CandidateRecordSchema.parse({
    marketId,
    eventId,
    slug,
    question,
    marketType,
    tradable,
    metadataComplete,
    endDate,
    tags,
  })
}

function shouldIncludeCandidate(
  candidate: CandidateRecord,
  rawRecord: RawDiscoveryRecord,
  excludedEventTypes: Set<MarketType>,
  minLiquidityUsd: number
): boolean {
  if (!candidate.metadataComplete || !candidate.tradable) {
    return false
  }

  if (excludedEventTypes.has(candidate.marketType)) {
    return false
  }

  const liquidityUsd = readNumber(rawRecord, ['liquidityUsd', 'liquidity_usd', 'liquidity'])
  if (typeof liquidityUsd === 'number' && liquidityUsd < minLiquidityUsd) {
    return false
  }

  return true
}

function inferMarketType(rawRecord: RawDiscoveryRecord): MarketType {
  const explicitType = readString(rawRecord, ['marketType', 'market_type', 'type', 'category'])
  if (explicitType) {
    const normalized = explicitType.trim().toLowerCase()
    if (normalized.includes('sport')) {
      return 'sports'
    }
    if (normalized.includes('election') || normalized.includes('politic')) {
      return 'election'
    }
    if (normalized.includes('standard') || normalized.includes('binary')) {
      return 'standard'
    }
  }

  const tags = readTags(rawRecord).map((tag) => tag.toLowerCase())
  if (tags.some((tag) => tag.includes('sport'))) {
    return 'sports'
  }
  if (tags.some((tag) => tag.includes('election') || tag.includes('politic'))) {
    return 'election'
  }

  return explicitType ? 'other' : 'standard'
}

function inferTradable(rawRecord: RawDiscoveryRecord): boolean {
  const booleanCandidates = [
    readBoolean(rawRecord, ['tradable', 'isTradable']),
    readBoolean(rawRecord, ['active', 'isActive']),
    readBoolean(rawRecord, ['closed', 'isClosed']),
  ]

  if (booleanCandidates[0] !== undefined) {
    return booleanCandidates[0]
  }
  if (booleanCandidates[1] !== undefined) {
    return booleanCandidates[1]
  }
  if (booleanCandidates[2] !== undefined) {
    return !booleanCandidates[2]
  }

  return true
}

function inferMetadataComplete(
  rawRecord: RawDiscoveryRecord,
  requiredFields: {
    marketId: string
    eventId: string
    slug: string
    question: string
  }
): boolean {
  const explicit = readBoolean(rawRecord, ['metadataComplete', 'metadata_complete'])
  if (explicit !== undefined) {
    return explicit
  }

  return Object.values(requiredFields).every((value) => value.trim().length > 0)
}

function readString(rawRecord: RawDiscoveryRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = rawRecord[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function readBoolean(rawRecord: RawDiscoveryRecord, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = rawRecord[key]
    if (typeof value === 'boolean') {
      return value
    }
  }

  return undefined
}

function readIsoDate(rawRecord: RawDiscoveryRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rawRecord[key]
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString()
    }
  }

  return undefined
}

function readNumber(rawRecord: RawDiscoveryRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = rawRecord[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }

  return undefined
}

function readTags(rawRecord: RawDiscoveryRecord): string[] {
  const tagSources = [rawRecord.tags, rawRecord.categories]
  for (const tagSource of tagSources) {
    if (Array.isArray(tagSource)) {
      return tagSource
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    }
  }

  return []
}

function isRecord(value: unknown): value is RawDiscoveryRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
