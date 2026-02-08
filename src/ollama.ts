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

const configuredBaseURL = process.env.OLLAMA_BASE_URL?.trim() || 'http://192.168.1.230:11434';
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
};

export async function runWorkerText(params: GenerateParams): Promise<{ text: string }> {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  const model = resolveModel(params.modelId) as Parameters<typeof generateText>[0]['model'];
  const result = await generateText({
    model,
    prompt,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens
  });

  const sanitized = sanitizeLLMOutput(result.text);
  if (!sanitized.ok) {
    throw new Error(sanitized.error);
  }

  return { text: sanitized.text };
}

export function runWorkerTextStream(params: GenerateParams) {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  const model = resolveModel(params.modelId) as Parameters<typeof streamText>[0]['model'];

  return streamText({
    model,
    prompt,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens
  });
}

export { baseURL as ollamaBaseURL };
