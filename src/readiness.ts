import { ollamaBaseURL } from './ollama.js';

const DEFAULT_TIMEOUT_MS = 1500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10000;

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseStrictMode(raw: string | undefined): boolean {
  const value = String(raw ?? '1').trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'no');
}

export const readinessTimeoutMs = parseBoundedInt(
  process.env.READINESS_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS
);

export const readinessStrict = parseStrictMode(process.env.READINESS_STRICT);

export type ReadinessCheckResult = {
  ok: boolean;
  checks: {
    app: { ok: true };
    ollama: {
      ok: boolean;
      baseUrl: string;
      latencyMs?: number;
      status?: number;
      reason?: string;
    };
  };
  ts: string;
};

export async function checkReadiness(): Promise<ReadinessCheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readinessTimeoutMs);

  const ollamaCheck: ReadinessCheckResult['checks']['ollama'] = {
    ok: false,
    baseUrl: ollamaBaseURL
  };

  try {
    const response = await fetch(`${ollamaBaseURL}/tags`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    ollamaCheck.latencyMs = Date.now() - started;
    ollamaCheck.status = response.status;

    if (!response.ok) {
      ollamaCheck.reason = `upstream_status_${response.status}`;
    } else {
      ollamaCheck.ok = true;
    }
  } catch (error) {
    ollamaCheck.latencyMs = Date.now() - started;
    ollamaCheck.reason = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok: ollamaCheck.ok,
    checks: {
      app: { ok: true },
      ollama: ollamaCheck
    },
    ts: new Date().toISOString()
  };
}
