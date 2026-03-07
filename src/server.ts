import { env } from './config/env.js'
import { ollamaBaseURL } from './ollama.js'
import { log } from './log.js'
import { createApp } from './app.js'

const port = env.PORT
const maxActiveDebates = env.DEBATE_MAX_CONCURRENT

const app = createApp(maxActiveDebates)

app.listen(port, () => {
  log.info('server_started', { port, ollama_base_url: ollamaBaseURL })
})
