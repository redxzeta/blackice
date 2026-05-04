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
const DEFAULT_MARKET_DATA_MAX_CANDIDATES = 25
const DEFAULT_MARKET_DATA_MIN_LIQUIDITY_USD = 0
const DEFAULT_MARKET_DATA_MIN_DEPTH_USD = 0
const DEFAULT_MARKET_DATA_MAX_SPREAD_BPS = 500
const DEFAULT_EXECUTION_DEFAULT_VENUE = 'paper'
const DEFAULT_EXECUTION_ACCOUNT_ID = 'paper-account'
const DEFAULT_EXECUTION_MAX_POSITION_USD = 1_000
const DEFAULT_EXECUTION_REQUIRE_PREFLIGHT = true
const DEFAULT_EXECUTION_PREFLIGHT_MAX_AGE_SECONDS = 300
const DEFAULT_EXECUTION_SIGNER_KIND = 'mock'
const DEFAULT_EXECUTION_STORAGE_KIND = 'memory'
const DEFAULT_EXECUTION_STORAGE_PATH = ''
const DEFAULT_EXECUTION_GEOFENCE_ALLOWED = true
const DEFAULT_EXECUTION_COMPLIANCE_ALLOWED = true
const PRODUCTION_RUNTIME_ENV = 'production'
const SAFE_PRODUCTION_AUTH_EXEMPT_PATHS = new Set(['/healthz', '/readyz', '/version'])

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
    marketData: z
      .object({
        discoveryBaseUrl: z.string().trim().optional(),
        orderbookBaseUrl: z.string().trim().optional(),
        maxCandidates: z.number().int().min(1).max(500).optional(),
        minLiquidityUsd: z.number().nonnegative().optional(),
        minDepthUsd: z.number().nonnegative().optional(),
        maxSpreadBps: z.number().nonnegative().optional(),
        excludedEventTypes: z.array(z.string().trim().min(1)).optional(),
      })
      .optional(),
    execution: z
      .object({
        accountId: z.string().trim().min(1).optional(),
        defaultVenue: z.string().trim().min(1).optional(),
        allowedVenues: z.array(z.string().trim().min(1)).optional(),
        requirePreflight: z.boolean().optional(),
        preflightMaxAgeSeconds: z.number().int().positive().optional(),
        maxPositionUsd: z.number().positive().optional(),
        signerKind: z.string().trim().min(1).optional(),
        storageKind: z.string().trim().min(1).optional(),
        storagePath: z.string().trim().optional(),
        geofenceAllowed: z.boolean().optional(),
        complianceAllowed: z.boolean().optional(),
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
    marketData: z.object({
      discoveryBaseUrl: z.string(),
      orderbookBaseUrl: z.string(),
      maxCandidates: z.number().int().min(1).max(500),
      minLiquidityUsd: z.number().nonnegative(),
      minDepthUsd: z.number().nonnegative(),
      maxSpreadBps: z.number().nonnegative(),
      excludedEventTypes: z.array(z.string().min(1)),
    }),
    execution: z.object({
      accountId: z.string().min(1),
      defaultVenue: z.string().min(1),
      allowedVenues: z.array(z.string().min(1)).min(1),
      requirePreflight: z.boolean(),
      preflightMaxAgeSeconds: z.number().int().positive(),
      maxPositionUsd: z.number().positive(),
      signerKind: z.string().min(1),
      storageKind: z.string().min(1),
      storagePath: z.string(),
      geofenceAllowed: z.boolean(),
      complianceAllowed: z.boolean(),
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

function formatIssuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${formatIssuePath(issue)}: ${issue.message}`).join('; ')
}

function normalizeExemptPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '/') {
    return trimmed
  }
  return trimmed.replace(/\/+$/, '') || '/'
}

function parseAuthExemptPaths(value: string | undefined): string[] {
  return String(value ?? '/healthz,/readyz,/version')
    .split(',')
    .map(normalizeExemptPath)
    .filter(Boolean)
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }
  return undefined
}

function isProductionRuntime(): boolean {
  return (
    String(process.env.BLACKICE_RUNTIME_ENV ?? '')
      .trim()
      .toLowerCase() === PRODUCTION_RUNTIME_ENV
  )
}

function validateProductionRuntimeConfig(input: {
  configFileRaw: string | undefined
  yamlConfig: z.infer<typeof YamlConfigSchema>
  runtimeConfig: RuntimeConfig
}): void {
  if (!isProductionRuntime()) {
    return
  }

  const issues: string[] = []
  const apiToken = String(process.env.API_TOKEN ?? '').trim()
  if (!apiToken) {
    issues.push('API_TOKEN: required when BLACKICE_RUNTIME_ENV=production')
  }

  if (!input.configFileRaw?.trim()) {
    issues.push('BLACKICE_CONFIG_FILE: explicit config file is required in production')
  }

  const exemptPaths = parseAuthExemptPaths(process.env.AUTH_EXEMPT_PATHS)
  const unsafeExemptPaths = exemptPaths.filter(
    (entry) => !SAFE_PRODUCTION_AUTH_EXEMPT_PATHS.has(entry)
  )
  if (unsafeExemptPaths.length > 0) {
    issues.push(
      `AUTH_EXEMPT_PATHS: production exemptions may only include ${[
        ...SAFE_PRODUCTION_AUTH_EXEMPT_PATHS,
      ].join(', ')}`
    )
  }

  const configuredStorageKind = input.yamlConfig.execution?.storageKind?.trim()
  if (!configuredStorageKind) {
    issues.push('execution.storageKind: explicit durable storage kind is required in production')
  } else if (configuredStorageKind === 'memory') {
    issues.push('execution.storageKind: memory storage is not allowed in production')
  }

  if (!input.runtimeConfig.execution.storagePath.trim()) {
    issues.push('execution.storagePath: required for production durable storage')
  }

  if (issues.length > 0) {
    throw new Error(`Invalid production configuration: ${issues.join('; ')}`)
  }
}

function loadYamlConfig(filePath: string): z.infer<typeof YamlConfigSchema> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`)
  }

  const raw = readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    throw new Error(
      `Invalid config file ${filePath}: YAML parse error: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const result = YamlConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid config file ${filePath}: ${formatValidationIssues(result.error)}`)
  }
  return result.data
}

