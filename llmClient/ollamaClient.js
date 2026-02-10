const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://192.168.1.230:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:14b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45_000);

function buildError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function analyzeLogsWithOllama({ systemPrompt, userPrompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: systemPrompt,
        prompt: userPrompt,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw buildError(502, `Ollama request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = typeof data?.response === 'string' ? data.response : '';

    if (!text.trim()) {
      throw buildError(502, 'Ollama returned an empty response');
    }

    return text;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw buildError(504, 'Ollama request timed out');
    }

    if (err?.status) {
      throw err;
    }

    throw buildError(502, `Ollama request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}
