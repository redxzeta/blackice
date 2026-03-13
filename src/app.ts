import express from 'express'
import { registerLogExplainerRoutes } from './logExplainer/route.js'
import { getVersionInfo } from './version.js'
import { requestLoggingMiddleware } from './http/requestLogging.js'
import { registerChatCompletionsRoute } from './routes/chatCompletions.js'
import { registerPolicyRoutes } from './routes/policy.js'
import { registerDebateRoutes } from './routes/debate.js'
import { registerModelRoutes } from './routes/models.js'
import { registerOpsRoutes } from './routes/ops.js'
import { checkReadiness, readinessStrict, readinessTimeoutMs } from './readiness.js'

export function createApp(maxActiveDebates: number) {
  const app = express()
  const versionInfo = getVersionInfo()

  app.use(requestLoggingMiddleware)
  app.use(express.json({ limit: '1mb' }))
  app.use((_req, res, next) => {
    res.setHeader('x-blackice-version', versionInfo.version)
    next()
  })

  registerLogExplainerRoutes(app)
  registerChatCompletionsRoute(app)
  registerPolicyRoutes(app)
  registerDebateRoutes(app, maxActiveDebates)
  registerModelRoutes(app)
  registerOpsRoutes(app, versionInfo)

  app.get('/readyz', async (_req, res) => {
    const readiness = await checkReadiness()
    const status = readiness.ok || !readinessStrict ? 200 : 503

    res.status(status).json({
      ...readiness,
      strict: readinessStrict,
      timeoutMs: readinessTimeoutMs,
    })
  })

  return app
}
