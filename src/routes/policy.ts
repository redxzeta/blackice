import type { Express, Request, Response } from 'express';
import { log } from '../log.js';
import { ChatCompletionRequestSchema } from '../schema.js';
import { buildDryRunResponse } from '../chat/routeResolution.js';
import { sendOpenAIError } from '../http/errors.js';
import { getRequestId } from '../http/requestLogging.js';

export function registerPolicyRoutes(app: Express): void {
  app.post('/v1/policy/dry-run', (req: Request, res: Response) => {
    const started = Date.now();
    const requestId = getRequestId(res);

    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendOpenAIError(res, 400, parsed.error.message);
      return;
    }

    const response = buildDryRunResponse(parsed.data);

    log.info('policy_dry_run_complete', {
      request_id: requestId,
      envelope_kind: response.envelope.kind,
      route_kind: response.route.kind,
      route_reason: response.route.reason,
      latency_ms: Date.now() - started
    });

    res.status(200).json(response);
  });
}
