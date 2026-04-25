import { getRuntimeConfig } from './config/runtimeConfig.js'
import { checkExecutionRepositoryStorage } from './execution/repository.js'
import { ollamaBaseURL } from './ollama.js'

const runtimeConfig = getRuntimeConfig()

export const readinessTimeoutMs = runtimeConfig.readiness.timeoutMs

export const readinessStrict = runtimeConfig.readiness.strict

export type ReadinessCheckResult = {
  ok: boolean
  checks: {
    app: { ok: true }
    ollama: {
      ok: boolean
      baseUrl: string
      latencyMs?: number
      status?: number
      reason?: string
    }
    executionStorage: {
      ok: boolean
      storageKind: string
      storagePath?: string
      reason?: string
    }
  }
  ts: string
}

export async function checkReadiness(): Promise<ReadinessCheckResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), readinessTimeoutMs)

  const ollamaCheck: ReadinessCheckResult['checks']['ollama'] = {
    ok: false,
    baseUrl: ollamaBaseURL,
  }

  try {
    const response = await fetch(`${ollamaBaseURL}/tags`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    })

    try {
      ollamaCheck.latencyMs = Date.now() - started
      ollamaCheck.status = response.status

      if (!response.ok) {
        ollamaCheck.reason = `upstream_status_${response.status}`
      } else {
        ollamaCheck.ok = true
      }
    } finally {
      await response.body?.cancel()
    }
  } catch (error) {
    ollamaCheck.latencyMs = Date.now() - started
    ollamaCheck.reason = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timeout)
  }

  const executionStorageCheck = await checkExecutionRepositoryStorage({
    storageKind: runtimeConfig.execution.storageKind,
    storagePath: runtimeConfig.execution.storagePath,
  })

  return {
    ok: ollamaCheck.ok && executionStorageCheck.ok,
    checks: {
      app: { ok: true },
      ollama: ollamaCheck,
      executionStorage: executionStorageCheck,
    },
    ts: new Date().toISOString(),
  }
}
