import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DEBATE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(1),

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
