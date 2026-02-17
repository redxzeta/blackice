import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { parseEnvelope } from './envelope.js';
import { executeAction } from './actions.js';
import { DebateInputError, runDebate } from './debate.js';
import { chooseChatModel } from './router.js';
import { ChatCompletionRequestSchema, DebateRequestSchema } from './schema.js';
import { ollamaBaseURL, runWorkerText, runWorkerTextStream } from './ollama.js';
import { getLogMetrics, getRecentLogs, log } from './log.js';
import { sanitizeLLMOutput } from './sanitize.js';
import { registerLogExplainerRoutes } from './logExplainer/route.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const maxActiveDebates = Number(process.env.DEBATE_MAX_CONCURRENT ?? 1);
let activeDebates = 0;

app.use(express.json({ limit: '1mb' }));
registerLogExplainerRoutes(app);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function openAICompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function sendOpenAIError(res: Response, status: number, message: string, type = 'invalid_request_error'): void {
  res.status(status).json({
    error: {
      message,
      type
    }
  });
}

function sendSSEChunk(res: Response, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function buildMessageResponse(model: string, text: string) {
  return {
    id: openAICompletionId(),
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ]
  };
}

async function handleChatStreaming(res: Response, modelId: string, input: string, temperature?: number, maxTokens?: number): Promise<void> {
  const streamResult = runWorkerTextStream({
    modelId,
    input,
    temperature,
    maxTokens
  });

  const id = openAICompletionId();
  const created = nowSeconds();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sendSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null
      }
    ]
  });

  let gating = true;
  let preBuffer = '';

  for await (const part of streamResult.fullStream) {
    if ((part as { type?: string }).type !== 'text-delta') {
      continue;
    }

    let delta = String((part as { textDelta?: string }).textDelta ?? '');
    if (!delta) {
      continue;
    }

    delta = delta.replace(/```/g, '');

    if (gating) {
      preBuffer += delta;
      const trimmed = preBuffer.trim();

      if (trimmed.length > 220 || preBuffer.includes('\n') || !trimmed.startsWith('{')) {
        gating = false;
        if (preBuffer) {
          sendSSEChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: preBuffer },
                finish_reason: null
              }
            ]
          });
        }
        preBuffer = '';
        continue;
      }

      const maybeJson = trimmed;
      try {
        const parsed = JSON.parse(maybeJson) as Record<string, unknown>;
        const looksToolCall =
          (typeof parsed.name === 'string' && Object.prototype.hasOwnProperty.call(parsed, 'arguments')) ||
          Object.prototype.hasOwnProperty.call(parsed, 'tool_calls');

        if (looksToolCall) {
          gating = false;
          preBuffer = '';
          sendSSEChunk(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  content: 'Model output suppressed because it resembled a tool call payload.'
                },
                finish_reason: null
              }
            ]
          });
        }
      } catch {
        // Wait for more tokens while gating.
      }

      continue;
    }

    sendSSEChunk(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null
        }
      ]
    });
  }

  sendSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }
    ]
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const started = Date.now();
  const requestId = String(req.header('x-request-id') ?? randomUUID());
  res.setHeader('x-request-id', requestId);

  try {
    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendOpenAIError(res, 400, parsed.error.message);
      return;
    }

    const body = parsed.data;
    const envelope = parseEnvelope(body.messages);

    if (envelope.kind === 'action') {
      const actionResult = await executeAction(envelope.action);
      const modelUsed = `router/action/${envelope.action.action}`;

      log.info('request_complete', {
        request_id: requestId,
        action: envelope.action.action,
        model: modelUsed,
        latency_ms: Date.now() - started
      });

      res.status(200).json(buildMessageResponse(modelUsed, actionResult.text));
      return;
    }

    const route = chooseChatModel(body.messages);

    if (body.stream) {
      await handleChatStreaming(res, route.model, envelope.raw, body.temperature, body.max_tokens);

      log.info('request_complete', {
        request_id: requestId,
        action: null,
        model: route.model,
        route_reason: route.reason,
        latency_ms: Date.now() - started
      });
      return;
    }

    const result = await runWorkerText({
      modelId: route.model,
      input: envelope.raw,
      temperature: body.temperature,
      maxTokens: body.max_tokens
    });

    const sanitized = sanitizeLLMOutput(result.text);
    if (!sanitized.ok) {
      sendOpenAIError(res, 502, sanitized.error, 'server_error');
      return;
    }

    log.info('request_complete', {
      request_id: requestId,
      action: null,
      model: route.model,
      route_reason: route.reason,
      latency_ms: Date.now() - started
    });

    res.status(200).json(buildMessageResponse(route.model, sanitized.text));
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

app.post('/v1/debate', async (req: Request, res: Response) => {
  const started = Date.now();
  const requestId = String(req.header('x-request-id') ?? randomUUID());
  let acquiredDebateSlot = false;
  res.setHeader('x-request-id', requestId);

  try {
    const parsed = DebateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendOpenAIError(res, 400, parsed.error.message);
      return;
    }

    if (activeDebates >= maxActiveDebates) {
      sendOpenAIError(
        res,
        429,
        `Debate capacity reached (${maxActiveDebates} active). Try again shortly.`,
        'rate_limit_error'
      );
      return;
    }

    activeDebates += 1;
    acquiredDebateSlot = true;
    const result = await runDebate(parsed.data);

    log.info('debate_complete', {
      request_id: requestId,
      topic_preview: parsed.data.topic.slice(0, 80),
      model_a: parsed.data.modelA,
      model_b: parsed.data.modelB,
      rounds: parsed.data.rounds,
      turns_per_round: parsed.data.turnsPerRound,
      total_turns: result.transcript.length,
      active_debates: activeDebates,
      latency_ms: Date.now() - started
    });

    res.status(200).json({
      request_id: requestId,
      ...result
    });
  } catch (error) {
    if (error instanceof DebateInputError) {
      sendOpenAIError(res, 400, error.message);
      return;
    }

    log.error('debate_failed', {
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
  } finally {
    if (acquiredDebateSlot && activeDebates > 0) {
      activeDebates -= 1;
    }
  }
});

app.get('/v1/debate/schema', (_req: Request, res: Response) => {
  res.status(200).json({
    type: 'object',
    description: 'Input contract for POST /v1/debate',
    required: ['topic', 'modelA', 'modelB'],
    properties: {
      topic: { type: 'string', minLength: 3, maxLength: 500 },
      moderatorInstruction: { type: 'string', minLength: 1, maxLength: 1000 },
      moderator_decision_mode: {
        type: 'string',
        enum: ['openclaw_decides'],
        default: 'openclaw_decides'
      },
      modelA: { type: 'string', minLength: 1, maxLength: 120 },
      modelB: { type: 'string', minLength: 1, maxLength: 120 },
      rounds: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
      turnsPerRound: { type: 'integer', minimum: 4, maximum: 10, default: 4 },
      maxTurnChars: { type: 'integer', minimum: 200, maximum: 2000, default: 1200 },
      includeModeratorSummary: { type: 'boolean', default: false },
      temperatureA: { type: 'number', minimum: 0, maximum: 2 },
      temperatureB: { type: 'number', minimum: 0, maximum: 2 }
    },
    notes: [
      'Winner is always decided by OpenClaw policy.',
      'Models must be present in DEBATE_MODEL_ALLOWLIST.',
      'Total turns = rounds * turnsPerRound.'
    ]
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

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

app.listen(port, () => {
  log.info('server_started', { port, ollama_base_url: ollamaBaseURL });
});
