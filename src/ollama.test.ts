import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  modelFactory: vi.fn((modelId: string) => ({ modelId }))
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  streamText: mocks.streamText
}));

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => mocks.modelFactory)
}));

describe('runWorkerText policy fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back when structured cyber policy violation is returned', async () => {
    mocks.generateText
      .mockRejectedValueOnce({
        error: {
          error_code: 'cyber_policy_violation',
          param: 'safety_identifier',
          message: 'blocked by policy'
        }
      })
      .mockResolvedValueOnce({ text: 'fallback-ok' });

    const { runWorkerText } = await import('./ollama.js');

    const result = await runWorkerText({
      modelId: 'gpt-5.3-codex',
      input: 'hello world',
      requestId: 'req-123',
      safetyIdentifier: 'usr_123',
      routeKind: 'chat'
    });

    expect(result.text).toBe('fallback-ok');
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateText.mock.calls[0][0].model).toEqual({ modelId: 'gpt-5.3-codex' });
    expect(mocks.generateText.mock.calls[1][0].model).toEqual({ modelId: 'qwen2.5:14b' });
    expect(mocks.generateText.mock.calls[0][0].headers).toMatchObject({
      'X-Request-ID': 'req-123',
      'X-Safety-Identifier': 'usr_123'
    });
  });

  it('does not fallback for non-policy errors', async () => {
    mocks.generateText.mockRejectedValueOnce(new Error('network down'));
    const { runWorkerText } = await import('./ollama.js');

    await expect(
      runWorkerText({
        modelId: 'gpt-5.3-codex',
        input: 'hello world',
        requestId: 'req-123',
        safetyIdentifier: 'usr_123',
        routeKind: 'chat'
      })
    ).rejects.toThrow('network down');

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });
});

