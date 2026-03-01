import type { Express, Request, Response } from 'express';
import { executeAction } from '../actions.js';
import { log } from '../log.js';
import { runWorkerText } from '../ollama.js';
import { ChatCompletionRequestSchema } from '../schema.js';
import { sanitizeLLMOutput } from '../sanitize.js';
import { sendOpenAIError } from '../http/errors.js';
import { getRequestId } from '../http/requestLogging.js';
import { buildMessageResponse } from '../chat/responseBuilders.js';
import { resolveRoute } from '../chat/routeResolution.js';
import { handleChatStreaming } from '../chat/streaming.js';

export function registerChatCompletionsRoute(app: Express): void {
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const started = Date.now();
    const requestId = getRequestId(res);

    try {
      const parsed = ChatCompletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendOpenAIError(res, 400, parsed.error.message);
        return;
      }

      const body = parsed.data;
      const resolved = resolveRoute(body);

      if (resolved.route.kind === 'action' && resolved.envelope.kind === 'action') {
        const actionResult = await executeAction(resolved.envelope.action);

        log.info('request_complete', {
          request_id: requestId,
          action: resolved.envelope.action.action,
          model: resolved.route.routerModel,
          route_reason: resolved.route.reason,
          latency_ms: Date.now() - started
        });

        res.status(200).json(buildMessageResponse(resolved.route.routerModel, actionResult.text));
        return;
      }

      if (resolved.route.kind !== 'chat' || resolved.envelope.kind !== 'chat') {
        sendOpenAIError(res, 500, 'Route resolution mismatch', 'server_error');
        return;
      }

      if (resolved.route.stream) {
        await handleChatStreaming(
          res,
          resolved.route.workerModel,
          resolved.envelope.raw,
          body.temperature,
          body.max_tokens,
          requestId
        );

        log.info('request_complete', {
          request_id: requestId,
          action: null,
          model: resolved.route.workerModel,
          route_reason: resolved.route.reason,
          latency_ms: Date.now() - started
        });
        return;
      }

      const result = await runWorkerText({
        modelId: resolved.route.workerModel,
        input: resolved.envelope.raw,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        requestId
      });

      const sanitized = sanitizeLLMOutput(result.text);
      if (!sanitized.ok) {
        sendOpenAIError(res, 502, sanitized.error, 'server_error');
        return;
      }

      log.info('request_complete', {
        request_id: requestId,
        action: null,
        model: resolved.route.workerModel,
        route_reason: resolved.route.reason,
        latency_ms: Date.now() - started
      });

      res.status(200).json(buildMessageResponse(resolved.route.workerModel, sanitized.text));
    } catch (error) {
      log.error('request_failed', {
        request_id: requestId,
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      });

      sendOpenAIError(
        res,
        500,
        error instanceof Error ? error.message : 'Internal server error',
        'server_error'
      );
    }
  });
}
