import type { Express, Request, Response } from 'express';
import { getLogMetrics, getRecentLogs } from '../log.js';
import type { VersionInfo } from '../version.js';

export function registerOpsRoutes(app: Express, versionInfo: VersionInfo): void {
  const opsEnabled = process.env.OPS_ENABLED === '1';

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.get('/version', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      ...versionInfo
    });
  });

  if (opsEnabled) {
    app.get('/logs/recent', (req: Request, res: Response) => {
      const limitRaw = String(req.query.limit ?? '100');
      const limit = Number.parseInt(limitRaw, 10);
      const logs = getRecentLogs(Number.isNaN(limit) ? 100 : limit);

      res.status(200).json({
        ok: true,
        count: logs.length,
        logs
      });
    });

    app.get('/logs/metrics', (req: Request, res: Response) => {
      const window = typeof req.query.window === 'string' ? req.query.window : undefined;
      const metrics = getLogMetrics(window);

      res.status(200).json({
        ok: true,
        ...metrics
      });
    });
  }
}
