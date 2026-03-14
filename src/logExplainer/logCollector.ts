import { spawn } from 'node:child_process'
import { getRuntimeConfig } from '../config/runtimeConfig.js'
import { buildLogExplainerError } from './error.js'
import type { AnalyzeLogsRequest } from './schema.js'
import { getLokiRuntimeLimits } from './loki.js'

const runtimeConfig = getRuntimeConfig()
const LOG_COLLECTION_TIMEOUT_MS = Number(runtimeConfig.limits.logCollectionTimeoutMs)
const MAX_COMMAND_BYTES = Number(runtimeConfig.limits.maxCommandBytes)
const MAX_HOURS = Number(runtimeConfig.limits.maxQueryHours)
const MAX_LINES_CAP = Number(runtimeConfig.limits.maxLinesCap)

function sanitizeTarget(target: string): string {
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(target)) {
    throw buildLogExplainerError(400, 'target contains unsupported characters')
  }

  return target
}

function clampHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw buildLogExplainerError(400, 'hours must be a positive number')
  }

  return Math.min(Math.floor(hours), MAX_HOURS)
}

function clampMaxLines(maxLines: number): number {
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw buildLogExplainerError(400, 'maxLines must be a positive integer')
  }

  return Math.min(maxLines, MAX_LINES_CAP)
}

function runAllowedCommand(command: 'journalctl' | 'docker', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      child.kill('SIGKILL')
      reject(buildLogExplainerError(504, `log collection timed out for ${command}`))
    }, LOG_COLLECTION_TIMEOUT_MS)

    child.stdout.on('data', (buf: Buffer) => {
      if (settled) {
        return
      }

      stdout += buf.toString('utf8')
      if (Buffer.byteLength(stdout, 'utf8') > MAX_COMMAND_BYTES) {
        settled = true
        child.kill('SIGKILL')
        reject(buildLogExplainerError(413, 'command output exceeds MAX_COMMAND_BYTES limit'))
      }
    })

    child.stderr.on('data', (buf: Buffer) => {
      if (settled) {
        return
      }

      stderr += buf.toString('utf8')
    })

    child.on('error', (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      reject(buildLogExplainerError(500, `failed to execute ${command}: ${error.message}`))
    })

    child.on('close', (code: number | null) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)

      if (code !== 0) {
        reject(
          buildLogExplainerError(
            502,
            `${command} failed: ${stderr.trim() || `exit code ${String(code)}`}`
          )
        )
        return
      }

      resolve(stdout)
    })
  })
}

async function collectJournalctlLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeTarget = sanitizeTarget(input.target)
  const safeHours = clampHours(input.hours)
  const safeMaxLines = clampMaxLines(input.maxLines)

  const args = [
    '--no-pager',
    '--output=short-iso',
    '--since',
    `${safeHours} hours ago`,
    '-n',
    String(safeMaxLines),
  ]

  if (safeTarget !== 'all') {
    args.push('-u', safeTarget)
  }

  return runAllowedCommand('journalctl', args)
}

async function collectDockerLogs(input: AnalyzeLogsRequest): Promise<string> {
  const safeTarget = sanitizeTarget(input.target)
  const safeHours = clampHours(input.hours)
  const safeMaxLines = clampMaxLines(input.maxLines)

  const sinceDate = new Date(Date.now() - safeHours * 60 * 60 * 1_000).toISOString()
  return runAllowedCommand('docker', [
    'logs',
    '--tail',
    String(safeMaxLines),
    '--since',
    sinceDate,
    safeTarget,
  ])
}

export function getLogCollectorLimits(): {
  maxHours: number
  maxLinesCap: number
  maxCommandBytes: number
  collectionTimeoutMs: number
  loki: ReturnType<typeof getLokiRuntimeLimits>
} {
  return {
    maxHours: MAX_HOURS,
    maxLinesCap: MAX_LINES_CAP,
    maxCommandBytes: MAX_COMMAND_BYTES,
    collectionTimeoutMs: LOG_COLLECTION_TIMEOUT_MS,
    loki: getLokiRuntimeLimits(),
  }
}

export async function collectLogs(input: AnalyzeLogsRequest): Promise<string> {
  if (input.source === 'journalctl' || input.source === 'journald') {
    return collectJournalctlLogs(input)
  }

  if (input.source === 'docker') {
    return collectDockerLogs(input)
  }

  throw buildLogExplainerError(400, `Unsupported source: ${input.source}`)
}

export {
  buildEffectiveLokiQuery,
  checkLokiHealth,
  collectLokiBatchLogs,
  collectLokiLogs,
  ensureLokiRulesConfigured,
  getLokiDiscovery,
  getLokiSyntheticTargets,
  isLokiEnabled,
  queryLokiRange,
  resolveLokiTimeRange,
  validateAllowedLokiSelector,
} from './loki.js'
export type { LokiDiscovery } from './loki.js'