let cachedRuntimeConfig: RuntimeConfig | null = null

function loadRuntimeConfigFromEnv(): RuntimeConfig {
  const configuredConfigFile = process.env.BLACKICE_CONFIG_FILE
  const configFileRaw = String(configuredConfigFile ?? DEFAULT_CONFIG_FILE).trim()
  const configFile = path.resolve(configFileRaw)
  const yamlConfig = loadYamlConfig(configFile)

  const serverYaml = yamlConfig.server ?? {}
  const readinessYaml = yamlConfig.readiness ?? {}
  const opsYaml = yamlConfig.ops ?? {}
  const debateYaml = yamlConfig.debate ?? {}
  const ollamaYaml = yamlConfig.ollama ?? {}
  const lokiYaml = yamlConfig.loki ?? {}
  const marketDataYaml = yamlConfig.marketData ?? {}
  const executionYaml = yamlConfig.execution ?? {}
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

  const marketData = {
    discoveryBaseUrl: String(marketDataYaml.discoveryBaseUrl ?? '').trim(),
    orderbookBaseUrl: String(marketDataYaml.orderbookBaseUrl ?? '').trim(),
    maxCandidates: marketDataYaml.maxCandidates ?? DEFAULT_MARKET_DATA_MAX_CANDIDATES,
    minLiquidityUsd: marketDataYaml.minLiquidityUsd ?? DEFAULT_MARKET_DATA_MIN_LIQUIDITY_USD,
    minDepthUsd: marketDataYaml.minDepthUsd ?? DEFAULT_MARKET_DATA_MIN_DEPTH_USD,
    maxSpreadBps: marketDataYaml.maxSpreadBps ?? DEFAULT_MARKET_DATA_MAX_SPREAD_BPS,
    excludedEventTypes: marketDataYaml.excludedEventTypes ?? [],
  }

  const defaultVenue = String(executionYaml.defaultVenue ?? DEFAULT_EXECUTION_DEFAULT_VENUE).trim()

  const execution = {
    accountId: String(
      executionYaml.accountId ??
        process.env.BLACKICE_EXECUTION_ACCOUNT_ID ??
        DEFAULT_EXECUTION_ACCOUNT_ID
    ).trim(),
    defaultVenue,
    allowedVenues: executionYaml.allowedVenues?.map((venue) => venue.trim()).filter(Boolean) ?? [
      defaultVenue,
    ],
    requirePreflight: executionYaml.requirePreflight ?? DEFAULT_EXECUTION_REQUIRE_PREFLIGHT,
    preflightMaxAgeSeconds:
      executionYaml.preflightMaxAgeSeconds ?? DEFAULT_EXECUTION_PREFLIGHT_MAX_AGE_SECONDS,
    maxPositionUsd: executionYaml.maxPositionUsd ?? DEFAULT_EXECUTION_MAX_POSITION_USD,
    signerKind: String(executionYaml.signerKind ?? DEFAULT_EXECUTION_SIGNER_KIND).trim(),
    storageKind: String(executionYaml.storageKind ?? DEFAULT_EXECUTION_STORAGE_KIND).trim(),
    storagePath: String(executionYaml.storagePath ?? DEFAULT_EXECUTION_STORAGE_PATH).trim(),
    geofenceAllowed:
      executionYaml.geofenceAllowed ??
      parseBooleanEnv(process.env.BLACKICE_EXECUTION_GEOFENCE_ALLOWED) ??
      DEFAULT_EXECUTION_GEOFENCE_ALLOWED,
    complianceAllowed:
      executionYaml.complianceAllowed ??
      parseBooleanEnv(process.env.BLACKICE_EXECUTION_COMPLIANCE_ALLOWED) ??
      DEFAULT_EXECUTION_COMPLIANCE_ALLOWED,
  }

  const result = RuntimeConfigSchema.safeParse({
    configFile,
    server,
    readiness,
    ops,
    debate,
    ollama,
    loki,
    marketData,
    execution,
    limits,
  })
  if (!result.success) {
    throw new Error(`Invalid runtime config ${configFile}: ${formatValidationIssues(result.error)}`)
  }

  validateProductionRuntimeConfig({
    configFileRaw: configuredConfigFile,
    yamlConfig,
    runtimeConfig: result.data,
  })

  return result.data
}

export function validateRuntimeConfig(): RuntimeConfig {
  return getRuntimeConfig()
}

export function getRuntimeConfig(): RuntimeConfig {
  if (cachedRuntimeConfig) {
    return cachedRuntimeConfig
  }

  cachedRuntimeConfig = loadRuntimeConfigFromEnv()
  return cachedRuntimeConfig
}
