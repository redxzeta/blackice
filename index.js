import express from 'express';
import { createAnalyzeLogsRouter } from './routes/analyzeLogsRoute.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: '256kb' }));
app.use('/analyze', createAnalyzeLogsRouter());

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use((err, _req, res, _next) => {
  const status = Number(err?.status ?? 500);
  const message = typeof err?.message === 'string' ? err.message : 'Internal server error';

  res.status(status).json({
    error: message
  });
});

app.listen(PORT, () => {
  console.log(`Log Explainer listening on http://0.0.0.0:${PORT}`);
});
