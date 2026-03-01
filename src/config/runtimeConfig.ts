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
        maxLinesCap: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        maxLogChars: z.number().int().positive().optional()
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
      maxLinesCap: z.number().int().positive(),
      maxConcurrency: z.number().int().positive(),
      maxLogChars: z.number().int().positive()
    })
  })
  .strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

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
  const configDir = path.dirname(configFile);

  const limits = {
    logCollectionTimeoutMs: limitsYaml.logCollectionTimeoutMs ?? 15_000,
    maxCommandBytes: limitsYaml.maxCommandBytes ?? 2_000_000,
    maxQueryHours: limitsYaml.maxQueryHours ?? 168,
    maxLinesCap: limitsYaml.maxLinesCap ?? 2_000,
    maxConcurrency: limitsYaml.maxConcurrency ?? 5,
    maxLogChars: limitsYaml.maxLogChars ?? 40_000
  };

  const ollama = {
    baseUrl: String(ollamaYaml.baseUrl ?? 'http://192.168.1.230:11434').trim(),
    model: String(ollamaYaml.model ?? 'qwen2.5:14b').trim(),
    timeoutMs: ollamaYaml.timeoutMs ?? 45_000,
    retryAttempts: ollamaYaml.retryAttempts ?? 2,
    retryBackoffMs: ollamaYaml.retryBackoffMs ?? 1_000
  };

  const rulesFileRaw = String(lokiYaml.rulesFile ?? '').trim();
  const rulesFile = !rulesFileRaw ? rulesFileRaw : path.resolve(configDir, rulesFileRaw);

  const loki = {
    baseUrl: String(lokiYaml.baseUrl ?? '').trim().replace(/\/$/, ''),
    timeoutMs: lokiYaml.timeoutMs ?? limits.logCollectionTimeoutMs,
    maxWindowMinutes: lokiYaml.maxWindowMinutes ?? 60,
    defaultWindowMinutes: lokiYaml.defaultWindowMinutes ?? 15,
    maxLinesCap: lokiYaml.maxLinesCap ?? limits.maxLinesCap,
    maxResponseBytes: lokiYaml.maxResponseBytes ?? limits.maxCommandBytes,
    requireScopeLabels: lokiYaml.requireScopeLabels ?? true,
    rulesFile
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
