import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isPathWithinAllowlist, resolveAllowlistedPath, runBoundedCommand } from './safety.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safety.ts', () => {
  it('runs bounded commands and trims successful stdout', async () => {
    await expect(
      runBoundedCommand(process.execPath, ['-e', 'process.stdout.write(" ok\\n")'], {
        timeoutMs: 1_000,
        maxBytes: 1024,
      })
    ).resolves.toBe('ok')
  })

  it('maps command failures through the configured error builder', async () => {
    await expect(
      runBoundedCommand(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(2)'], {
        timeoutMs: 1_000,
        maxBytes: 1024,
        onError: (message, status) => Object.assign(new Error(message), { status }),
      })
    ).rejects.toMatchObject({
      message: `${process.execPath} failed: bad`,
      status: 502,
    })
  })

  it('cancels commands when the abort signal fires', async () => {
    const controller = new AbortController()
    const command = runBoundedCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      timeoutMs: 1_000,
      maxBytes: 1024,
      signal: controller.signal,
      onError: (message, status) => Object.assign(new Error(message), { status }),
    })

    controller.abort()

    await expect(command).rejects.toMatchObject({
      message: `command cancelled for ${process.execPath}`,
      status: 499,
    })
  })

  it('terminates commands that exceed the timeout', async () => {
    await expect(
      runBoundedCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
        timeoutMs: 25,
        maxBytes: 1024,
        onError: (message, status) => Object.assign(new Error(message), { status }),
      })
    ).rejects.toMatchObject({
      message: `command timed out for ${process.execPath}`,
      status: 504,
    })
  })

  it('terminates commands that exceed the output byte limit', async () => {
    await expect(
      runBoundedCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], {
        timeoutMs: 1_000,
        maxBytes: 64,
        onError: (message, status) => Object.assign(new Error(message), { status }),
      })
    ).rejects.toMatchObject({
      message: 'command output exceeded byte limit',
      status: 413,
    })
  })

  it('allows files inside an allowlisted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const allowedDir = path.join(root, 'logs')
    const nestedDir = path.join(allowedDir, 'nested')
    const targetFile = path.join(nestedDir, 'app.log')

    await mkdir(nestedDir, { recursive: true })
    await writeFile(targetFile, 'ok\n', 'utf8')

    await expect(isPathWithinAllowlist(targetFile, [allowedDir])).resolves.toBe(true)
    await expect(resolveAllowlistedPath(targetFile, [allowedDir])).resolves.toBe(
      await realpath(targetFile)
    )
  })

  it('allows files that are explicitly allowlisted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const targetFile = path.join(root, 'app.log')

    await writeFile(targetFile, 'ok\n', 'utf8')

    await expect(isPathWithinAllowlist(targetFile, [targetFile])).resolves.toBe(true)
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

  it('rejects traversal paths that resolve outside an allowlisted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const allowedDir = path.join(root, 'logs')
    const outsideDir = path.join(root, 'outside')
    const targetFile = path.join(outsideDir, 'app.log')
    const traversalPath = path.join(allowedDir, '..', 'outside', 'app.log')

    await mkdir(allowedDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(targetFile, 'nope\n', 'utf8')

    await expect(isPathWithinAllowlist(traversalPath, [allowedDir])).resolves.toBe(false)
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

  it('rejects symlinked requested paths that escape an allowlisted directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-safety-'))
    const allowedDir = path.join(root, 'logs')
    const outsideDir = path.join(root, 'outside')
    const outsideFile = path.join(outsideDir, 'app.log')
    const linkFile = path.join(allowedDir, 'app.log')

    await mkdir(allowedDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(outsideFile, 'nope\n', 'utf8')
    await symlink(outsideFile, linkFile)

    await expect(isPathWithinAllowlist(linkFile, [allowedDir])).resolves.toBe(false)
  })
})
