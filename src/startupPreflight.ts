import { env } from './config/env.js'
import { checkModelAvailability, getConfiguredOllamaModel, ollamaBaseURL } from './ollama.js'
import { log } from './log.js'

export async function runStartupModelPreflight(): Promise<void> {
  if (!env.MODEL_PREFLIGHT_ON_START) {
    return
  }

  const result = await checkModelAvailability()
  if (!result.available) {
    throw new Error(`startup_preflight_failed_model_not_found:${result.model}`)
  }

  log.info('startup_model_preflight_ok', {
    model: getConfiguredOllamaModel(),
    latency_ms: result.latencyMs,
    ollama_base_url: ollamaBaseURL,
  })
}
