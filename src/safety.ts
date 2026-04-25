import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type BoundedCommandOptions = {
  timeoutMs: number
  maxBytes: number
  onError?: (message: string, status?: number) => Error
  signal?: AbortSignal
}

function buildDefaultError(message: string): Error {
  return new Error(message)
}

export function createBoundedCommandRunner(options: BoundedCommandOptions) {
  return (command: string, args: string[]): Promise<string> =>
    runBoundedCommand(command, args, options)
}

export function runBoundedCommand(
  command: string,
  args: string[],
  options: BoundedCommandOptions
): Promise<string> {
  const toError = options.onError ?? buildDefaultError

  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortCommand)
      callback()
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(toError(`command timed out for ${command}`, 504)))
    }, options.timeoutMs)

    const abortCommand = (): void => {
      child.kill('SIGKILL')
      finish(() => reject(toError(`command cancelled for ${command}`, 499)))
    }

    if (options.signal?.aborted) {
      abortCommand()
      return
    }
    options.signal?.addEventListener('abort', abortCommand, { once: true })

    child.stdout.on('data', (buf: Buffer) => {
      if (settled) {
        return
      }

      stdout += buf.toString('utf8')
      if (Buffer.byteLength(stdout, 'utf8') > options.maxBytes) {
        child.kill('SIGKILL')
        finish(() => reject(toError('command output exceeded byte limit', 413)))
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
      finish(() => reject(toError(`failed to execute ${command}: ${error.message}`, 500)))
    })

    child.on('close', (code: number | null) => {
      if (settled) {
        return
      }

      if (code !== 0) {
        finish(() =>
          reject(toError(`${command} failed: ${stderr.trim() || `exit code ${String(code)}`}`, 502))
        )
        return
      }

      finish(() => resolve(stdout.trim()))
    })
  })
}

function isRealPathContained(realRequested: string, realAllowed: string): boolean {
  const relative = path.relative(realAllowed, realRequested)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function resolveAllowlistedPath(
  requestedPath: string,
  allowlistedEntries: string[]
): Promise<string | null> {
  let realRequested: string
  try {
    realRequested = await fs.realpath(requestedPath)
  } catch {
    return null
  }

  for (const entry of allowlistedEntries) {
    try {
      const realAllowed = await fs.realpath(entry)
      const stat = await fs.stat(realAllowed)
      if (stat.isDirectory()) {
        if (isRealPathContained(realRequested, realAllowed)) {
          return realRequested
        }
      } else if (realRequested === realAllowed) {
        return realRequested
      }
    } catch {}
  }

  return null
}

export async function isPathWithinAllowlist(
  requestedPath: string,
  allowlistedEntries: string[]
): Promise<boolean> {
  return (await resolveAllowlistedPath(requestedPath, allowlistedEntries)) !== null
}
