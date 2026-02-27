import type { Express, Request, Response } from 'express';
import { checkModelAvailability } from '../ollama.js';

function toErrorCode(message: string): string {
  if (message.includes('AbortError') || message.includes('timed out')) {
    return 'upstream_timeout';
  }
  if (message.startsWith('ollama_tags_failed_')) {
    return 'upstream_unavailable';
  }
  return 'upstream_error';
}

export function registerModelRoutes(app: Express): void {
  app.get('/v1/models/check', async (req: Request, res: Response) => {
    try {
      const model = typeof req.query.model === 'string' ? req.query.model : undefined;
      const result = await checkModelAvailability(model);

      if (!result.available) {
        res.status(404).json({
          ok: false,
          model: result.model,
          baseUrl: result.baseUrl,
          available: false,
          error: 'model_not_found',
          latencyMs: result.latencyMs
        });
        return;
      }

      res.status(200).json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = toErrorCode(message);
      const status = errorCode === 'upstream_timeout' ? 504 : 502;

      res.status(status).json({
        ok: false,
        available: false,
        error: errorCode
      });
    }
  });
}
