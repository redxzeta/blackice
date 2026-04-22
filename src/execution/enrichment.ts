import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  EnrichedCandidateRecordSchema,
  type CandidateDiscoveryAdapter,
  type CandidateDiscoveryQuery,
  type CandidateEnrichmentAdapter,
  type CandidateRecord,
  type EnrichedCandidateRecord,
  type OrderbookReadAdapter,
  type OrderbookSnapshot,
} from './contracts.js'

type CandidateEnrichmentPipelineOptions = {
  discoveryAdapter: CandidateDiscoveryAdapter
  orderbookAdapter: OrderbookReadAdapter
}

type QualificationConfig = {
  minDepthUsd: number
  maxSpreadBps: number
}

const BLOCKING_REASON_CODES = ['candidate_not_tradable', 'metadata_incomplete'] as const
const FILTERING_REASON_CODES = ['spread_above_limit', 'depth_below_minimum'] as const

export class CandidateEnrichmentPipeline implements CandidateEnrichmentAdapter {
  constructor(private readonly options: CandidateEnrichmentPipelineOptions) {}

  async listEnrichedCandidates(
    query: CandidateDiscoveryQuery = {}
  ): Promise<EnrichedCandidateRecord[]> {
    const candidates = await this.options.discoveryAdapter.listCandidates(query)
    const qualificationConfig = resolveQualificationConfig()

    return Promise.all(
      candidates.map((candidate) => this.enrichCandidate(candidate, qualificationConfig))
    )
  }

  private async enrichCandidate(
    candidate: CandidateRecord,
    qualificationConfig: QualificationConfig
  ): Promise<EnrichedCandidateRecord> {
    const orderbook = await this.options.orderbookAdapter.getSnapshot(candidate)
    const qualificationReasons = buildQualificationReasons(
      candidate,
      orderbook,
      qualificationConfig
    )
    const qualificationStatus = determineQualificationStatus(qualificationReasons)

    return EnrichedCandidateRecordSchema.parse({
      ...candidate,
      qualificationStatus,
      qualificationReasons,
      orderbook,
      impliedProbability: resolveImpliedProbability(orderbook),
    })
  }
}

function buildQualificationReasons(
  candidate: CandidateRecord,
  orderbook: OrderbookSnapshot,
  qualificationConfig: QualificationConfig
): string[] {
  const reasons: string[] = []

  if (!candidate.tradable) {
    reasons.push('candidate_not_tradable')
  }

  if (!candidate.metadataComplete) {
    reasons.push('metadata_incomplete')
  }

  if (orderbook.spreadBps !== null && orderbook.spreadBps > qualificationConfig.maxSpreadBps) {
    reasons.push('spread_above_limit')
  }

  if (orderbook.depthUsd < qualificationConfig.minDepthUsd) {
    reasons.push('depth_below_minimum')
  }

  return reasons
}

function determineQualificationStatus(
  qualificationReasons: string[]
): EnrichedCandidateRecord['qualificationStatus'] {
  if (qualificationReasons.some(isBlockingReason)) {
    return 'blocked'
  }

  if (qualificationReasons.some(isFilteringReason)) {
    return 'filtered'
  }

  return 'eligible'
}

function isBlockingReason(reason: string): boolean {
  return BLOCKING_REASON_CODES.some((code) => code === reason)
}

function isFilteringReason(reason: string): boolean {
  return FILTERING_REASON_CODES.some((code) => code === reason)
}

function resolveImpliedProbability(orderbook: OrderbookSnapshot): number | null {
  const midpointProbability = resolveMidpointProbability(orderbook)
  if (midpointProbability !== null) {
    return midpointProbability
  }

  return normalizeProbability(orderbook.bestAsk ?? orderbook.bestBid)
}

function resolveMidpointProbability(orderbook: OrderbookSnapshot): number | null {
  if (orderbook.bestBid === null || orderbook.bestAsk === null) {
    return null
  }

  return normalizeProbability((orderbook.bestBid + orderbook.bestAsk) / 2)
}

function normalizeProbability(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }

  if (value < 0 || value > 1) {
    return null
  }

  return Math.round(value * 1_000_000) / 1_000_000
}

function resolveQualificationConfig(): QualificationConfig {
  const runtimeConfig = getRuntimeConfig()

  return {
    minDepthUsd: runtimeConfig.marketData.minDepthUsd,
    maxSpreadBps: runtimeConfig.marketData.maxSpreadBps,
  }
}
