import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { AnalyzeLogsRequest } from './schema.js';

const LOG_COLLECTION_TIMEOUT_MS = Number(process.env.LOG_COLLECTION_TIMEOUT_MS ?? 15_000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES ?? 2_000_000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2_000_000);
const MAX_HOURS = Number(process.env.MAX_HOURS ?? 168);
const MAX_LINES_CAP = Number(process.env.MAX_LINES_CAP ?? 2_000);

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

async function collectFileLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeMaxLines = clampMaxLines(input.maxLines);
  const requestedPath = path.resolve(input.target);
  const allowed = parseAllowedFilePaths();

  if (!allowed.has(requestedPath)) {
    throw buildError(403, 'file target is not in ALLOWED_LOG_FILES');
  }

  await access(requestedPath, constants.R_OK);

  const lines: string[] = [];
  let totalBytes = 0;

  const stream = createReadStream(requestedPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    totalBytes += Buffer.byteLength(line, 'utf8');

    if (totalBytes > MAX_FILE_BYTES) {
      throw buildError(413, 'file exceeds MAX_FILE_BYTES limit');
    }

    lines.push(line);
    if (lines.length > safeMaxLines) {
      lines.shift();
    }
  }

  return lines.join('\n');
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
