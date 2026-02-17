type LogLevel = 'debug' | 'info';
type LogLevelWithError = LogLevel | 'error';

type LogEntry = {
  ts: string;
  level: LogLevelWithError;
  msg: string;
  fields: Record<string, unknown>;
};

const level: LogLevel = process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info';
const maxLogBufferEntries = Number(process.env.LOG_BUFFER_MAX_ENTRIES ?? 2000);
const logBuffer: LogEntry[] = [];

function shouldLog(msgLevel: LogLevel): boolean {
  if (level === 'debug') {
    return true;
  }
  return msgLevel === 'info';
}

function baseLog(msgLevel: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  pushLogEntry({
    ts,
    level: msgLevel,
    msg: message,
    fields
  });

  if (!shouldLog(msgLevel)) {
    return;
  }

  const payload = {
    ts,
    level: msgLevel,
    msg: message,
    ...fields
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function pushLogEntry(entry: LogEntry): void {
  logBuffer.push(entry);
  while (logBuffer.length > maxLogBufferEntries) {
    logBuffer.shift();
  }
}

function parseWindowMs(raw: string | undefined): number {
  if (!raw) {
    return 60 * 60 * 1000;
  }

  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) {
    return 60 * 60 * 1000;
  }

  const value = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 's' ? 1000 :
      unit === 'm' ? 60 * 1000 :
        unit === 'h' ? 60 * 60 * 1000 :
          24 * 60 * 60 * 1000;

  return value * multiplier;
}

export function getRecentLogs(limit = 100): LogEntry[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 1000)) : 100;
  return logBuffer.slice(-safeLimit);
}

export function getLogMetrics(windowRaw: string | undefined): {
  window: string;
  windowMs: number;
  total: number;
  byLevel: Record<LogLevelWithError, number>;
  byMessage: Record<string, number>;
} {
  const window = windowRaw?.trim() ? windowRaw.trim() : '1h';
  const windowMs = parseWindowMs(windowRaw);
  const sinceTs = Date.now() - windowMs;
  const byLevel: Record<LogLevelWithError, number> = { debug: 0, info: 0, error: 0 };
  const byMessage: Record<string, number> = {};
  let total = 0;

  for (const entry of logBuffer) {
    const ts = Date.parse(entry.ts);
    if (Number.isNaN(ts) || ts < sinceTs) {
      continue;
    }

    total += 1;
    byLevel[entry.level] += 1;
    byMessage[entry.msg] = (byMessage[entry.msg] ?? 0) + 1;
  }

  return {
    window,
    windowMs,
    total,
    byLevel,
    byMessage
  };
}

export const log = {
  debug: (message: string, fields: Record<string, unknown> = {}): void => {
    baseLog('debug', message, fields);
  },
  info: (message: string, fields: Record<string, unknown> = {}): void => {
    baseLog('info', message, fields);
  },
  error: (message: string, fields: Record<string, unknown> = {}): void => {
    const ts = new Date().toISOString();
    pushLogEntry({
      ts,
      level: 'error',
      msg: message,
      fields
    });

    const payload = {
      ts,
      level: 'error',
      msg: message,
      ...fields
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
};
