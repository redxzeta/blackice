const defaultBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.230:11434';
const defaultModel = process.env.OLLAMA_MODEL ?? 'qwen2.5:14b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45_000);

type OllamaGenerateResponse = {
  response?: string;
};

function buildError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export async function analyzeLogsWithOllama(params: { systemPrompt: string; userPrompt: string }): Promise<string> {
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
      throw buildError(502, `Ollama request failed (${response.status}): ${body.slice(0, 300)}`);
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
