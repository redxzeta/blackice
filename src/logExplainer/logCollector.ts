import { spawn } from 'node:child_process';
import { access, constants, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalyzeLogsBatchLokiRequest, AnalyzeLogsRequest } from './schema.js';

const LOG_COLLECTION_TIMEOUT_MS = Number(process.env.LOG_COLLECTION_TIMEOUT_MS ?? 15_000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES ?? 2_000_000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2_000_000);
const MAX_HOURS = Number(process.env.MAX_HOURS ?? 168);
const MAX_LINES_CAP = Number(process.env.MAX_LINES_CAP ?? 2_000);
const LOKI_BASE_URL = String(process.env.LOKI_BASE_URL ?? '').trim();
const LOKI_TIMEOUT_MS = Number(process.env.LOKI_TIMEOUT_MS ?? 10_000);
const LOKI_MAX_WINDOW_MINUTES = Number(process.env.LOKI_MAX_WINDOW_MINUTES ?? 60);
const LOKI_DEFAULT_WINDOW_MINUTES = Number(process.env.LOKI_DEFAULT_WINDOW_MINUTES ?? 15);
const LOKI_MAX_LINES_CAP = Number(process.env.LOKI_MAX_LINES_CAP ?? 2_000);
const LOKI_MAX_RESPONSE_BYTES = Number(process.env.LOKI_MAX_RESPONSE_BYTES ?? 2_000_000);
const LOKI_REQUIRE_SCOPE_LABELS =
  String(process.env.LOKI_REQUIRE_SCOPE_LABELS ?? 'true').trim().toLowerCase() !== 'false';

type LokiStreamResult = {
  stream?: Record<string, string>;
  values?: [string, string][];
};

type LokiQueryRangeResponse = {
  status?: string;
  data?: {
    resultType?: string;
    result?: LokiStreamResult[];
  };
};

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
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value))
  );
}

export function getAllowedLogFileTargets(): string[] {
  return Array.from(parseAllowedFilePaths()).sort((a, b) => a.localeCompare(b));
}

export function getLokiSyntheticTargets(): string[] {
  return [];
}

export function getLogCollectorLimits(): {
  maxHours: number;
  maxLinesCap: number;
  maxFileBytes: number;
  maxCommandBytes: number;
  collectionTimeoutMs: number;
  loki: {
    enabled: boolean;
    timeoutMs: number;
    maxWindowMinutes: number;
    defaultWindowMinutes: number;
    maxLinesCap: number;
    maxResponseBytes: number;
    requireScopeLabels: boolean;
  };
} {
  return {
    maxHours: MAX_HOURS,
    maxLinesCap: MAX_LINES_CAP,
    maxFileBytes: MAX_FILE_BYTES,
    maxCommandBytes: MAX_COMMAND_BYTES,
    collectionTimeoutMs: LOG_COLLECTION_TIMEOUT_MS,
    loki: {
      enabled: Boolean(LOKI_BASE_URL),
      timeoutMs: Math.max(100, Math.floor(LOKI_TIMEOUT_MS)),
      maxWindowMinutes: Math.max(1, Math.floor(LOKI_MAX_WINDOW_MINUTES)),
      defaultWindowMinutes: Math.max(1, Math.floor(LOKI_DEFAULT_WINDOW_MINUTES)),
      maxLinesCap: Math.max(1, Math.floor(LOKI_MAX_LINES_CAP)),
      maxResponseBytes: Math.max(1_000, Math.floor(LOKI_MAX_RESPONSE_BYTES)),
      requireScopeLabels: LOKI_REQUIRE_SCOPE_LABELS
    }
  };
}

function escapeLogQLLabelValue(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeLogQLStringLiteral(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hasScopeLabelsInRawQuery(query: string): boolean {
  return /\b(?:host|unit)\s*(?:=|!=|=~|!~)\s*"/.test(query);
}

function hasScopeLabelsInFilters(filters: Record<string, string>): boolean {
  return typeof filters.host === 'string' || typeof filters.unit === 'string';
}

export function buildEffectiveLokiQuery(input: AnalyzeLogsBatchLokiRequest): string {
  if (typeof input.query === 'string' && input.query.trim().length > 0) {
    return input.query.trim();
  }

  if (!input.filters) {
    throw buildError(400, 'filters are required when query is not provided');
  }

  const entries = Object.entries(input.filters).sort(([a], [b]) => a.localeCompare(b));
  const selector = entries.map(([key, value]) => `${key}="${escapeLogQLLabelValue(value)}"`).join(',');
  const contains = input.contains ? ` |= "${escapeLogQLStringLiteral(input.contains)}"` : '';
  return `{${selector}}${contains}`;
}

function enforceScopeGuard(input: AnalyzeLogsBatchLokiRequest, effectiveQuery: string): void {
  if (!LOKI_REQUIRE_SCOPE_LABELS || input.allowUnscoped) {
    return;
  }

  const scoped =
    (typeof input.query === 'string' && hasScopeLabelsInRawQuery(effectiveQuery)) ||
    (input.filters !== undefined && hasScopeLabelsInFilters(input.filters));

  if (!scoped) {
    throw buildError(400, 'Loki query must include host or unit label (or set allowUnscoped=true)');
  }
}

export function resolveLokiTimeRange(input: {
  start?: string;
  end?: string;
}): { startNs: string; endNs: string; hours: number } {
  const now = new Date();
  const fallbackEnd = now;
  const fallbackStart = new Date(now.getTime() - Math.max(1, LOKI_DEFAULT_WINDOW_MINUTES) * 60 * 1000);
  const startDate = input.start ? new Date(input.start) : fallbackStart;
  const endDate = input.end ? new Date(input.end) : fallbackEnd;

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw buildError(400, 'start/end must be valid ISO-8601 timestamps');
  }

  if (startDate.getTime() >= endDate.getTime()) {
    throw buildError(400, 'start must be earlier than end');
  }

  const windowMinutes = (endDate.getTime() - startDate.getTime()) / 60_000;
  const maxWindowMinutes = Math.max(1, Math.floor(LOKI_MAX_WINDOW_MINUTES));
  if (windowMinutes > maxWindowMinutes) {
    throw buildError(400, `Loki time window exceeds ${String(maxWindowMinutes)} minutes`);
  }

  const startNs = (BigInt(startDate.getTime()) * 1_000_000n).toString();
  const endNs = (BigInt(endDate.getTime()) * 1_000_000n).toString();
  const hours = Math.max(1 / 60, windowMinutes / 60);
  return { startNs, endNs, hours };
}

function clampLokiLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw buildError(400, 'limit must be a positive integer');
  }
  return Math.min(limit, Math.max(1, Math.floor(LOKI_MAX_LINES_CAP)));
}

function formatStreamLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(',');
}

export async function queryLokiRange(input: {
  query: string;
  startNs: string;
  endNs: string;
  limit: number;
}): Promise<string> {
  if (!LOKI_BASE_URL) {
    throw buildError(500, 'LOKI_BASE_URL is required when source=loki');
  }

  const safeLimit = clampLokiLimit(input.limit);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.floor(LOKI_TIMEOUT_MS)));

  try {
    const queryRangeUrl = new URL('/loki/api/v1/query_range', LOKI_BASE_URL);
    queryRangeUrl.searchParams.set('query', input.query);
    queryRangeUrl.searchParams.set('start', input.startNs);
    queryRangeUrl.searchParams.set('end', input.endNs);
    queryRangeUrl.searchParams.set('limit', String(safeLimit));

    const response = await fetch(queryRangeUrl.toString(), {
      method: 'GET',
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw buildError(502, `Loki query_range failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as LokiQueryRangeResponse;
    if (payload.status !== 'success' || payload.data?.resultType !== 'streams' || !Array.isArray(payload.data.result)) {
      throw buildError(502, 'Loki returned an unexpected query_range payload');
    }

    const flattened: Array<{ ts: bigint; line: string }> = [];
    for (const streamResult of payload.data.result) {
      const labels = streamResult.stream ?? {};
      const labelPrefix = formatStreamLabels(labels);
      const values = Array.isArray(streamResult.values) ? streamResult.values : [];
      for (const tuple of values) {
        if (!Array.isArray(tuple) || tuple.length < 2) {
          continue;
        }
        const tsRaw = tuple[0];
        const lineRaw = tuple[1];
        if (typeof tsRaw !== 'string' || typeof lineRaw !== 'string') {
          continue;
        }
        try {
          const tsNs = BigInt(tsRaw);
          const tsIso = new Date(Number(tsNs / 1_000_000n)).toISOString();
          const merged = labelPrefix ? `${tsIso} [${labelPrefix}] ${lineRaw}` : `${tsIso} ${lineRaw}`;
          flattened.push({ ts: tsNs, line: merged });
        } catch {
          continue;
        }
      }
    }

    flattened.sort((a, b) => {
      if (a.ts < b.ts) {
        return -1;
      }
      if (a.ts > b.ts) {
        return 1;
      }
      return 0;
    });

    const selected = flattened.slice(-safeLimit);
    const maxBytes = Math.max(1_000, Math.floor(LOKI_MAX_RESPONSE_BYTES));
    const outLines: string[] = [];
    let bytesUsed = 0;
    let truncated = false;

    for (const entry of selected) {
      const lineBytes = Buffer.byteLength(entry.line + '\n', 'utf8');
      if (bytesUsed + lineBytes > maxBytes) {
        truncated = true;
        break;
      }
      outLines.push(entry.line);
      bytesUsed += lineBytes;
    }

    if (truncated) {
      outLines.push('[truncated] Loki response exceeded LOKI_MAX_RESPONSE_BYTES');
    }

    return outLines.join('\n');
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw buildError(504, 'Loki request timed out');
    }
    if (typeof error === 'object' && error !== null && 'status' in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw buildError(502, `Loki request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectLokiBatchLogs(input: AnalyzeLogsBatchLokiRequest): Promise<{
  query: string;
  logs: string;
  limit: number;
  hours: number;
}> {
  const query = buildEffectiveLokiQuery(input);
  enforceScopeGuard(input, query);
  const { startNs, endNs, hours } = resolveLokiTimeRange({
    start: input.start,
    end: input.end
  });
  const limit = clampLokiLimit(input.limit);
  const logs = await queryLokiRange({
    query,
    startNs,
    endNs,
    limit
  });
  return { query, logs, limit, hours };
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

    // If file rotated/truncated and cursor is beyond current file size, restart at 0.
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
    const lines = text.split(/\r?\n/);
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
  // Read only from the file tail so large logs can still be analyzed safely.
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
    const lines = tailText.split(/\r?\n/);
    return lines.slice(-safeMaxLines).join('\n');
  } finally {
    await handle.close();
  }
}

export async function collectLogs(input: AnalyzeLogsRequest): Promise<string> {
  if (input.source === 'journalctl') {
    return collectJournalctlLogs(input);
  }

  if (input.source === 'docker') {
    return collectDockerLogs(input);
  }

  return collectFileLogs(input);
}
