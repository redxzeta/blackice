import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { access, constants, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AnalyzeLogsBatchLokiRequest, AnalyzeLogsRequest } from './schema.js';

const LOG_COLLECTION_TIMEOUT_MS = Number(process.env.LOG_COLLECTION_TIMEOUT_MS ?? 15_000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES ?? 2_000_000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2_000_000);
const MAX_HOURS = Number(process.env.MAX_QUERY_HOURS ?? process.env.MAX_HOURS ?? 168);
const MAX_LINES_CAP = Number(process.env.MAX_LINES ?? process.env.MAX_LINES_CAP ?? 2_000);
const LOKI_BASE_URL = String(process.env.LOKI_BASE_URL ?? '').trim().replace(/\/$/, '');
const LOKI_TENANT_ID = String(process.env.LOKI_TENANT_ID ?? '').trim();
const LOKI_AUTH_BEARER = String(process.env.LOKI_AUTH_BEARER ?? '').trim();
const LOKI_TIMEOUT_MS = Number(process.env.LOKI_TIMEOUT_MS ?? LOG_COLLECTION_TIMEOUT_MS);
const LOKI_MAX_WINDOW_MINUTES = Number(process.env.LOKI_MAX_WINDOW_MINUTES ?? 60);
const LOKI_DEFAULT_WINDOW_MINUTES = Number(process.env.LOKI_DEFAULT_WINDOW_MINUTES ?? 15);
const LOKI_MAX_LINES_CAP = Number(process.env.LOKI_MAX_LINES_CAP ?? MAX_LINES_CAP);
const LOKI_MAX_RESPONSE_BYTES = Number(process.env.LOKI_MAX_RESPONSE_BYTES ?? MAX_COMMAND_BYTES);
const LOKI_REQUIRE_SCOPE_LABELS =
  String(process.env.LOKI_REQUIRE_SCOPE_LABELS ?? 'true').trim().toLowerCase() !== 'false';
const LOKI_RULES_FILE = path.resolve(String(process.env.LOKI_RULES_FILE ?? './config/loki-rules.yaml').trim());

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

type LokiRulesConfig = {
  job?: string;
  allowedLabels: Set<string>;
  hosts: Set<string>;
  units: Set<string>;
  hostsRegex: RegExp | null;
  unitsRegex: RegExp | null;
};

let cachedLokiRules: LokiRulesConfig | null = null;

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

function parseStringArray(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) {
      throw buildError(503, `Loki rules file missing required field: ${field}`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw buildError(503, `Loki rules field "${field}" must be an array of strings`);
  }

  return value
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw buildError(503, `Loki rules field "${field}" must contain only strings`);
      }
      return entry.trim();
    })
    .filter(Boolean);
}

function parseOptionalRegex(raw: string, field: string): RegExp | null {
  if (!raw) {
    return null;
  }

  try {
    return new RegExp(raw);
  } catch {
    throw buildError(503, `Invalid regex in Loki rules field "${field}"`);
  }
}

function matchesAllowlist(value: string, list: Set<string>, regex: RegExp | null): boolean {
  if (list.size > 0 && list.has(value)) {
    return true;
  }
  if (regex && regex.test(value)) {
    return true;
  }
  return false;
}

