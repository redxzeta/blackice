import { spawn } from 'node:child_process';
import { access, constants, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalyzeLogsRequest } from './schema.js';

const LOG_COLLECTION_TIMEOUT_MS = Number(process.env.LOG_COLLECTION_TIMEOUT_MS ?? 15_000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES ?? 2_000_000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2_000_000);
const MAX_HOURS = Number(process.env.MAX_QUERY_HOURS ?? process.env.MAX_HOURS ?? 168);
const MAX_LINES_CAP = Number(process.env.MAX_LINES ?? process.env.MAX_LINES_CAP ?? 2_000);
const LOKI_BASE_URL = String(process.env.LOKI_BASE_URL ?? '').trim().replace(/\/$/, '');
const LOKI_TENANT_ID = String(process.env.LOKI_TENANT_ID ?? '').trim();
const LOKI_AUTH_BEARER = String(process.env.LOKI_AUTH_BEARER ?? '').trim();

function buildError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function sanitizeTarget(target: string): string {
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(target)) {
    throw buildError(400, 'target contains unsupported characters');
  }
  return target;
}

function clampHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw buildError(400, 'hours must be a positive number');
  }
  return Math.min(Math.floor(hours), MAX_HOURS);
}

function clampMaxLines(maxLines: number): number {
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw buildError(400, 'maxLines must be a positive integer');
  }
  return Math.min(maxLines, MAX_LINES_CAP);
}

