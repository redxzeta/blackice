import type { Express, Request, Response } from 'express'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import {
  type CandidateEnrichmentAdapter,
  type PreflightEvaluator,
  PreflightRequestSchema,
} from '../execution/contracts.js'
import { PublicCandidateDiscoveryAdapter } from '../execution/discovery.js'
import { CandidateEnrichmentPipeline } from '../execution/enrichment.js'
import { PublicOrderbookReadAdapter } from '../execution/orderbook.js'
import { CandidatePreflightEngine } from '../execution/preflight.js'
import {
  ExecuteIntentRequestSchema,
  ExecuteIntentResponseSchema,
  ExecutionReadinessResponseSchema,
  IntentActionResponseSchema,
  IntentExecutionLogsResponseSchema,
  IntentPreflightHistoryResponseSchema,
  IntentPreflightResponseSchema,
  IntentRefreshResponseSchema,
  IntentStatusSchema,
  ListCandidatesRequestSchema,
  ListCandidatesResponseSchema,
  ListIntentsResponseSchema,
  PreflightActionResponseSchema,
  SubmitIntentRequestSchema,
  SubmitIntentResponseSchema,
} from '../execution/schema.js'
import {
  ExecutionPolicyError,
  ExecutionService,
  IntentNotFoundError,
  IntentStateError,
} from '../execution/service.js'
import { sendSimpleError } from '../http/errors.js'
import { recordExecutionLifecycle } from '../http/metrics.js'
import { getRequestId } from '../http/requestLogging.js'
import { parseBodyOrRespond } from '../http/validation.js'
import { log } from '../log.js'

type IntentRouteOptions = {
  candidateEnrichmentAdapter?: CandidateEnrichmentAdapter
  preflightEvaluator?: PreflightEvaluator
}

