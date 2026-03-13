import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const DEFAULT_CONFIG_FILE = './config/blackice.local.yaml'
const DEFAULT_SERVER_PORT = 3000
const DEFAULT_READINESS_TIMEOUT_MS = 1_500
const MIN_READINESS_TIMEOUT_MS = 100
const MAX_READINESS_TIMEOUT_MS = 10_000
const DEFAULT_READINESS_STRICT = true
const DEFAULT_OPS_ENABLED = false
const DEFAULT_LOG_BUFFER_MAX_ENTRIES = 2_000
const DEFAULT_LOG_COLLECTION_TIMEOUT_MS = 15_000
const DEFAULT_MAX_COMMAND_BYTES = 2_000_000
const DEFAULT_MAX_QUERY_HOURS = 168
const DEFAULT_MAX_LINES_CAP = 2_000
const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MAX_LOG_CHARS = 40_000
const DEFAULT_DEBATE_MAX_CONCURRENT = 1
const DEFAULT_DEBATE_MODEL_ALLOWLIST = ['llama3.1:8b', 'qwen2.5:14b', 'qwen2.5-coder:14b']
const DEFAULT_OLLAMA_BASE_URL = 'http://192.168.1.230:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b'
const DEFAULT_OLLAMA_TIMEOUT_MS = 45_000
const DEFAULT_OLLAMA_RETRY_ATTEMPTS = 2
const DEFAULT_OLLAMA_RETRY_BACKOFF_MS = 1_000
const DEFAULT_LOKI_MAX_WINDOW_MINUTES = 60
const DEFAULT_LOKI_DEFAULT_WINDOW_MINUTES = 15
const DEFAULT_LOKI_REQUIRE_SCOPE_LABELS = true

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const YamlConfigSchema = z
  .object({
    version: z.number().int().positive().optional(),
    server: z
      .object({
        port: z.number().int().positive().optional(),
      })
      .optional(),
    readiness: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        strict: z.boolean().optional(),
      })
      .optional(),
    ops: z
      .object({
        enabled: z.boolean().optional(),
        logBufferMaxEntries: z.number().int().min(100).max(10_000).optional(),
      })
      .optional(),
    debate: z
      .object({
        maxConcurrent: z.number().int().min(1).max(100).optional(),
        modelAllowlist: z.array(z.string().trim().min(1)).optional(),
      })
      .optional(),
    ollama: z
      .object({
        baseUrl: z.string().trim().optional(),
        model: z.string().trim().optional(),
        timeoutMs: z.number().int().positive().optional(),
        retryAttempts: z.number().int().nonnegative().optional(),
        retryBackoffMs: z.number().int().positive().optional(),
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
        rulesFile: z.string().trim().optional(),
      })
      .optional(),
    limits: z
      .object({
        logCollectionTimeoutMs: z.number().int().positive().optional(),
        maxCommandBytes: z.number().int().positive().optional(),
        maxQueryHours: z.number().int().positive().optional(),
        maxLinesCap: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        maxLogChars: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict()

const RuntimeConfigSchema = z
  .object({
    configFile: z.string().min(1),
    server: z.object({
      port: z.number().int().positive(),
    }),
    readiness: z.object({
      timeoutMs: z.number().int().min(MIN_READINESS_TIMEOUT_MS).max(MAX_READINESS_TIMEOUT_MS),
      strict: z.boolean(),
    }),
    ops: z.object({
      enabled: z.boolean(),
      logBufferMaxEntries: z.number().int().min(100).max(10_000),
    }),
    debate: z.object({
      maxConcurrent: z.number().int().min(1).max(100),
      modelAllowlist: z.array(z.string().min(1)).min(1),
    }),
    ollama: z.object({
      baseUrl: z.string().min(1),
      model: z.string().min(1),
      timeoutMs: z.number().int().positive(),
      retryAttempts: z.number().int().nonnegative(),
      retryBackoffMs: z.number().int().positive(),
    }),
    loki: z.object({
      baseUrl: z.string(),
      timeoutMs: z.number().int().positive(),
      maxWindowMinutes: z.number().int().positive(),
      defaultWindowMinutes: z.number().int().positive(),
      maxLinesCap: z.number().int().positive(),
      maxResponseBytes: z.number().int().positive(),
      requireScopeLabels: z.boolean(),
      rulesFile: z.string(),
    }),
    limits: z.object({
      logCollectionTimeoutMs: z.number().int().positive(),
      maxCommandBytes: z.number().int().positive(),
      maxQueryHours: z.number().int().positive(),
      maxLinesCap: z.number().int().positive(),
      maxConcurrency: z.number().int().positive(),
      maxLogChars: z.number().int().positive(),
    }),
  })
  .strict()

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

function loadYamlConfig(filePath: string): z.infer<typeof YamlConfigSchema> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`)
  }

  const raw = readFileSync(filePath, 'utf8')
  const parsed = parseYaml(raw)
  const result = YamlConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid config file: ${result.error.issues.map((i) => i.message).join('; ')}`)
  }
  return result.data
}

