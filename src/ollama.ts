import { generateText, streamText } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { buildWorkerContractPrompt, sanitizeLLMOutput } from './sanitize.js';
import { getRuntimeConfig } from './config/runtimeConfig.js';
import { getPolicyFallbackModel } from './ai/modelPolicy.js';
import { parsePolicySignal } from './ai/policySignal.js';
import { log } from './log.js';

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
  safetyIdentifier?: string;
  routeKind?: 'chat' | 'action' | 'debate' | 'observability';
};

async function generateWithModel(params: {
  modelId: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  requestId?: string;
  safetyIdentifier?: string;
}): Promise<{ text: string }> {
  const headers: Record<string, string> = {};
  if (params.requestId) {
    headers['X-Request-ID'] = params.requestId;
  }
  if (params.safetyIdentifier) {
    headers['X-Safety-Identifier'] = params.safetyIdentifier;
  }

  const model = resolveModel(params.modelId) as Parameters<typeof generateText>[0]['model'];
  const result = await generateText({
    model,
    prompt: params.prompt,
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

export async function runWorkerText(params: GenerateParams): Promise<{ text: string }> {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  try {
    return await generateWithModel({
      modelId: params.modelId,
      prompt,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      requestId: params.requestId,
      safetyIdentifier: params.safetyIdentifier
    });
  } catch (error: unknown) {
    const signal = parsePolicySignal(error);
    if (!signal.isCyberPolicyViolation) {
      throw error;
    }

    const fallbackModel = getPolicyFallbackModel(params.modelId);
    const attemptedFallback = fallbackModel !== params.modelId;

    log.info('policy_trigger_event', {
      request_id: params.requestId ?? null,
      route_kind: params.routeKind ?? null,
      trigger: 'cyber_policy_violation',
      error_code: signal.errorCode ?? 'cyber_policy_violation',
      param: signal.param ?? null,
      primary_model: params.modelId,
      fallback_model: attemptedFallback ? fallbackModel : null,
      safety_identifier_present: Boolean(params.safetyIdentifier),
      fallback_attempted: attemptedFallback
    });

    if (!attemptedFallback) {
      throw error;
    }

    try {
      const fallbackResult = await generateWithModel({
        modelId: fallbackModel,
        prompt,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        requestId: params.requestId,
        safetyIdentifier: params.safetyIdentifier
      });

      log.info('policy_trigger_event', {
        request_id: params.requestId ?? null,
        route_kind: params.routeKind ?? null,
        trigger: 'cyber_policy_violation',
        primary_model: params.modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: true
      });

      return fallbackResult;
    } catch (fallbackError: unknown) {
      log.error('policy_trigger_event', {
        request_id: params.requestId ?? null,
        route_kind: params.routeKind ?? null,
        trigger: 'cyber_policy_violation',
        primary_model: params.modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
      throw fallbackError;
    }
  }
}

export function runWorkerTextStream(params: GenerateParams) {
  const prompt = buildWorkerContractPrompt(params.input, params.explicitJsonAllowed);
  const headers: Record<string, string> = {};
  if (params.requestId) {
    headers['X-Request-ID'] = params.requestId;
  }
  if (params.safetyIdentifier) {
    headers['X-Safety-Identifier'] = params.safetyIdentifier;
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
