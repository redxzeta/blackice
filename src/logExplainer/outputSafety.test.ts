import { describe, expect, it } from 'vitest'

import {
  redactSecrets,
  sanitizeReadOnlyAnalysisOutput,
  sanitizeReadOnlyEvidenceLine,
} from './outputSafety.js'

describe('log explainer output safety', () => {
  it('redacts common secret formats', () => {
    const input = [
      'authorization: Bearer abc123',
      'x-api-key: secret-key',
      'token=my-token',
      'password: hunter2',
    ].join('\n')

    const result = redactSecrets(input)

    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain('abc123')
    expect(result.text).not.toContain('secret-key')
    expect(result.text).not.toContain('my-token')
    expect(result.text).not.toContain('hunter2')
    expect(result.reasons).toEqual(
      expect.arrayContaining(['bearer_token', 'api_key_header', 'secret_assignment'])
    )
  })

  it('redacts secrets in evidence lines', () => {
    expect(sanitizeReadOnlyEvidenceLine('authorization: Bearer abc123')).toBe(
      'authorization: Bearer [REDACTED]'
    )
  })

  it('removes unsafe commands from analysis output', () => {
    const result = sanitizeReadOnlyAnalysisOutput([
      '## Recommended Next Safe Checks',
      '- sudo systemctl restart ssh',
    ].join('\n'))

    expect(result.redacted).toBe(true)
    expect(result.analysis).toContain('Safety Note')
    expect(result.analysis).toContain('[REDACTED unsafe remediation command removed]')
  })
})