function loadLokiRulesConfig(): LokiRulesConfig {
  if (cachedLokiRules) {
    return cachedLokiRules;
  }

  if (!existsSync(LOKI_RULES_FILE)) {
    throw buildError(503, `Loki rules file not found: ${LOKI_RULES_FILE}`);
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(LOKI_RULES_FILE, 'utf8');
    parsed = parseYaml(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw buildError(503, `Failed to read Loki rules file (${LOKI_RULES_FILE}): ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw buildError(503, 'Loki rules file must contain a top-level object');
  }

  const body = parsed as Record<string, unknown>;
  const allowedLabels = new Set(parseStringArray(body.allowedLabels, 'allowedLabels', true));
  if (allowedLabels.size === 0) {
    throw buildError(503, 'Loki rules file must include at least one allowedLabels entry');
  }

  const job = typeof body.job === 'string' ? body.job.trim() : '';
  if (body.job !== undefined && typeof body.job !== 'string') {
    throw buildError(503, 'Loki rules field "job" must be a string');
  }

  const hosts = new Set(parseStringArray(body.hosts, 'hosts', false));
  const units = new Set(parseStringArray(body.units, 'units', false));

  let hostsRegexRaw = '';
  if (body.hostsRegex !== undefined) {
    if (typeof body.hostsRegex !== 'string') {
      throw buildError(503, 'Loki rules field "hostsRegex" must be a string');
    }
    hostsRegexRaw = body.hostsRegex.trim();
  }

  let unitsRegexRaw = '';
  if (body.unitsRegex !== undefined) {
    if (typeof body.unitsRegex !== 'string') {
      throw buildError(503, 'Loki rules field "unitsRegex" must be a string');
    }
    unitsRegexRaw = body.unitsRegex.trim();
  }

  cachedLokiRules = {
    job: job || undefined,
    allowedLabels,
    hosts,
    units,
    hostsRegex: parseOptionalRegex(hostsRegexRaw, 'hostsRegex'),
    unitsRegex: parseOptionalRegex(unitsRegexRaw, 'unitsRegex')
  };
  return cachedLokiRules;
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
  const labels = new Map<string, string>();

  if (!inner) {
    return labels;
  }

  const pairPattern = /\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"\n\r]*)"\s*(?:,|$)/gy;

  while (pairPattern.lastIndex < inner.length) {
    const pairMatch = pairPattern.exec(inner);
    if (!pairMatch) {
      throw buildError(400, 'selector contains invalid label pair');
    }

    const [, key, value] = pairMatch;
    labels.set(key, value);
  }

  return labels;
}

function normalizeSelector(selector: string): string {
  const labels = parseSimpleSelector(selector);
  const ordered = Array.from(labels.entries()).sort(([a], [b]) => a.localeCompare(b));
  return `{${ordered.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}

function validateLokiLabels(labels: Record<string, string>): void {
  const rules = loadLokiRulesConfig();

  for (const key of Object.keys(labels)) {
    if (!rules.allowedLabels.has(key)) {
      throw buildError(403, `Loki label "${key}" is not allowed`);
    }
  }

  if (rules.job) {
    const job = labels.job;
    if (!job) {
      throw buildError(403, 'Loki filters must include job');
    }
    if (job !== rules.job) {
      throw buildError(403, `Loki job "${job}" is not allowed`);
    }
  }

  if (typeof labels.host === 'string') {
    if (!matchesAllowlist(labels.host, rules.hosts, rules.hostsRegex)) {
      throw buildError(403, `Loki host "${labels.host}" is not allowed`);
    }
  }

  if (typeof labels.unit === 'string') {
    if (!matchesAllowlist(labels.unit, rules.units, rules.unitsRegex)) {
      throw buildError(403, `Loki unit "${labels.unit}" is not allowed`);
    }
  }
}

export function isLokiEnabled(): boolean {
  return Boolean(LOKI_BASE_URL);
}

export function getAllowedLokiSelectors(): string[] {
  return [];
}

export function getLokiSyntheticTargets(): string[] {
  return [];
}

export function validateAllowedLokiSelector(selector: string): string {
  if (!isLokiEnabled()) {
    throw buildError(503, 'loki source is disabled (set LOKI_BASE_URL)');
  }

  const normalized = normalizeSelector(selector);
  const candidate = parseSimpleSelector(normalized);
  validateLokiLabels(Object.fromEntries(candidate.entries()));

  return normalized;
}

function extractSelectorExpression(query: string): string {
  const start = query.indexOf('{');
  if (start < 0) {
    throw buildError(400, 'Loki query must include a selector block');
  }
  let depth = 0;
  for (let i = start; i < query.length; i += 1) {
    const ch = query[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return query.slice(start, i + 1);
      }
    }
  }
  throw buildError(400, 'Loki query contains an unclosed selector block');
}

function ensureAllowlistedSelectorFromQuery(query: string): void {
  const selector = extractSelectorExpression(query);
  validateAllowedLokiSelector(selector);
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
  if (input.source !== 'loki') {
    throw buildError(400, 'source must be loki');
  }

  if (typeof input.query === 'string' && input.query.trim().length > 0) {
    throw buildError(403, 'raw Loki query is not allowed; use filters');
  }

  if (!input.filters) {
    throw buildError(400, 'filters are required when query is not provided');
  }

  validateLokiLabels(input.filters);

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

  const maxWindowMinutes = Math.max(1, Math.floor(LOKI_MAX_WINDOW_MINUTES));
  const windowMinutes = (endDate.getTime() - startDate.getTime()) / 60_000;
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
  // Query newest-first so limit captures the latest incidents under high-volume streams.
  url.searchParams.set('direction', 'backward');
  url.searchParams.set('limit', String(safeMaxLines));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: headersWithAuth(),
      signal: AbortSignal.timeout(LOG_COLLECTION_TIMEOUT_MS)
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw buildError(504, 'loki query timed out');
    }
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

export async function queryLokiRange(input: {
  query: string;
  startNs: string;
  endNs: string;
  limit: number;
}): Promise<string> {
  if (!isLokiEnabled()) {
    throw buildError(503, 'loki source is disabled (set LOKI_BASE_URL)');
  }

  const safeLimit = clampLokiLimit(input.limit);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.floor(LOKI_TIMEOUT_MS)));

  try {
    const queryRangeUrl = new URL(`${LOKI_BASE_URL}/loki/api/v1/query_range`);
    queryRangeUrl.searchParams.set('query', input.query);
    queryRangeUrl.searchParams.set('start', input.startNs);
    queryRangeUrl.searchParams.set('end', input.endNs);
    queryRangeUrl.searchParams.set('limit', String(safeLimit));

    const response = await fetch(queryRangeUrl, {
      headers: headersWithAuth(),
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

    flattened.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

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
  if (input.source !== 'loki') {
    throw buildError(400, 'source must be loki');
  }

  const query = buildEffectiveLokiQuery(input);
  enforceScopeGuard(input, query);
  ensureAllowlistedSelectorFromQuery(query);
  const { startNs, endNs, hours } = resolveLokiTimeRange({
    start: input.start,
    end: input.end
  });
  const limit = clampLokiLimit(input.limit ?? 2_000);
  const logs = await queryLokiRange({
    query,
    startNs,
    endNs,
    limit
  });

  return { query, logs, limit, hours };
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
      enabled: isLokiEnabled(),
      timeoutMs: Math.max(100, Math.floor(LOKI_TIMEOUT_MS)),
      maxWindowMinutes: Math.max(1, Math.floor(LOKI_MAX_WINDOW_MINUTES)),
      defaultWindowMinutes: Math.max(1, Math.floor(LOKI_DEFAULT_WINDOW_MINUTES)),
      maxLinesCap: Math.max(1, Math.floor(LOKI_MAX_LINES_CAP)),
      maxResponseBytes: Math.max(1_000, Math.floor(LOKI_MAX_RESPONSE_BYTES)),
      requireScopeLabels: LOKI_REQUIRE_SCOPE_LABELS
    }
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
