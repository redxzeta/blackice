import { afterEach, describe, expect, it } from 'vitest'
import { DebateInputError, runDebate } from './debate.js'

const ORIGINAL_ALLOWLIST = process.env.DEBATE_MODEL_ALLOWLIST

afterEach(() => {
  process.env.DEBATE_MODEL_ALLOWLIST = ORIGINAL_ALLOWLIST
})

describe('runDebate model restrictions', () => {
  it('rejects codex model even when allowlisted', async () => {
    process.env.DEBATE_MODEL_ALLOWLIST = 'gpt-5.3-codex,llama3.1:8b'

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
