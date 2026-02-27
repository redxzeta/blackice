import { generateText, streamText } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { buildWorkerContractPrompt, sanitizeLLMOutput } from './sanitize.js';

function normalizeOllamaBaseURL(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (/\/api$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return trimmed.replace(/\/v1$/i, '/api');
  }
  return `${trimmed}/api`;
}

const configuredBaseURL = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
const configuredModel = process.env.OLLAMA_MODEL?.trim() || 'qwen2.5:14b';
const baseURL = normalizeOllamaBaseURL(configuredBaseURL);
const modelPreflightTimeoutMs = Math.max(200, Number(process.env.MODEL_PREFLIGHT_TIMEOUT_MS ?? 2000));

const ollama = createOllama({
  baseURL
}) as unknown as {
  (modelId: string): unknown;
  chatModel?: (modelId: string) => unknown;
  languageModel?: (modelId: string) => unknown;
};

function resolveModel(modelId: string): unknown {
  if (typeof ollama.chatModel === 'function') {
    return ollama.chatModel(modelId);
  }
  if (typeof ollama.languageModel === 'function') {
    return ollama.languageModel(modelId);
  }
  return ollama(modelId);
}

export type GenerateParams = {
  modelId: string;
  input: string;
  temperature?: number;
  maxTokens?: number;
  explicitJsonAllowed?: boolean;
  requestId?: string;
};

export async function runWorkerText(params: GenerateParams): Promise<{ text: string }> {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  const headers: Record<string, string> = {};
  if (params.requestId) {
    headers['X-Request-ID'] = params.requestId;
  }
  const model = resolveModel(params.modelId) as Parameters<typeof generateText>[0]['model'];
  const result = await generateText({
    model,
    prompt,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    headers: Object.keys(headers).length > 0 ? headers : undefined
  });

  const sanitized = sanitizeLLMOutput(result.text);
  if (!sanitized.ok) {
    throw new Error(sanitized.error);
  }

  return { text: sanitized.text };
}

export function runWorkerTextStream(params: GenerateParams) {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  const headers: Record<string, string> = {};
  if (params.requestId) {
    headers['X-Request-ID'] = params.requestId;
  }
  const model = resolveModel(params.modelId) as Parameters<typeof streamText>[0]['model'];

  return streamText({
    model,
    prompt,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    headers: Object.keys(headers).length > 0 ? headers : undefined
  });
}

function normalizeModelName(name: string): string {
  return name.trim();
}

export async function checkModelAvailability(requestedModel?: string): Promise<{
  ok: boolean;
  model: string;
  baseUrl: string;
  available: boolean;
  latencyMs: number;
}> {
  const model = normalizeModelName(requestedModel && requestedModel.trim() ? requestedModel : configuredModel);
  const start = Date.now();

  const response = await fetch(`${baseURL}/tags`, {
    signal: AbortSignal.timeout(modelPreflightTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`ollama_tags_failed_${response.status}`);
  }

  const payload = await response.json() as {
    models?: Array<{ name?: string; model?: string }>;
  };

  const candidates = new Set<string>();
  for (const item of payload.models ?? []) {
    if (typeof item.name === 'string' && item.name.trim()) {
      candidates.add(item.name.trim());
    }
    if (typeof item.model === 'string' && item.model.trim()) {
      candidates.add(item.model.trim());
    }
  }

  const available = candidates.has(model);

  return {
    ok: available,
    model,
    baseUrl: baseURL,
    available,
    latencyMs: Date.now() - start
  };
}

export function getConfiguredModel(): string {
  return configuredModel;
}

export function isModelPreflightEnabled(): boolean {
  return process.env.MODEL_PREFLIGHT_ON_START === '1';
}

export { baseURL as ollamaBaseURL };
