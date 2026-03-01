import type { Response } from 'express';
import { runWorkerTextStream } from '../ollama.js';
import { nowSeconds, openAICompletionId } from './responseBuilders.js';

type StreamDeltaEvent = {
  type: 'text-delta';
  textDelta: string;
};

function sendSSEChunk(res: Response, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function isTextDeltaEvent(part: unknown): part is StreamDeltaEvent {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text-delta' &&
    typeof (part as { textDelta?: unknown }).textDelta === 'string'
  );
}

export async function handleChatStreaming(
  res: Response,
  modelId: string,
  input: string,
  temperature?: number,
  maxTokens?: number,
  requestId?: string
): Promise<void> {
  const streamResult = runWorkerTextStream({
    modelId,
    input,
    temperature,
    maxTokens,
    requestId
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

  const suppressionEnabled = process.env.STREAM_SUPPRESS_TOOLISH === '1';
  let gating = suppressionEnabled;
  let preBuffer = '';

  for await (const part of streamResult.fullStream) {
    if (!isTextDeltaEvent(part)) {
      continue;
    }

    let delta = String(part.textDelta ?? '');
    if (!delta) {
      continue;
    }

    if (suppressionEnabled) {
      delta = delta.replace(/```/g, '');
    }

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

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
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
        // Wait for additional tokens while gating.
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
