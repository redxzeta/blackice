import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionEnvelope } from './schema.js'

const runCommand = vi.fn()
const isPathWithinAllowlist = vi.fn()

vi.mock('./safety.js', () => ({
  createBoundedCommandRunner: vi.fn(() => runCommand),
  isPathWithinAllowlist,
}))

vi.mock('./ollama.js', () => ({
  runWorkerText: vi.fn(),
}))

vi.mock('./router.js', () => ({
  chooseActionModel: vi.fn(() => ({ model: 'test-model' })),
}))

function tailLogAction(path: string, lines?: number): ActionEnvelope {
  return {
    action: 'tail_log',
    input: '',
    options: lines === undefined ? { path } : { path, lines },
  }
}

beforeEach(() => {
  runCommand.mockReset()
  isPathWithinAllowlist.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('actions command and path safety', () => {
  it('tails allowlisted paths through the shared bounded command runner', async () => {
    isPathWithinAllowlist.mockResolvedValue(true)
    runCommand.mockResolvedValue('line 1\nline 2')
    const { executeAction } = await import('./actions.js')

    const result = await executeAction(tailLogAction('/var/log/app.log', 999))

    expect(isPathWithinAllowlist).toHaveBeenCalledWith('/var/log/app.log', [
      '/var/log/syslog',
      '/var/log/auth.log',
    ])
    expect(runCommand).toHaveBeenCalledWith('tail', ['-n', '500', '/var/log/app.log'])
    expect(result).toEqual({
      action: 'tail_log',
      text: 'tail_log(/var/log/app.log, lines=500):\nline 1\nline 2',
    })
  })

  it('rejects denied paths before invoking a command', async () => {
    isPathWithinAllowlist.mockResolvedValue(false)
    const { executeAction } = await import('./actions.js')

    await expect(executeAction(tailLogAction('/etc/passwd'))).rejects.toThrow(
      'Requested path is not allowlisted.'
    )
    expect(runCommand).not.toHaveBeenCalled()
  })
})
