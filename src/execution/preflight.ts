import { createHash, randomUUID } from 'node:crypto'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  PreflightRecordSchema,
  PreflightResultSchema,
  PreflightRequestSchema,
  type PreflightCheckCode,
  type PreflightCheckResult,
  type PreflightEvaluator,
  type PreflightRecord,
  type PreflightRequest,
  type PreflightResult,
  type SigningAdapter,
} from './contracts.js'
import { createSigningAdapter } from './signing.js'

type Clock = () => Date

type PreflightEngineOptions = {
  now?: Clock
  signingAdapter?: SigningAdapter
}

export class CandidatePreflightEngine implements PreflightEvaluator {
  private readonly now: Clock
  private readonly signingAdapter?: SigningAdapter

  constructor(options: PreflightEngineOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.signingAdapter = options.signingAdapter
  }

  async evaluate(request: PreflightRequest): Promise<PreflightResult> {
    const normalizedRequest = PreflightRequestSchema.parse(request)
    const runtimeConfig = getRuntimeConfig()
    const venue = normalizedRequest.venue ?? runtimeConfig.execution.defaultVenue
    const checks = await buildChecks({
      request: normalizedRequest,
      venue,
      signingAdapter: this.signingAdapter,
      now: this.now,
    })

    return PreflightResultSchema.parse({
      ok: checks.every((check) => check.ok),
      checkedAt: this.now().toISOString(),
      venue,
      checks,
    })
  }
}

export function buildPreflightRecord(input: {
  intentId: string
  recordedAt: string
  request: PreflightRequest
  result: PreflightResult
}): PreflightRecord {
  const normalizedRequest = PreflightRequestSchema.parse(input.request)
  const normalizedResult = PreflightResultSchema.parse(input.result)

  return PreflightRecordSchema.parse({
    preflightId: randomUUID(),
    intentId: input.intentId,
    recordedAt: input.recordedAt,
    policyFingerprint: computePreflightPolicyFingerprint(normalizedRequest),
    request: normalizedRequest,
    result: normalizedResult,
  })
}

export function computePreflightPolicyFingerprint(request: PreflightRequest): string {
  const normalizedRequest = PreflightRequestSchema.parse(request)
  const runtimeConfig = getRuntimeConfig()

  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        request: normalizedRequest,
        marketData: {
          minDepthUsd: runtimeConfig.marketData.minDepthUsd,
          maxSpreadBps: runtimeConfig.marketData.maxSpreadBps,
        },
        execution: {
          defaultVenue: runtimeConfig.execution.defaultVenue,
          allowedVenues: runtimeConfig.execution.allowedVenues,
          requirePreflight: runtimeConfig.execution.requirePreflight,
          maxPositionUsd: runtimeConfig.execution.maxPositionUsd,
          signerKind: runtimeConfig.execution.signerKind,
        },
      })
    )
    .digest('hex')
}

async function buildChecks(input: {
  request: PreflightRequest
  venue: string
  signingAdapter?: SigningAdapter
  now: Clock
}): Promise<PreflightCheckResult[]> {
  const runtimeConfig = getRuntimeConfig()
  const candidate = input.request.candidate
  const positionUsd = input.request.positionUsd ?? 0

  return [
    buildCheck(
      'candidate_not_tradable',
      candidate.tradable,
      candidate.tradable ? 'Candidate is tradable' : 'Candidate is not tradable'
    ),
    buildCheck(
      'metadata_incomplete',
      candidate.metadataComplete,
      candidate.metadataComplete
        ? 'Candidate metadata is complete'
        : 'Candidate metadata is incomplete'
    ),
    buildCheck(
      'spread_above_limit',
      candidate.orderbook.spreadBps === null ||
        candidate.orderbook.spreadBps <= runtimeConfig.marketData.maxSpreadBps,
      candidate.orderbook.spreadBps === null
        ? 'Orderbook spread is unavailable but not over the configured limit'
        : `Orderbook spread ${candidate.orderbook.spreadBps} bps is within configured limit ${runtimeConfig.marketData.maxSpreadBps} bps`,
      candidate.orderbook.spreadBps === null
        ? 'Orderbook spread is unavailable'
        : `Orderbook spread ${candidate.orderbook.spreadBps} bps exceeds configured limit ${runtimeConfig.marketData.maxSpreadBps} bps`
    ),
    buildCheck(
      'depth_below_minimum',
      candidate.orderbook.depthUsd >= runtimeConfig.marketData.minDepthUsd,
      `Orderbook depth ${candidate.orderbook.depthUsd} USD meets configured minimum ${runtimeConfig.marketData.minDepthUsd} USD`,
      `Orderbook depth ${candidate.orderbook.depthUsd} USD is below configured minimum ${runtimeConfig.marketData.minDepthUsd} USD`
    ),
    buildCheck(
      'position_above_limit',
      positionUsd <= runtimeConfig.execution.maxPositionUsd,
      `Requested position ${positionUsd} USD is within configured max ${runtimeConfig.execution.maxPositionUsd} USD`,
      `Requested position ${positionUsd} USD exceeds configured max ${runtimeConfig.execution.maxPositionUsd} USD`
    ),
    buildCheck(
      'venue_not_allowed',
      runtimeConfig.execution.allowedVenues.includes(input.venue),
      `Venue ${input.venue} is allowed`,
      `Venue ${input.venue} is not allowed by policy`
    ),
    await buildSigningAvailabilityCheck(input),
  ]
}

async function buildSigningAvailabilityCheck(input: {
  request: PreflightRequest
  venue: string
  signingAdapter?: SigningAdapter
  now: Clock
}): Promise<PreflightCheckResult> {
  try {
    const signingAdapter = input.signingAdapter ?? createSigningAdapter()
    await signingAdapter.signExecutionRequest({
      requestId: `preflight-${randomUUID()}`,
      intentId: `preflight-${input.request.candidate.marketId}`,
      venue: input.venue,
      marketId: input.request.candidate.marketId,
      side: 'buy',
      quantity: 1,
      executionMode: 'taker',
      submittedAt: input.now().toISOString(),
    })

    return buildCheck('signing_unavailable', true, 'Signing adapter is available')
  } catch (error) {
    return buildCheck(
      'signing_unavailable',
      false,
      'Signing adapter is available',
      `Signing adapter is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function buildCheck(
  code: PreflightCheckCode,
  ok: boolean,
  successMessage: string,
  failureMessage?: string
): PreflightCheckResult {
  return {
    code,
    ok,
    message: ok ? successMessage : (failureMessage ?? successMessage),
  }
}
