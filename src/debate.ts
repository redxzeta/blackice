import { runWorkerText } from './ollama.js';
import type { DebateRequest } from './schema.js';

type DebateSpeaker = 'A' | 'B';

export type DebateTurn = {
  round: number;
  turn: number;
  speaker: DebateSpeaker;
  model: string;
  text: string;
  status: 'ok' | 'error';
};

export type DebateResult = {
  topic: string;
  moderator_decision_mode: 'openclaw_decides';
  config: {
    modelA: string;
    modelB: string;
    rounds: number;
    turnsPerRound: number;
    maxTurnChars: number;
    totalTurns: number;
  };
  transcript: DebateTurn[];
  moderator_summary?: string;
  winner: null;
};

const DEFAULT_MODEL_ALLOWLIST = ['llama3.1:8b', 'qwen2.5:14b', 'qwen2.5-coder:14b'];
const TURN_RETRY_COUNT = 1;
const PER_TURN_TIMEOUT_MS = 45_000;
const MAX_TOTAL_TRANSCRIPT_CHARS = 80_000;

export class DebateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebateInputError';
  }
}

function getModelAllowlist(): string[] {
  const raw = process.env.DEBATE_MODEL_ALLOWLIST?.trim();
  if (!raw) {
    return DEFAULT_MODEL_ALLOWLIST;
  }

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertModelAllowed(model: string, allowlist: string[]): void {
  if (!allowlist.includes(model)) {
    throw new DebateInputError(`Model not allowed for debate: ${model}`);
  }
}

function trimToChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}...`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function buildTurnPrompt(args: {
  topic: string;
  moderatorInstruction?: string;
  speaker: DebateSpeaker;
  opponent: DebateSpeaker;
  round: number;
  turn: number;
  priorTurns: DebateTurn[];
  maxTurnChars: number;
}): string {
  const history = args.priorTurns
    .map((turn) => `Round ${turn.round} Turn ${turn.turn} ${turn.speaker}: ${turn.text}`)
    .join('\n');

  return [
    `Debate Topic: ${args.topic}`,
    args.moderatorInstruction ? `Moderator Instruction: ${args.moderatorInstruction}` : 'Moderator Instruction: Stay rigorous and factual.',
    `You are debater ${args.speaker}. Opponent is ${args.opponent}.`,
    `Current Round: ${args.round}`,
    `Current Turn: ${args.turn}`,
    `Debate Rules:`,
    `- Make one concise argument and one direct response to the opponent's strongest point.`,
    `- Be persuasive but factual.`,
    `- Keep output under ${args.maxTurnChars} characters.`,
    `- Plain English text only.`,
    '',
    'Prior Transcript:',
    history || '(none)',
    '',
    `Now provide debater ${args.speaker}'s next turn.`
  ].join('\n');
}

async function generateTurnWithRetry(args: {
  model: string;
  topic: string;
  moderatorInstruction?: string;
  speaker: DebateSpeaker;
  opponent: DebateSpeaker;
  round: number;
  turn: number;
  priorTurns: DebateTurn[];
  maxTurnChars: number;
  temperature?: number;
}): Promise<DebateTurn> {
  const prompt = buildTurnPrompt(args);

  for (let attempt = 0; attempt <= TURN_RETRY_COUNT; attempt += 1) {
    try {
      const result = await withTimeout(
        runWorkerText({
          modelId: args.model,
          input: prompt,
          temperature: args.temperature
        }),
        PER_TURN_TIMEOUT_MS,
        `Debate turn ${args.round}.${args.turn}`
      );

      return {
        round: args.round,
        turn: args.turn,
        speaker: args.speaker,
        model: args.model,
        text: trimToChars(result.text.trim(), args.maxTurnChars),
        status: 'ok'
      };
    } catch (error) {
      if (attempt >= TURN_RETRY_COUNT) {
        return {
          round: args.round,
          turn: args.turn,
          speaker: args.speaker,
          model: args.model,
          text: `Turn generation failed: ${error instanceof Error ? error.message : String(error)}`,
          status: 'error'
        };
      }
    }
  }

  return {
    round: args.round,
    turn: args.turn,
    speaker: args.speaker,
    model: args.model,
    text: 'Turn generation failed after retries.',
    status: 'error'
  };
}

function computeTranscriptChars(turns: DebateTurn[]): number {
  return turns.reduce((sum, turn) => sum + turn.text.length, 0);
}

function buildModeratorSummary(topic: string, transcript: DebateTurn[]): string {
  const okTurns = transcript.filter((t) => t.status === 'ok');
  const errorTurns = transcript.filter((t) => t.status === 'error').length;
  const lastA = [...okTurns].reverse().find((t) => t.speaker === 'A')?.text ?? 'No final point from A.';
  const lastB = [...okTurns].reverse().find((t) => t.speaker === 'B')?.text ?? 'No final point from B.';

  return [
    `Topic: ${topic}`,
    `Completed turns: ${transcript.length}`,
    `Failed turns: ${errorTurns}`,
    `Latest A point: ${lastA}`,
    `Latest B point: ${lastB}`,
    'Winner must be selected by OpenClaw moderation policy.'
  ].join('\n');
}

export async function runDebate(request: DebateRequest): Promise<DebateResult> {
  const allowlist = getModelAllowlist();
  assertModelAllowed(request.modelA, allowlist);
  assertModelAllowed(request.modelB, allowlist);

  const transcript: DebateTurn[] = [];

  for (let round = 1; round <= request.rounds; round += 1) {
    for (let turn = 1; turn <= request.turnsPerRound; turn += 1) {
      const speaker: DebateSpeaker = turn % 2 === 1 ? 'A' : 'B';
      const opponent: DebateSpeaker = speaker === 'A' ? 'B' : 'A';
      const model = speaker === 'A' ? request.modelA : request.modelB;
      const temperature = speaker === 'A' ? request.temperatureA : request.temperatureB;

      const turnResult = await generateTurnWithRetry({
        model,
        topic: request.topic,
        moderatorInstruction: request.moderatorInstruction,
        speaker,
        opponent,
        round,
        turn,
        priorTurns: transcript,
        maxTurnChars: request.maxTurnChars,
        temperature
      });

      transcript.push(turnResult);

      if (computeTranscriptChars(transcript) > MAX_TOTAL_TRANSCRIPT_CHARS) {
        throw new Error('Debate transcript exceeded maximum allowed size.');
      }
    }
  }

  const response: DebateResult = {
    topic: request.topic,
    moderator_decision_mode: 'openclaw_decides',
    config: {
      modelA: request.modelA,
      modelB: request.modelB,
      rounds: request.rounds,
      turnsPerRound: request.turnsPerRound,
      maxTurnChars: request.maxTurnChars,
      totalTurns: request.rounds * request.turnsPerRound
    },
    transcript,
    winner: null
  };

  if (request.includeModeratorSummary) {
    response.moderator_summary = buildModeratorSummary(request.topic, transcript);
  }

  return response;
}
