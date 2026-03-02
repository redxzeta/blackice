import { getRuntimeConfig } from '../config/runtimeConfig.js';

const runtimeConfig = getRuntimeConfig();
const defaultBaseUrl = runtimeConfig.ollama.baseUrl;
const defaultModel = runtimeConfig.ollama.model;
const OLLAMA_TIMEOUT_MS = Number(runtimeConfig.ollama.timeoutMs);
const OLLAMA_RETRY_ATTEMPTS = Number(runtimeConfig.ollama.retryAttempts);
const OLLAMA_RETRY_BACKOFF_MS = Number(runtimeConfig.ollama.retryBackoffMs);

type OllamaGenerateResponse = {
  response?: string;
};

function buildError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

async function requestOllamaOnce(params: { systemPrompt: string; userPrompt: string }): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${defaultBaseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: defaultModel,
        system: params.systemPrompt,
        prompt: params.userPrompt,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw buildError(response.status, `Ollama request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    const text = typeof data.response === 'string' ? data.response : '';

    if (!text.trim()) {
      throw buildError(502, 'Ollama returned an empty response');
    }

    return text;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw buildError(504, 'Ollama request timed out');
    }

    if (typeof error === 'object' && error !== null && 'status' in error) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw buildError(502, `Ollama request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeLogsWithOllama(params: { systemPrompt: string; userPrompt: string }): Promise<string> {
  const maxAttempts = Math.max(1, Math.floor(OLLAMA_RETRY_ATTEMPTS) + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestOllamaOnce(params);
    } catch (error: unknown) {
      lastError = error;
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : 0;
      const retryable = status > 0 ? isRetryableStatus(status) : true;
      const shouldRetry = retryable && attempt < maxAttempts;

      if (!shouldRetry) {
        throw error;
      }

      const backoff = Math.max(200, Math.floor(OLLAMA_RETRY_BACKOFF_MS * attempt));
      await sleep(backoff);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw buildError(502, 'Ollama request failed after retries');
}

export function getOllamaRuntimeMetadata(): {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBackoffMs: number;
} {
  return {
    baseUrl: defaultBaseUrl,
    model: defaultModel,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    retryAttempts: Math.max(0, Math.floor(OLLAMA_RETRY_ATTEMPTS)),
    retryBackoffMs: Math.max(200, Math.floor(OLLAMA_RETRY_BACKOFF_MS))
  };
}
