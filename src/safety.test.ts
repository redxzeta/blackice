import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isPathWithinAllowlist } from './safety.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safety.ts', () => {
  it('allows files inside an allowlisted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const allowedDir = path.join(root, 'logs')
    const nestedDir = path.join(allowedDir, 'nested')
    const targetFile = path.join(nestedDir, 'app.log')

    await mkdir(nestedDir, { recursive: true })
    await writeFile(targetFile, 'ok\n', 'utf8')

    await expect(isPathWithinAllowlist(targetFile, [allowedDir])).resolves.toBe(true)
  })

  it('rejects sibling files outside an allowlisted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const allowedDir = path.join(root, 'logs')
    const outsideDir = path.join(root, 'logs-archive')
    const targetFile = path.join(outsideDir, 'app.log')

    await mkdir(allowedDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(targetFile, 'nope\n', 'utf8')

    await expect(isPathWithinAllowlist(targetFile, [allowedDir])).resolves.toBe(false)
  })

  it('resolves symlinked allowlist entries before checking containment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const realDir = path.join(root, 'real')
    const aliasDir = path.join(root, 'alias')
    const targetFile = path.join(realDir, 'app.log')

    await mkdir(realDir, { recursive: true })
    await writeFile(targetFile, 'ok\n', 'utf8')
    await symlink(realDir, aliasDir)

    await expect(isPathWithinAllowlist(targetFile, [aliasDir])).resolves.toBe(true)
  })
})
