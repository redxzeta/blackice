import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

type YamlOllamaConfig = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
};

type YamlLokiConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  maxWindowMinutes?: number;
  defaultWindowMinutes?: number;
  maxLinesCap?: number;
  maxResponseBytes?: number;
  requireScopeLabels?: boolean;
  rulesFile?: string;
};

type YamlLimitsConfig = {
  logCollectionTimeoutMs?: number;
  maxCommandBytes?: number;
  maxQueryHours?: number;
  maxLinesCap?: number;
};

type YamlConfig = {
  ollama?: YamlOllamaConfig;
  loki?: YamlLokiConfig;
  limits?: YamlLimitsConfig;
};

export type RuntimeConfig = {
  configFile: string;
  ollama: Required<YamlOllamaConfig>;
  loki: Required<YamlLokiConfig>;
  limits: Required<YamlLimitsConfig>;
};

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid config: "${field}" must be a string`);
  }
  return value.trim();
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid config: "${field}" must be a finite number`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid config: "${field}" must be a boolean`);
  }
  return value;
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.trim().toLowerCase() !== 'false';
}

function loadYamlConfig(filePath: string): YamlConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Config file must contain a top-level object');
  }

  const body = parsed as Record<string, unknown>;
  const config: YamlConfig = {};

  if (body.ollama !== undefined) {
    if (typeof body.ollama !== 'object' || body.ollama === null || Array.isArray(body.ollama)) {
      throw new Error('Invalid config: "ollama" must be an object');
    }
    const section = body.ollama as Record<string, unknown>;
    config.ollama = {
      ...(section.baseUrl !== undefined ? { baseUrl: asString(section.baseUrl, 'ollama.baseUrl') } : {}),
      ...(section.model !== undefined ? { model: asString(section.model, 'ollama.model') } : {}),
      ...(section.timeoutMs !== undefined ? { timeoutMs: asNumber(section.timeoutMs, 'ollama.timeoutMs') } : {}),
      ...(section.retryAttempts !== undefined
        ? { retryAttempts: asNumber(section.retryAttempts, 'ollama.retryAttempts') }
        : {}),
      ...(section.retryBackoffMs !== undefined
        ? { retryBackoffMs: asNumber(section.retryBackoffMs, 'ollama.retryBackoffMs') }
        : {})
    };
  }

  if (body.loki !== undefined) {
    if (typeof body.loki !== 'object' || body.loki === null || Array.isArray(body.loki)) {
      throw new Error('Invalid config: "loki" must be an object');
    }
    const section = body.loki as Record<string, unknown>;
    config.loki = {
      ...(section.baseUrl !== undefined ? { baseUrl: asString(section.baseUrl, 'loki.baseUrl') } : {}),
      ...(section.timeoutMs !== undefined ? { timeoutMs: asNumber(section.timeoutMs, 'loki.timeoutMs') } : {}),
      ...(section.maxWindowMinutes !== undefined
        ? { maxWindowMinutes: asNumber(section.maxWindowMinutes, 'loki.maxWindowMinutes') }
        : {}),
      ...(section.defaultWindowMinutes !== undefined
        ? { defaultWindowMinutes: asNumber(section.defaultWindowMinutes, 'loki.defaultWindowMinutes') }
        : {}),
      ...(section.maxLinesCap !== undefined
        ? { maxLinesCap: asNumber(section.maxLinesCap, 'loki.maxLinesCap') }
        : {}),
      ...(section.maxResponseBytes !== undefined
        ? { maxResponseBytes: asNumber(section.maxResponseBytes, 'loki.maxResponseBytes') }
        : {}),
      ...(section.requireScopeLabels !== undefined
        ? { requireScopeLabels: asBoolean(section.requireScopeLabels, 'loki.requireScopeLabels') }
        : {}),
      ...(section.rulesFile !== undefined ? { rulesFile: asString(section.rulesFile, 'loki.rulesFile') } : {})
    };
  }

  if (body.limits !== undefined) {
    if (typeof body.limits !== 'object' || body.limits === null || Array.isArray(body.limits)) {
      throw new Error('Invalid config: "limits" must be an object');
    }
    const section = body.limits as Record<string, unknown>;
    config.limits = {
      ...(section.logCollectionTimeoutMs !== undefined
        ? { logCollectionTimeoutMs: asNumber(section.logCollectionTimeoutMs, 'limits.logCollectionTimeoutMs') }
        : {}),
      ...(section.maxCommandBytes !== undefined
        ? { maxCommandBytes: asNumber(section.maxCommandBytes, 'limits.maxCommandBytes') }
        : {}),
      ...(section.maxQueryHours !== undefined
        ? { maxQueryHours: asNumber(section.maxQueryHours, 'limits.maxQueryHours') }
        : {}),
      ...(section.maxLinesCap !== undefined ? { maxLinesCap: asNumber(section.maxLinesCap, 'limits.maxLinesCap') } : {})
    };
  }

  return config;
}

let cachedRuntimeConfig: RuntimeConfig | null = null;

export function getRuntimeConfig(): RuntimeConfig {
  if (cachedRuntimeConfig) {
    return cachedRuntimeConfig;
  }

  const configFileRaw = String(process.env.BLACKICE_CONFIG_FILE ?? './config/blackice.local.yaml').trim();
  const configFile = path.resolve(configFileRaw);
  const yamlConfig = loadYamlConfig(configFile);

  const ollamaYaml = yamlConfig.ollama ?? {};
  const lokiYaml = yamlConfig.loki ?? {};
  const limitsYaml = yamlConfig.limits ?? {};

  const limits = {
    logCollectionTimeoutMs: parseEnvNumber(process.env.LOG_COLLECTION_TIMEOUT_MS, limitsYaml.logCollectionTimeoutMs ?? 15_000),
    maxCommandBytes: parseEnvNumber(process.env.MAX_COMMAND_BYTES, limitsYaml.maxCommandBytes ?? 2_000_000),
    maxQueryHours: parseEnvNumber(process.env.MAX_QUERY_HOURS ?? process.env.MAX_HOURS, limitsYaml.maxQueryHours ?? 168),
    maxLinesCap: parseEnvNumber(process.env.MAX_LINES ?? process.env.MAX_LINES_CAP, limitsYaml.maxLinesCap ?? 2_000)
  };

  const ollama = {
    baseUrl: String(process.env.OLLAMA_BASE_URL ?? ollamaYaml.baseUrl ?? 'http://192.168.1.230:11434').trim(),
    model: String(process.env.OLLAMA_MODEL ?? ollamaYaml.model ?? 'qwen2.5:14b').trim(),
    timeoutMs: parseEnvNumber(process.env.OLLAMA_TIMEOUT_MS, ollamaYaml.timeoutMs ?? 45_000),
    retryAttempts: parseEnvNumber(process.env.OLLAMA_RETRY_ATTEMPTS, ollamaYaml.retryAttempts ?? 2),
    retryBackoffMs: parseEnvNumber(process.env.OLLAMA_RETRY_BACKOFF_MS, ollamaYaml.retryBackoffMs ?? 1_000)
  };

  const loki = {
    baseUrl: String(process.env.LOKI_BASE_URL ?? lokiYaml.baseUrl ?? '').trim().replace(/\/$/, ''),
    timeoutMs: parseEnvNumber(process.env.LOKI_TIMEOUT_MS, lokiYaml.timeoutMs ?? limits.logCollectionTimeoutMs),
    maxWindowMinutes: parseEnvNumber(process.env.LOKI_MAX_WINDOW_MINUTES, lokiYaml.maxWindowMinutes ?? 60),
    defaultWindowMinutes: parseEnvNumber(process.env.LOKI_DEFAULT_WINDOW_MINUTES, lokiYaml.defaultWindowMinutes ?? 15),
    maxLinesCap: parseEnvNumber(process.env.LOKI_MAX_LINES_CAP, lokiYaml.maxLinesCap ?? limits.maxLinesCap),
    maxResponseBytes: parseEnvNumber(process.env.LOKI_MAX_RESPONSE_BYTES, lokiYaml.maxResponseBytes ?? limits.maxCommandBytes),
    requireScopeLabels: parseEnvBoolean(process.env.LOKI_REQUIRE_SCOPE_LABELS, lokiYaml.requireScopeLabels ?? true),
    rulesFile: String(process.env.LOKI_RULES_FILE ?? lokiYaml.rulesFile ?? '').trim()
  };

  cachedRuntimeConfig = {
    configFile,
    ollama,
    loki,
    limits
  };
  return cachedRuntimeConfig;
}
