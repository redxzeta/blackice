import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const MAX_COLLECTION_TIMEOUT_MS = Number(process.env.LOG_COLLECTION_TIMEOUT_MS ?? 15_000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 2_000_000);
const MAX_COMMAND_BYTES = Number(process.env.MAX_COMMAND_BYTES ?? 2_000_000);
const MAX_HOURS = Number(process.env.MAX_HOURS ?? 168);
const MAX_LINES_CAP = Number(process.env.MAX_LINES_CAP ?? 2_000);

function buildError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeTarget(target) {
  // Strict target validation avoids argument injection and weird path-like inputs.
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(target)) {
    throw buildError(400, 'target contains unsupported characters');
  }
  return target;
}

function clampHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw buildError(400, 'hours must be a positive number');
  }
  return Math.min(Math.floor(hours), MAX_HOURS);
}

function clampMaxLines(maxLines) {
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw buildError(400, 'maxLines must be a positive integer');
  }
  return Math.min(maxLines, MAX_LINES_CAP);
}

async function runAllowedCommand(command, args) {
  // Only explicit read-only commands are allowed. No shell parsing is used.
  if (command !== 'journalctl' && command !== 'docker') {
    throw buildError(500, 'unsupported command');
  }

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
    }, MAX_COLLECTION_TIMEOUT_MS);

    child.stdout.on('data', (buf) => {
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

    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(buildError(500, `failed to execute ${command}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(buildError(502, `${command} failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function collectJournalctlLogs(target, hours, maxLines) {
  const safeTarget = sanitizeTarget(target);
  const safeHours = clampHours(hours);
  const safeMaxLines = clampMaxLines(maxLines);

  const args = ['--no-pager', '--output=short-iso', '--since', `${safeHours} hours ago`, '-n', String(safeMaxLines)];

  // "all" means global journal view; any other target is treated as a systemd unit.
  if (safeTarget !== 'all') {
    args.push('-u', safeTarget);
  }

  return runAllowedCommand('journalctl', args);
}

async function collectDockerLogs(target, hours, maxLines) {
  const safeTarget = sanitizeTarget(target);
  const safeHours = clampHours(hours);
  const safeMaxLines = clampMaxLines(maxLines);

  const sinceDate = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const args = ['logs', '--tail', String(safeMaxLines), '--since', sinceDate, safeTarget];

  return runAllowedCommand('docker', args);
}

function parseAllowedFilePaths() {
  const raw = process.env.ALLOWED_LOG_FILES ?? '';
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => path.resolve(v));

  return new Set(values);
}

async function collectFileLogs(target, _hours, maxLines) {
  const safeMaxLines = clampMaxLines(maxLines);
  const requestedPath = path.resolve(target);
  const allowed = parseAllowedFilePaths();

  // Explicit file allowlist only; no directories or wildcard behavior.
  if (!allowed.has(requestedPath)) {
    throw buildError(403, 'file target is not in ALLOWED_LOG_FILES');
  }

  await access(requestedPath, constants.R_OK);

  const lines = [];
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

export async function collectLogs({ source, target, hours, maxLines }) {
  if (source === 'journalctl') {
    return collectJournalctlLogs(target, hours, maxLines);
  }

  if (source === 'docker') {
    return collectDockerLogs(target, hours, maxLines);
  }

  if (source === 'file') {
    return collectFileLogs(target, hours, maxLines);
  }

  throw buildError(400, 'unsupported source');
}
