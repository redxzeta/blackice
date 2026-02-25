import express from 'express';
import { registerLogExplainerRoutes } from './logExplainer/route.js';
import { getVersionInfo } from './version.js';
import { ollamaBaseURL } from './ollama.js';
import { log } from './log.js';
import { registerChatCompletionsRoute } from './routes/chatCompletions.js';
import { registerPolicyRoutes } from './routes/policy.js';
import { registerDebateRoutes } from './routes/debate.js';
import { registerOpsRoutes } from './routes/ops.js';

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
registerOpsRoutes(app, versionInfo);

app.listen(port, () => {
  log.info('server_started', { port, ollama_base_url: ollamaBaseURL });
});
