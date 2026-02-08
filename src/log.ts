type LogLevel = 'debug' | 'info';

const level: LogLevel = process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info';

function shouldLog(msgLevel: LogLevel): boolean {
  if (level === 'debug') {
    return true;
  }
  return msgLevel === 'info';
}

function baseLog(msgLevel: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(msgLevel)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level: msgLevel,
    msg: message,
    ...fields
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const log = {
  debug: (message: string, fields: Record<string, unknown> = {}): void => {
    baseLog('debug', message, fields);
  },
  info: (message: string, fields: Record<string, unknown> = {}): void => {
    baseLog('info', message, fields);
  },
  error: (message: string, fields: Record<string, unknown> = {}): void => {
    const payload = {
      ts: new Date().toISOString(),
      level: 'error',
      msg: message,
      ...fields
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
};