function runAllowedCommand(command: 'journalctl' | 'docker', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(buildError(504, `log collection timed out for ${command}`));
    }, LOG_COLLECTION_TIMEOUT_MS);

    child.stdout.on('data', (buf: Buffer) => {
      if (settled) {
        return;
      }

      stdout += buf.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_COMMAND_BYTES) {
        settled = true;
        child.kill('SIGKILL');
        reject(buildError(413, 'command output exceeds MAX_COMMAND_BYTES limit'));
      }
    });

    child.stderr.on('data', (buf: Buffer) => {
      if (settled) {
        return;
      }
      stderr += buf.toString('utf8');
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(buildError(500, `failed to execute ${command}: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(buildError(502, `${command} failed: ${stderr.trim() || `exit code ${String(code)}`}`));
        return;
      }

      resolve(stdout);
    });
  });
}

async function collectJournalctlLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeTarget = sanitizeTarget(input.target);
  const safeHours = clampHours(input.hours);
  const safeMaxLines = clampMaxLines(input.maxLines);

  const args = ['--no-pager', '--output=short-iso', '--since', `${safeHours} hours ago`, '-n', String(safeMaxLines)];

  if (safeTarget !== 'all') {
    args.push('-u', safeTarget);
  }

  return runAllowedCommand('journalctl', args);
}

async function collectDockerLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeTarget = sanitizeTarget(input.target);
  const safeHours = clampHours(input.hours);
  const safeMaxLines = clampMaxLines(input.maxLines);

  const sinceDate = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const args = ['logs', '--tail', String(safeMaxLines), '--since', sinceDate, safeTarget];

  return runAllowedCommand('docker', args);
}

function parseAllowedFilePaths(): Set<string> {
  return new Set(
    String(process.env.ALLOWED_LOG_FILES ?? '')
      .trimEnd().split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value))
  );
}

function parseAllowedLokiSelectorsRaw(): string[] {
  const raw = String(process.env.ALLOWED_LOKI_SELECTORS ?? '').trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall back to plain parser
    }
  }

  return raw
    .split(/\n|;/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseSimpleSelector(selector: string): Map<string, string> {
  const trimmed = selector.trim();

  if (/\n|\r/.test(trimmed)) {
    throw buildError(400, 'selector must be a single line');
  }

  if (/\||!=|=~|!~/.test(trimmed)) {
    throw buildError(400, 'selector contains unsupported operators');
  }

  const match = trimmed.match(/^\{\s*([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*"[^"\n\r]*"\s*(,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*"[^"\n\r]*"\s*)*)?\}$/);
  if (!match) {
    throw buildError(400, 'selector must be in format {key="value",key2="value2"}');
  }

  const inner = trimmed.slice(1, -1).trim();
  const entries = inner ? inner.split(',') : [];
  const labels = new Map<string, string>();

  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split('=');
    if (!rawKey || rawValue === undefined) {
      throw buildError(400, 'selector contains invalid label pair');
    }
    const key = rawKey.trim();
    const valueMatch = rawValue.trim().match(/^"([^"\n\r]*)"$/);
    if (!valueMatch) {
      throw buildError(400, 'selector value must be a quoted string');
    }

    labels.set(key, valueMatch[1]);
  }

  return labels;
}

function normalizeSelector(selector: string): string {
  const labels = parseSimpleSelector(selector);
  const ordered = Array.from(labels.entries()).sort(([a], [b]) => a.localeCompare(b));
  return `{${ordered.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}

function isSupersetSelector(candidate: Map<string, string>, base: Map<string, string>): boolean {
  for (const [key, value] of base.entries()) {
    if (candidate.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function isLokiEnabled(): boolean {
  return Boolean(LOKI_BASE_URL);
}

export function getAllowedLokiSelectors(): string[] {
  return parseAllowedLokiSelectorsRaw().map(normalizeSelector).sort((a, b) => a.localeCompare(b));
}

export function getLokiSyntheticTargets(): string[] {
  return getAllowedLokiSelectors().map((selector) => `loki:${selector}`);
}

export function validateAllowedLokiSelector(selector: string): string {
  if (!isLokiEnabled()) {
    throw buildError(503, 'loki source is disabled (set LOKI_BASE_URL)');
  }

  const normalized = normalizeSelector(selector);
  const candidate = parseSimpleSelector(normalized);
  const allowed = getAllowedLokiSelectors();

  if (allowed.length === 0) {
    throw buildError(503, 'loki source is enabled but ALLOWED_LOKI_SELECTORS is empty');
  }

  const permitted = allowed.some((allowedSelector) => {
    const base = parseSimpleSelector(allowedSelector);
    return isSupersetSelector(candidate, base);
  });

  if (!permitted) {
    throw buildError(403, 'selector is not allowlisted');
  }

  return normalized;
}

function headersWithAuth(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (LOKI_TENANT_ID) {
    headers['X-Scope-OrgID'] = LOKI_TENANT_ID;
  }
  if (LOKI_AUTH_BEARER) {
    headers.Authorization = `Bearer ${LOKI_AUTH_BEARER}`;
  }
  return headers;
}

export async function checkLokiHealth(): Promise<{ enabled: boolean; ok: boolean; status: number; details: string }> {
  if (!isLokiEnabled()) {
    return {
      enabled: false,
      ok: false,
      status: 503,
      details: 'loki is disabled: set LOKI_BASE_URL'
    };
  }

  try {
    const response = await fetch(`${LOKI_BASE_URL}/ready`, {
      headers: headersWithAuth()
    });

    return {
      enabled: true,
      ok: response.ok,
      status: response.status,
      details: response.ok ? 'loki is ready' : `loki readiness check failed with status ${response.status}`
    };
  } catch (error: unknown) {
    return {
      enabled: true,
      ok: false,
      status: 502,
      details: error instanceof Error ? error.message : 'failed to reach loki'
    };
  }
}

export async function collectLokiLogs(input: {
  selector: string;
  hours?: number;
  sinceMinutes?: number;
  maxLines: number;
}): Promise<string> {
  if (!isLokiEnabled()) {
    throw buildError(503, 'loki source is disabled (set LOKI_BASE_URL)');
  }

  const selector = validateAllowedLokiSelector(input.selector);
  const safeMaxLines = clampMaxLines(input.maxLines);

  let windowMs = clampHours(input.hours ?? 6) * 60 * 60 * 1000;
  if (typeof input.sinceMinutes === 'number') {
    if (!Number.isInteger(input.sinceMinutes) || input.sinceMinutes <= 0) {
      throw buildError(400, 'sinceMinutes must be a positive integer');
    }

    windowMs = Math.min(input.sinceMinutes * 60 * 1000, MAX_HOURS * 60 * 60 * 1000);
  }

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const startNs = nowNs - BigInt(windowMs) * 1_000_000n;

  const url = new URL(`${LOKI_BASE_URL}/loki/api/v1/query_range`);
  url.searchParams.set('query', selector);
  url.searchParams.set('start', startNs.toString());
  url.searchParams.set('end', nowNs.toString());
  url.searchParams.set('direction', 'forward');
  url.searchParams.set('limit', String(safeMaxLines));

  let response: Response;
  try {
    response = await fetch(url, { headers: headersWithAuth() });
  } catch (error: unknown) {
    throw buildError(502, `failed to query loki: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  if (!response.ok) {
    throw buildError(502, `loki query failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    status?: string;
    data?: {
      resultType?: string;
      result?: Array<{
        stream?: Record<string, string>;
        values?: Array<[string, string]>;
      }>;
    };
  };

  if (payload.status !== 'success' || !payload.data || payload.data.resultType !== 'streams') {
    throw buildError(502, 'invalid loki response payload');
  }

  const merged: Array<{ ts: bigint; line: string }> = [];

  for (const stream of payload.data.result ?? []) {
    for (const value of stream.values ?? []) {
      const [tsRaw, line] = value;
      const ts = BigInt(tsRaw);
      merged.push({ ts, line: String(line ?? '') });
    }
  }

  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return merged.slice(-safeMaxLines).map((entry) => entry.line).join('\n');
}

export function getAllowedLogFileTargets(): string[] {
  return Array.from(parseAllowedFilePaths()).sort((a, b) => a.localeCompare(b));
}

export function getLogCollectorLimits(): {
  maxHours: number;
  maxLinesCap: number;
  maxFileBytes: number;
  maxCommandBytes: number;
  collectionTimeoutMs: number;
} {
  return {
    maxHours: MAX_HOURS,
    maxLinesCap: MAX_LINES_CAP,
    maxFileBytes: MAX_FILE_BYTES,
    maxCommandBytes: MAX_COMMAND_BYTES,
    collectionTimeoutMs: LOG_COLLECTION_TIMEOUT_MS
  };
}

export type IncrementalFileLogsResult = {
  logs: string;
  fromCursor: number;
  nextCursor: number;
  rotated: boolean;
  truncatedByBytes: boolean;
};

export async function collectFileLogsIncremental(input: {
  target: string;
  cursor: number;
  maxLines: number;
}): Promise<IncrementalFileLogsResult> {
  const safeMaxLines = clampMaxLines(input.maxLines);
  const requestedPath = path.resolve(input.target);
  const allowed = parseAllowedFilePaths();

  if (!allowed.has(requestedPath)) {
    throw buildError(403, 'file target is not in ALLOWED_LOG_FILES');
  }

  await access(requestedPath, constants.R_OK);
  const handle = await openFile(requestedPath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const requestedCursor = Math.max(0, Math.floor(input.cursor));
    let fromCursor = Math.min(requestedCursor, size);
    let rotated = false;

    if (requestedCursor > size) {
      fromCursor = 0;
      rotated = true;
    }

    if (fromCursor >= size) {
      return {
        logs: '',
        fromCursor,
        nextCursor: fromCursor,
        rotated,
        truncatedByBytes: false
      };
    }

    const availableBytes = size - fromCursor;
    const readBytesLimit = Math.min(MAX_FILE_BYTES, availableBytes);
    const truncatedByBytes = availableBytes > MAX_FILE_BYTES;
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    let position = fromCursor;
    let remaining = readBytesLimit;

    while (remaining > 0) {
      const toRead = Math.min(chunkSize, remaining);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, position);
      if (bytesRead <= 0) {
        break;
      }
      const slice = buf.subarray(0, bytesRead);
      chunks.push(slice);
      position += bytesRead;
      remaining -= bytesRead;
    }

    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text.trimEnd().split(/\r?\n/);
    const logs = lines.slice(-safeMaxLines).join('\n');

    return {
      logs,
      fromCursor,
      nextCursor: position,
      rotated,
      truncatedByBytes
    };
  } finally {
    await handle.close();
  }
}

async function collectFileLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeMaxLines = clampMaxLines(input.maxLines);
  const requestedPath = path.resolve(input.target);
  const allowed = parseAllowedFilePaths();

  if (!allowed.has(requestedPath)) {
    throw buildError(403, 'file target is not in ALLOWED_LOG_FILES');
  }

  await access(requestedPath, constants.R_OK);
  const handle = await openFile(requestedPath, 'r');
  try {
    const stat = await handle.stat();
    const chunkSize = 64 * 1024;
    let position = stat.size;
    let bytesCollected = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && bytesCollected < MAX_FILE_BYTES && newlineCount <= safeMaxLines) {
      const toRead = Math.min(chunkSize, position);
      position -= toRead;

      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, position);
      const slice = buf.subarray(0, bytesRead);
      chunks.unshift(slice);
      bytesCollected += bytesRead;

      for (let i = 0; i < slice.length; i += 1) {
        if (slice[i] === 0x0a) {
          newlineCount += 1;
        }
      }
    }

    const tailText = Buffer.concat(chunks).toString('utf8');
    const lines = tailText.trimEnd().split(/\r?\n/);
    return lines.slice(-safeMaxLines).join('\n');
  } finally {
    await handle.close();
  }
}

export async function collectLogs(input: AnalyzeLogsRequest): Promise<string> {
  if (input.source === 'journalctl' || input.source === 'journald') {
    return collectJournalctlLogs(input);
  }

  if (input.source === 'docker') {
    return collectDockerLogs(input);
  }

  return collectFileLogs(input);
}