export function registerIntentRoutes(
  app: Express,
  executionService = new ExecutionService(),
  options: IntentRouteOptions = {}
): void {
  const candidateEnrichmentAdapter =
    options.candidateEnrichmentAdapter ??
    new CandidateEnrichmentPipeline({
      discoveryAdapter: new PublicCandidateDiscoveryAdapter(),
      orderbookAdapter: new PublicOrderbookReadAdapter(),
    })
  const preflightEvaluator = options.preflightEvaluator ?? new CandidatePreflightEngine()

  app.get('/v1/execution-readiness', (_req: Request, res: Response) => {
    try {
      const readiness = executionService.getExecutionReadiness()
      res.status(readiness.ok ? 200 : 503).json(ExecutionReadinessResponseSchema.parse(readiness))
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.get('/v1/candidates', async (req: Request, res: Response) => {
    const parsed = ListCandidatesRequestSchema.safeParse({
      limit: parseOptionalInt(req.query.limit),
      excludedEventTypes: parseOptionalStringArray(req.query.excludedEventTypes),
    })
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: parsed.error.issues,
      })
      return
    }

    try {
      const candidates = await candidateEnrichmentAdapter.listEnrichedCandidates(parsed.data)
      res.status(200).json(
        ListCandidatesResponseSchema.parse({
          ok: true,
          candidates,
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/preflight', async (req: Request, res: Response) => {
    const requestId = getRequestId(res)
    const parsed = parseBodyOrRespond(PreflightRequestSchema, req.body, res)
    if (!parsed) {
      return
    }

    try {
      const preflight = await preflightEvaluator.evaluate(parsed)
      log.info('preflight_evaluated', {
        request_id: requestId,
        venue: preflight.venue,
        ok: preflight.ok,
      })
      res.status(200).json(
        PreflightActionResponseSchema.parse({
          ok: true,
          preflight,
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents/:intentId/preflight', async (req: Request, res: Response) => {
    const requestId = getRequestId(res)
    const parsed = parseBodyOrRespond(PreflightRequestSchema, req.body, res)
    if (!parsed) {
      return
    }

    try {
      const intent = executionService.getIntent(req.params.intentId)
      const preflightRequest = {
        ...parsed,
        venue: intent.venue,
        positionUsd: intent.notionalUsd,
      }
      const preflight = await preflightEvaluator.evaluate(preflightRequest)
      const preflightRecord = executionService.recordPreflight(
        intent.intentId,
        preflightRequest,
        preflight,
        requestId
      )
      log.info('intent_preflight_recorded', {
        request_id: requestId,
        intent_id: intent.intentId,
        venue: preflightRecord.result.venue,
        ok: preflightRecord.result.ok,
      })
      res.status(200).json(
        IntentPreflightResponseSchema.parse({
          ok: true,
          preflightRecord,
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents', (req: Request, res: Response) => {
    const requestId = getRequestId(res)
    const parsed = parseBodyOrRespond(SubmitIntentRequestSchema, req.body, res)
    if (!parsed) {
      return
    }

    try {
      const result = executionService.submitIntent(parsed, requestId)
      log.info('intent_submitted', {
        request_id: requestId,
        intent_id: result.intent.intentId,
        created: result.created,
        venue: result.intent.venue,
        market: result.intent.market,
        notional_usd: result.intent.notionalUsd,
      })
      res.status(result.created ? 201 : 200).json(
        SubmitIntentResponseSchema.parse({
          ok: true,
          created: result.created,
          intent: result.intent,
          policy: executionService.getPolicy(),
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.get('/v1/intents', (req: Request, res: Response) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined
    const parsedStatus = IntentStatusSchema.safeParse(rawStatus)

    const intents = executionService.listIntents(
      parsedStatus.success ? parsedStatus.data : undefined
    )

    res.status(200).json(
      ListIntentsResponseSchema.parse({
        ok: true,
        intents,
      })
    )
  })

  app.get('/v1/intents/:intentId', (req: Request, res: Response) => {
    try {
      res.status(200).json(
        IntentActionResponseSchema.parse({
          ok: true,
          intent: executionService.getIntent(req.params.intentId),
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.get('/v1/intents/:intentId/preflights', (req: Request, res: Response) => {
    try {
      res.status(200).json(
        IntentPreflightHistoryResponseSchema.parse({
          ok: true,
          preflightRecords: executionService.listPreflightRecords(req.params.intentId),
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.get('/v1/intents/:intentId/execution-logs', (req: Request, res: Response) => {
    try {
      res.status(200).json(
        IntentExecutionLogsResponseSchema.parse({
          ok: true,
          executionLogs: executionService.listExecutionLogs(req.params.intentId),
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents/:intentId/confirm', (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      const intent = executionService.confirmIntent(req.params.intentId, requestId)
      res.status(200).json(IntentActionResponseSchema.parse({ ok: true, intent }))
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents/:intentId/execute', async (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      if (!parseBodyOrRespond(ExecuteIntentRequestSchema, req.body ?? {}, res)) {
        return
      }

      const preflightRecord = requirePreflightExecution()
        ? executionService.getExecutionPreflightRecord(req.params.intentId)
        : null
      if (requirePreflightExecution() && !preflightRecord) {
        recordExecutionLifecycle('preflight_gate', 'blocked', 'preflight_required')
        res.status(422).json({
          error: 'Preflight is required before execution',
          code: 'preflight_required',
        })
        return
      }
      const executedIntent = await executionService.executeIntent(req.params.intentId, requestId)
      res.status(200).json(
        ExecuteIntentResponseSchema.parse({
          ok: true,
          intent: executedIntent,
          preflightRecord: preflightRecord ?? undefined,
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents/:intentId/cancel', (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      const intent = executionService.cancelIntent(req.params.intentId, requestId)
      res.status(200).json(IntentActionResponseSchema.parse({ ok: true, intent }))
    } catch (error) {
      respondExecutionError(res, error)
    }
  })

  app.post('/v1/intents/:intentId/refresh', async (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      const result = await executionService.refreshIntent(req.params.intentId, requestId)
      res.status(200).json(
        IntentRefreshResponseSchema.parse({
          ok: true,
          intent: result.intent,
          executionLog: result.executionLog,
        })
      )
    } catch (error) {
      respondExecutionError(res, error)
    }
  })
}

function respondExecutionError(res: Response, error: unknown): void {
  if (error instanceof IntentNotFoundError) {
    sendSimpleError(res, 404, error.message)
    return
  }

  if (error instanceof IntentStateError) {
    sendSimpleError(res, 409, error.message)
    return
  }

  if (error instanceof ExecutionPolicyError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
    })
    return
  }

  sendSimpleError(res, 500, error instanceof Error ? error.message : 'Internal server error')
}

function requirePreflightExecution(): boolean {
  return getRuntimeConfig().execution.requirePreflight
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? Number.NaN : parsed
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
