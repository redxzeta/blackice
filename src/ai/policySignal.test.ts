import { describe, expect, it } from 'vitest'
import { parsePolicySignal } from './policySignal.js'

describe('parsePolicySignal', () => {
  it('detects cyber policy violation from structured fields', () => {
    const signal = parsePolicySignal({
      error: {
        error_code: 'cyber_policy_violation',
        param: 'safety_identifier',
        message: 'blocked',
      },
    })

    expect(signal.isCyberPolicyViolation).toBe(true)
    expect(signal.errorCode).toBe('cyber_policy_violation')
    expect(signal.param).toBe('safety_identifier')
  })

  it('detects policy signal from message-only payloads', () => {
    const signal = parsePolicySignal('error_code: cyber_policy_violation param: safety_identifier')
    expect(signal.isCyberPolicyViolation).toBe(true)
    expect(signal.errorCode).toBe('cyber_policy_violation')
    expect(signal.param).toBe('safety_identifier')
  })
})