let cachedRuntimeConfig: RuntimeConfig | null = null

export function getRuntimeConfig(): RuntimeConfig {
  if (cachedRuntimeConfig) {
    return cachedRuntimeConfig
  }

  const configFileRaw = String(process.env.BLACKICE_CONFIG_FILE ?? DEFAULT_CONFIG_FILE).trim()
  const configFile = path.resolve(configFileRaw)
  const yamlConfig = loadYamlConfig(configFile)

  const serverYaml = yamlConfig.server ?? {}
  const readinessYaml = yamlConfig.readiness ?? {}
  const opsYaml = yamlConfig.ops ?? {}
  const debateYaml = yamlConfig.debate ?? {}
  const ollamaYaml = yamlConfig.ollama ?? {}
  const lokiYaml = yamlConfig.loki ?? {}
  const limitsYaml = yamlConfig.limits ?? {}
  const configDir = path.dirname(configFile)

  const server = {
    port: serverYaml.port ?? DEFAULT_SERVER_PORT,
  }

  const readiness = {
    timeoutMs: clampInt(
      readinessYaml.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      MIN_READINESS_TIMEOUT_MS,
      MAX_READINESS_TIMEOUT_MS
    ),
    strict: readinessYaml.strict ?? DEFAULT_READINESS_STRICT,
  }

  const ops = {
    enabled: opsYaml.enabled ?? DEFAULT_OPS_ENABLED,
    logBufferMaxEntries: opsYaml.logBufferMaxEntries ?? DEFAULT_LOG_BUFFER_MAX_ENTRIES,
  }

  const debate = {
    maxConcurrent: debateYaml.maxConcurrent ?? DEFAULT_DEBATE_MAX_CONCURRENT,
    modelAllowlist:
      debateYaml.modelAllowlist?.map((model) => model.trim()).filter(Boolean) ??
      DEFAULT_DEBATE_MODEL_ALLOWLIST,
  }

  const limits = {
    logCollectionTimeoutMs: limitsYaml.logCollectionTimeoutMs ?? DEFAULT_LOG_COLLECTION_TIMEOUT_MS,
    maxCommandBytes: limitsYaml.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES,
    maxQueryHours: limitsYaml.maxQueryHours ?? DEFAULT_MAX_QUERY_HOURS,
    maxLinesCap: limitsYaml.maxLinesCap ?? DEFAULT_MAX_LINES_CAP,
    maxConcurrency: limitsYaml.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    maxLogChars: limitsYaml.maxLogChars ?? DEFAULT_MAX_LOG_CHARS,
  }

  const ollama = {
    baseUrl: String(ollamaYaml.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).trim(),
    model: String(ollamaYaml.model ?? DEFAULT_OLLAMA_MODEL).trim(),
    timeoutMs: ollamaYaml.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    retryAttempts: ollamaYaml.retryAttempts ?? DEFAULT_OLLAMA_RETRY_ATTEMPTS,
    retryBackoffMs: ollamaYaml.retryBackoffMs ?? DEFAULT_OLLAMA_RETRY_BACKOFF_MS,
  }

  const rulesFileRaw = String(lokiYaml.rulesFile ?? '').trim()
  const rulesFile = !rulesFileRaw ? rulesFileRaw : path.resolve(configDir, rulesFileRaw)

  const loki = {
    baseUrl: String(lokiYaml.baseUrl ?? '')
      .trim()
      .replace(/\/$/, ''),
    timeoutMs: lokiYaml.timeoutMs ?? limits.logCollectionTimeoutMs,
    maxWindowMinutes: lokiYaml.maxWindowMinutes ?? DEFAULT_LOKI_MAX_WINDOW_MINUTES,
    defaultWindowMinutes: lokiYaml.defaultWindowMinutes ?? DEFAULT_LOKI_DEFAULT_WINDOW_MINUTES,
    maxLinesCap: lokiYaml.maxLinesCap ?? limits.maxLinesCap,
    maxResponseBytes: lokiYaml.maxResponseBytes ?? limits.maxCommandBytes,
    requireScopeLabels: lokiYaml.requireScopeLabels ?? DEFAULT_LOKI_REQUIRE_SCOPE_LABELS,
    rulesFile,
  }

  cachedRuntimeConfig = RuntimeConfigSchema.parse({
    configFile,
    server,
    readiness,
    ops,
    debate,
    ollama,
    loki,
    limits,
  })
  return cachedRuntimeConfig
}
