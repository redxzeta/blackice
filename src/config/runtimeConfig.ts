import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const YamlConfigSchema = z
  .object({
    version: z.number().int().positive().optional(),
    ollama: z
      .object({
        baseUrl: z.string().trim().optional(),
        model: z.string().trim().optional(),
        timeoutMs: z.number().int().positive().optional(),
        retryAttempts: z.number().int().nonnegative().optional(),
        retryBackoffMs: z.number().int().positive().optional()
      })
      .optional(),
    loki: z
      .object({
        baseUrl: z.string().trim().optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxWindowMinutes: z.number().int().positive().optional(),
        defaultWindowMinutes: z.number().int().positive().optional(),
        maxLinesCap: z.number().int().positive().optional(),
        maxResponseBytes: z.number().int().positive().optional(),
        requireScopeLabels: z.boolean().optional(),
        rulesFile: z.string().trim().optional()
      })
      .optional(),
    limits: z
      .object({
        logCollectionTimeoutMs: z.number().int().positive().optional(),
        maxCommandBytes: z.number().int().positive().optional(),
        maxQueryHours: z.number().int().positive().optional(),
        maxLinesCap: z.number().int().positive().optional()
      })
      .optional()
  })
  .strict();

const RuntimeConfigSchema = z
  .object({
    configFile: z.string().min(1),
    ollama: z.object({
      baseUrl: z.string().min(1),
      model: z.string().min(1),
      timeoutMs: z.number().int().positive(),
      retryAttempts: z.number().int().nonnegative(),
      retryBackoffMs: z.number().int().positive()
    }),
    loki: z.object({
      baseUrl: z.string(),
      timeoutMs: z.number().int().positive(),
      maxWindowMinutes: z.number().int().positive(),
      defaultWindowMinutes: z.number().int().positive(),
      maxLinesCap: z.number().int().positive(),
      maxResponseBytes: z.number().int().positive(),
      requireScopeLabels: z.boolean(),
      rulesFile: z.string()
    }),
    limits: z.object({
      logCollectionTimeoutMs: z.number().int().positive(),
      maxCommandBytes: z.number().int().positive(),
      maxQueryHours: z.number().int().positive(),
      maxLinesCap: z.number().int().positive()
    })
  })
  .strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

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

function loadYamlConfig(filePath: string): z.infer<typeof YamlConfigSchema> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw);
  const result = YamlConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config file: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
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
  cachedRuntimeConfig = RuntimeConfigSchema.parse(cachedRuntimeConfig);
  return cachedRuntimeConfig;
}
