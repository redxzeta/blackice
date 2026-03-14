import type { Request, Response, Express } from 'express'
import { log } from '../log.js'
import {
  AnalyzeLogsBatchRequestSchema,
  AnalyzeLogsRequestSchema,
  AnalyzeLogsResponseSchema,
  AnalyzeLogsTargetsResponseSchema,
  LogExplainerJsonSchemas,
} from './schema.js'
import {
  checkLokiHealth,
  ensureLokiRulesConfigured,
  getLokiDiscovery,
  getLokiSyntheticTargets,
} from './logCollector.js'
import { analyzeOneRequest } from './analysis.js'
import { executeAnalyzeLogsBatch } from './batchRequest.js'
import { toHttpError } from '../http/errors.js'
import { getRequestId } from '../http/requestLogging.js'
import { parseBodyOrRespond } from '../http/validation.js'
import { buildLogExplainerStatus } from './status.js'
import { resolveSafetyIdentifier } from '../ai/safetyIdentifier.js'
import { buildMetadataEndpoints } from './metadata.js'

export function registerLogExplainerRoutes(app: Express): void {
  app.get('/analyze/logs/targets', (_req: Request, res: Response) => {
    try {
      ensureLokiRulesConfigured()
      const targets = [...getLokiSyntheticTargets()]
      const discovery = getLokiDiscovery()
      const body = AnalyzeLogsTargetsResponseSchema.parse({ targets, discovery })
      res.status(200).json(body)
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      res.status(httpError.status).json({ error: httpError.message })
    }
  })

  app.get('/health/loki', async (_req: Request, res: Response) => {
    const health = await checkLokiHealth()
    res.status(health.ok ? 200 : health.status).json(health)
  })

  app.get('/analyze/logs/status', (_req: Request, res: Response) => {
    res.status(200).json(buildLogExplainerStatus())
  })

  app.get('/analyze/logs/metadata', (_req: Request, res: Response) => {
    const status = buildLogExplainerStatus()

    res.status(200).json({
      name: 'blackice-log-explainer',
      version: 1,
      description: 'Read-only log analysis service for OpenClaw integration',
      endpoints: buildMetadataEndpoints(),
      status,
      schemas: LogExplainerJsonSchemas,
    })
  })

  app.post('/analyze/logs/batch', async (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      const safetyIdentifier = resolveSafetyIdentifier({
        request: req,
        explicitUser: undefined,
        requestId,
      })
      const body = parseBodyOrRespond(AnalyzeLogsBatchRequestSchema, req.body, res)
      if (!body) {
        return
      }
      const bodyOut = await executeAnalyzeLogsBatch(body, {
        requestId,
        safetyIdentifier,
      })
      res.status(200).json(bodyOut)
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      log.error('log_explainer_batch_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message,
      })
      const details =
        typeof error === 'object' && error !== null && 'details' in error
          ? (error as { details?: unknown }).details
          : undefined
      res
        .status(httpError.status)
        .json(details ? { error: httpError.message, details } : { error: httpError.message })
    }
  })

  app.post('/analyze/logs', async (req: Request, res: Response) => {
    try {
      const requestId = getRequestId(res)
      const safetyIdentifier = resolveSafetyIdentifier({
        request: req,
        explicitUser: undefined,
        requestId,
      })
      const body = parseBodyOrRespond(AnalyzeLogsRequestSchema, req.body, res)
      if (!body) {
        return
      }

      const analyzed = await analyzeOneRequest(body, {
        requestId,
        safetyIdentifier,
      })
      res.status(200).json(AnalyzeLogsResponseSchema.parse(analyzed))
    } catch (error: unknown) {
      const httpError = toHttpError(error)
      log.error('log_explainer_failed', {
        request_id: getRequestId(res),
        status: httpError.status,
        message: httpError.message,
      })
      res.status(httpError.status).json({ error: httpError.message })
    }
  })
}
