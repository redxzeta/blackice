import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function writeConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-readiness-'))
  const file = path.join(dir, 'blackice.test.yaml')
  writeFileSync(file, contents)
  tempDirs.push(dir)
  return file
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as never
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.stubGlobal('fetch', okFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('readiness storage checks', () => {
  it('includes execution storage success in readiness output', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'blackice-readiness-storage-'))
    tempDirs.push(storageDir)
    const configFile = writeConfig(`version: 1
execution:
  storageKind: file
  storagePath: ${JSON.stringify(path.join(storageDir, 'execution-state.json'))}
`)
    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)

    const { checkReadiness } = await import('./readiness.js')

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: true,
      checks: {
        executionStorage: {
          ok: true,
          storageKind: 'file',
        },
      },
    })
  })

  it('marks readiness unready when durable storage parent is unavailable', async () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), 'blackice-readiness-storage-'))
    tempDirs.push(configRoot)
    const missingParentPath = path.join(configRoot, 'missing', 'execution-state.json')
    const configFile = writeConfig(`version: 1
execution:
  storageKind: file
  storagePath: ${JSON.stringify(missingParentPath)}
`)
    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)

    const { checkReadiness } = await import('./readiness.js')

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      checks: {
        executionStorage: {
          ok: false,
          reason: expect.stringContaining('execution storage parent'),
        },
      },
    })
  })

  it('marks readiness unready when durable storage state is corrupted', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'blackice-readiness-storage-'))
    tempDirs.push(storageDir)
    mkdirSync(storageDir, { recursive: true })
    const storagePath = path.join(storageDir, 'execution-state.json')
    writeFileSync(storagePath, '{not-json', 'utf8')
    const configFile = writeConfig(`version: 1
execution:
  storageKind: file
  storagePath: ${JSON.stringify(storagePath)}
`)
    vi.stubEnv('BLACKICE_CONFIG_FILE', configFile)

    const { checkReadiness } = await import('./readiness.js')

    await expect(checkReadiness()).resolves.toMatchObject({
      ok: false,
      checks: {
        executionStorage: {
          ok: false,
          reason: expect.stringContaining('execution storage state is unreadable'),
        },
      },
    })
  })
})
