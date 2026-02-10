import express from 'express';
import { z } from 'zod';
import { collectLogs } from '../logCollector/index.js';
import { analyzeLogsWithOllama } from '../llmClient/ollamaClient.js';
import { SYSTEM_PROMPT } from '../promptTemplates/systemPrompt.js';
import { buildUserPrompt, truncateLogs } from '../promptTemplates/buildLogAnalysisPrompt.js';

const AnalyzeRequestSchema = z
  .object({
    source: z.enum(['journalctl', 'docker', 'file']),
    target: z.string().min(1).max(300),
    hours: z.number().positive().max(168),
    maxLines: z.number().int().positive().max(5000)
  })
  .strict();

function mapErrorToStatus(err) {
  if (typeof err?.status === 'number') {
    return err.status;
  }
  return 500;
}

export function createAnalyzeLogsRouter() {
  const router = express.Router();

  router.post('/logs', async (req, res) => {
    try {
      const parsed = AnalyzeRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
        return;
      }

      const payload = parsed.data;
      const rawLogs = await collectLogs(payload);

      if (!rawLogs.trim()) {
        res.status(422).json({ error: 'No logs were collected for the given query' });
        return;
      }

      const { text: truncatedLogs, truncated } = truncateLogs(rawLogs);
      const userPrompt = buildUserPrompt({
        ...payload,
        logs: truncatedLogs,
        truncated
      });

      const analysis = await analyzeLogsWithOllama({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt
      });

      // Return model output verbatim as requested.
      res.status(200).json({
        analysis
      });
    } catch (err) {
      const status = mapErrorToStatus(err);
      const message = typeof err?.message === 'string' ? err.message : 'Unexpected error';

      res.status(status).json({ error: message });
    }
  });

  return router;
}
