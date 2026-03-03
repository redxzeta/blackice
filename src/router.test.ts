import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('router codex split', () => {
  it('routes non-code chat away from codex models', async () => {
    process.env.BLACKICE_GENERAL_MODEL = 'gpt-5.3-codex';
    process.env.BLACKICE_LONGFORM_MODEL = 'gpt-5.3-codex';
    process.env.BLACKICE_OBSERVABILITY_MODEL = 'qwen2.5:14b';

    const { chooseChatModel } = await import('./router.js');

    const general = chooseChatModel([{ role: 'user', content: 'explain linux memory pressure in plain terms' }]);
    const longform = chooseChatModel([{ role: 'user', content: `summarize ${'text '.repeat(100)}` }]);

    expect(general.model).toBe('qwen2.5:14b');
    expect(longform.model).toBe('qwen2.5:14b');
  });

  it('keeps code generation route on configured code model', async () => {
    process.env.BLACKICE_CODE_MODEL = 'gpt-5.3-codex';

    const { chooseChatModel } = await import('./router.js');
    const result = chooseChatModel([{ role: 'user', content: 'debug this typescript function' }]);

    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.reason).toBe('code_keywords');
  });
});

