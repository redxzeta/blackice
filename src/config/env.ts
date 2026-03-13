import { z } from 'zod'

const booleanFlagSchema = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  if (!normalized) {
    return undefined
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return value
}, z.boolean())

function boundedIntSchema(min: number, max: number, fallback: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return undefined
    }

    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed)) {
      return value
    }

    return Math.max(min, Math.min(max, parsed))
  }, z.number().int().min(min).max(max).default(fallback))
}

const logLevelSchema = z.preprocess((value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined
  }

  return String(value)
    .trim()
    .toLowerCase()
}, z.enum(['debug', 'info']).default('info'))

const envSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DEBATE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(1),
  MODEL_PREFLIGHT_ON_START: booleanFlagSchema.default(false),
  MODEL_PREFLIGHT_TIMEOUT_MS: boundedIntSchema(200, 10_000, 2000),

  LOG_LEVEL: logLevelSchema,
  LOG_BUFFER_MAX_ENTRIES: z.coerce.number().int().min(100).max(10_000).default(2000),
})

export type Env = z.infer<typeof envSchema>

const envParseResult = envSchema.safeParse(process.env)

if (!envParseResult.success) {
  process.stderr.write(`Invalid environment variables:\n${z.prettifyError(envParseResult.error)}\n`)
  process.exit(1)
}

export const env: Env = envParseResult.data
