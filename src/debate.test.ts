import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function writeConfig(modelAllowlist: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blackice-debate-test-'))
  const file = path.join(dir, 'blackice.test.yaml')
  writeFileSync(
    file,
    `version: 1
debate:
  modelAllowlist:
${modelAllowlist.map((model) => `    - "${model}"`).join('\n')}
ollama:
  baseUrl: http://127.0.0.1:11434
  model: qwen2.5:14b
`
  )
  tempDirs.push(dir)
  return file
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('runDebate model restrictions', () => {
  it('rejects codex model even when allowlisted', async () => {
    vi.stubEnv('BLACKICE_CONFIG_FILE', writeConfig(['gpt-5.3-codex', 'llama3.1:8b']))
    const { DebateInputError, runDebate } = await import('./debate.js')

    try {
      await runDebate({
        topic: 'Reliability versus experimentation',
        user: 'test-user',
        modelA: 'gpt-5.3-codex',
        modelB: 'llama3.1:8b',
        rounds: 1,
        turnsPerRound: 4,
        maxTurnChars: 400,
        moderator_decision_mode: 'openclaw_decides',
        includeModeratorSummary: false,
      })
      expect.unreachable('Expected runDebate to throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DebateInputError)
      expect(error).toMatchObject({
        message: 'Codex models are restricted to code generation routes: gpt-5.3-codex',
      })
    }
  })
})
