import type { Express, Request, Response } from 'express'
import { log } from '../log.js'
import { sendSimpleError } from '../http/errors.js'
import { parseBodyOrRespond } from '../http/validation.js'
import { getRequestId } from '../http/requestLogging.js'
import {
  ExecutionPolicyError,
  ExecutionService,
  IntentNotFoundError,
  IntentStateError,
} from '../execution/service.js'
import {
  IntentActionResponseSchema,
  IntentStatusSchema,
  ListIntentsResponseSchema,
  SubmitIntentRequestSchema,
  SubmitIntentResponseSchema,
} from '../execution/schema.js'

export function registerIntentRoutes(
  app: Express,
  executionService = new ExecutionService()
): void {
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
      const intent = await executionService.executeIntent(req.params.intentId, requestId)
      res.status(200).json(IntentActionResponseSchema.parse({ ok: true, intent }))
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
