import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

type BoundedCommandOptions = {
  timeoutMs: number
  maxBytes: number
  onError?: (message: string, status?: number) => Error
}

function buildDefaultError(message: string): Error {
  return new Error(message)
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

    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGKILL')
      reject(toError(`command timed out for ${command}`, 504))
    }, options.timeoutMs)

    child.stdout.on('data', (buf: Buffer) => {
      if (settled) {
        return
      }

      stdout += buf.toString('utf8')
      if (Buffer.byteLength(stdout, 'utf8') > options.maxBytes) {
        settled = true
        child.kill('SIGKILL')
        reject(toError('command output exceeded byte limit', 413))
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
      reject(toError(`failed to execute ${command}: ${error.message}`, 500))
    })

    child.on('close', (code: number | null) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)

      if (code !== 0) {
        reject(toError(`${command} failed: ${stderr.trim() || `exit code ${String(code)}`}`, 502))
        return
      }

      resolve(stdout.trim())
    })
  })
}

export async function isPathWithinAllowlist(
  requestedPath: string,
  allowlistedEntries: string[]
): Promise<boolean> {
  let realRequested: string
  try {
    realRequested = await fs.realpath(requestedPath)
  } catch {
    return false
  }

  for (const entry of allowlistedEntries) {
    try {
      const realAllowed = await fs.realpath(entry)
      const stat = await fs.stat(realAllowed)
      if (stat.isDirectory()) {
        const normalized = realAllowed.endsWith(path.sep) ? realAllowed : `${realAllowed}${path.sep}`
        if (realRequested.startsWith(normalized)) {
          return true
        }
      } else if (realRequested === realAllowed) {
        return true
      }
    } catch {}
  }

  return false
}
