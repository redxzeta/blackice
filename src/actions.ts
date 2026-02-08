import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { ActionEnvelope } from './schema.js';
import { runWorkerText } from './ollama.js';
import { chooseActionModel } from './router.js';

const execFileAsync = promisify(execFile);
const ACTIONS_ENABLED = (process.env.ACTIONS_ENABLED ?? 'true').toLowerCase() === 'true';
const COMMAND_TIMEOUT_MS = 4_000;

const allowlistedLogEntries = (process.env.ALLOWLIST_LOG_PATHS ?? '/var/log/syslog,/var/log/auth.log')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

type ActionResult = {
  text: string;
  action: string;
};

async function runSafeCmd(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  return stdout.trim();
}

async function runSummaryAction(action: ActionEnvelope): Promise<string> {
  const route = chooseActionModel(action.action);
  const directive =
    action.action === 'summarize'
      ? 'Summarize the input with concise bullet points and key facts.'
      : action.action === 'extract'
        ? 'Extract entities, key values, and important facts from the input.'
        : 'Transform the input according to options and preserve factual meaning.';

  const prompt = `${directive}\n\nOptions: ${JSON.stringify(action.options)}\n\nInput:\n${action.input}`;
  const result = await runWorkerText({
    modelId: route.model,
    input: prompt
  });

  return result.text;
}

async function healthcheck(): Promise<string> {
  const hostname = os.hostname();
  const uptimeSec = Math.floor(os.uptime());
  const diskUsage = await runSafeCmd('df', ['-h', '/']);

  return [
    `hostname: ${hostname}`,
    `uptime_seconds: ${uptimeSec}`,
    'disk_usage:',
    diskUsage
  ].join('\n');
}

async function listServices(options: Record<string, unknown>): Promise<string> {
  const mode = typeof options.mode === 'string' ? options.mode : 'auto';

  if (mode === 'docker' || mode === 'auto') {
    try {
      const dockerOut = await runSafeCmd('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}']);
      if (dockerOut) {
        return `docker_containers:\n${dockerOut}`;
      }
    } catch {
      if (mode === 'docker') {
        throw new Error('Docker command failed.');
      }
    }
  }

  if (mode === 'systemd' || mode === 'auto') {
    const systemdOut = await runSafeCmd('systemctl', [
      'list-units',
      '--type=service',
      '--state=running',
      '--no-pager',
      '--no-legend'
    ]);
    return `systemd_services:\n${systemdOut}`;
  }

  throw new Error('Invalid mode for list_services. Use auto, docker, or systemd.');
}

async function pathIsAllowlisted(requestedPath: string): Promise<boolean> {
  let realRequested: string;
  try {
    realRequested = await fs.realpath(requestedPath);
  } catch {
    return false;
  }

  for (const entry of allowlistedLogEntries) {
    try {
      const realAllowed = await fs.realpath(entry);
      const stat = await fs.stat(realAllowed);
      if (stat.isDirectory()) {
        const normalized = realAllowed.endsWith(path.sep) ? realAllowed : `${realAllowed}${path.sep}`;
        if (realRequested.startsWith(normalized)) {
          return true;
        }
      } else if (realRequested === realAllowed) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function tailLog(options: Record<string, unknown>): Promise<string> {
  const file = typeof options.path === 'string' ? options.path : '';
  const linesRaw = typeof options.lines === 'number' ? options.lines : Number(options.lines ?? 100);
  const lines = Number.isFinite(linesRaw) ? Math.min(Math.max(Math.floor(linesRaw), 1), 500) : 100;

  if (!file) {
    throw new Error('tail_log requires options.path.');
  }

  const isAllowed = await pathIsAllowlisted(file);
  if (!isAllowed) {
    throw new Error('Requested path is not allowlisted.');
  }

  const output = await runSafeCmd('tail', ['-n', String(lines), file]);
  return `tail_log(${file}, lines=${lines}):\n${output}`;
}

export async function executeAction(actionEnvelope: ActionEnvelope): Promise<ActionResult> {
  if (!ACTIONS_ENABLED) {
    throw new Error('Actions are disabled by ACTIONS_ENABLED=false.');
  }

  switch (actionEnvelope.action) {
    case 'summarize':
    case 'extract':
    case 'transform':
      return {
        action: actionEnvelope.action,
        text: await runSummaryAction(actionEnvelope)
      };
    case 'healthcheck':
      return {
        action: actionEnvelope.action,
        text: await healthcheck()
      };
    case 'list_services':
      return {
        action: actionEnvelope.action,
        text: await listServices(actionEnvelope.options)
      };
    case 'tail_log':
      return {
        action: actionEnvelope.action,
        text: await tailLog(actionEnvelope.options)
      };
    default:
      throw new Error('Unsupported action.');
  }
}
