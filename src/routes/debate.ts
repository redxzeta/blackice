import type { Express, Request, Response } from 'express';
import { DebateInputError, runDebate } from '../debate.js';
import { log } from '../log.js';
import { DebateRequestSchema } from '../schema.js';
import { sendOpenAIError } from '../http/errors.js';
import { getRequestId } from '../http/requestLogging.js';

export function registerDebateRoutes(app: Express, maxActiveDebates: number): void {
  let activeDebates = 0;

  app.post('/v1/debate', async (req: Request, res: Response) => {
    const started = Date.now();
    const requestId = getRequestId(res);
    let acquiredDebateSlot = false;

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
}
