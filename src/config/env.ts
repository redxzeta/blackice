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

const envSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DEBATE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(1),
  MODEL_PREFLIGHT_ON_START: booleanFlagSchema.default(false),
  MODEL_PREFLIGHT_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2000),

  LOG_LEVEL: z.enum(['debug', 'info']).default('info'),
  LOG_BUFFER_MAX_ENTRIES: z.coerce.number().int().min(100).max(10_000).default(2000),
})

export type Env = z.infer<typeof envSchema>

const envParseResult = envSchema.safeParse(process.env)

if (!envParseResult.success) {
  process.stderr.write(`Invalid environment variables:\n${z.prettifyError(envParseResult.error)}\n`)
  process.exit(1)
}

export const env: Env = envParseResult.data
