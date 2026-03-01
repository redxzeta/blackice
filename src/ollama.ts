import { generateText, streamText } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { buildWorkerContractPrompt, sanitizeLLMOutput } from './sanitize.js';
import { getRuntimeConfig } from './config/runtimeConfig.js';

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

const configuredBaseURL = getRuntimeConfig().ollama.baseUrl;
const baseURL = normalizeOllamaBaseURL(configuredBaseURL);

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

export { baseURL as ollamaBaseURL };
