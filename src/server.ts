import express from 'express';
import { registerLogExplainerRoutes } from './logExplainer/route.js';
import { getVersionInfo } from './version.js';
import { ollamaBaseURL } from './ollama.js';
import { log } from './log.js';
import { registerChatCompletionsRoute } from './routes/chatCompletions.js';
import { registerPolicyRoutes } from './routes/policy.js';
import { registerDebateRoutes } from './routes/debate.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerModelRoutes } from './routes/models.js';
import { checkModelAvailability, getConfiguredModel, isModelPreflightEnabled } from './ollama.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const maxActiveDebates = Number(process.env.DEBATE_MAX_CONCURRENT ?? 1);
const versionInfo = getVersionInfo();

app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('x-blackice-version', versionInfo.version);
  next();
});

registerLogExplainerRoutes(app);
registerChatCompletionsRoute(app);
registerPolicyRoutes(app);
registerDebateRoutes(app, maxActiveDebates);
registerModelRoutes(app);
registerOpsRoutes(app, versionInfo);

async function start(): Promise<void> {
  if (isModelPreflightEnabled()) {
    const preflight = await checkModelAvailability(getConfiguredModel());
    if (!preflight.available) {
      throw new Error(`startup_preflight_failed_model_not_found:${preflight.model}`);
    }
    log.info('startup_model_preflight_ok', {
      model: preflight.model,
      latency_ms: preflight.latencyMs,
      ollama_base_url: ollamaBaseURL
    });
  }

  app.listen(port, () => {
    log.info('server_started', { port, ollama_base_url: ollamaBaseURL });
  });
}

start().catch((error: unknown) => {
  log.error('server_start_failed', {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
