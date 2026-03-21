import { env } from './config/env.js'
import { ollamaBaseURL } from './ollama.js'
import { log } from './log.js'
import { createApp } from './app.js'
import { runStartupModelPreflight } from './startupPreflight.js'

const port = env.PORT
const maxActiveDebates = env.DEBATE_MAX_CONCURRENT

const app = createApp(maxActiveDebates)

async function start(): Promise<void> {
  await runStartupModelPreflight()

  app.listen(port, () => {
    log.info('server_started', { port, ollama_base_url: ollamaBaseURL })
  })
}

start().catch((error: unknown) => {
  log.error('server_start_failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
