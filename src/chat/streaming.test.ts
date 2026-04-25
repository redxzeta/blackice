import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWorkerTextStream = vi.fn()

vi.mock('../ollama.js', () => ({
  runWorkerTextStream,
}))

type StreamStep = { type: 'text-delta'; textDelta: string } | { throw: unknown }

function mockStream(steps: StreamStep[]) {
  return {
    fullStream: (async function* generate() {
      for (const step of steps) {
        if ('throw' in step) {
          throw step.throw
        }
        yield step
      }
    })(),
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk)
      return true
    }),
    end: vi.fn(),
  }

  return { response, chunks }
}

function parseSsePayloads(chunks: string[]) {
  return chunks
    .filter((chunk) => chunk.startsWith('data: {'))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length).trim()))
}

function streamedContent(chunks: string[]) {
  return parseSsePayloads(chunks)
    .map((payload) => payload.choices?.[0]?.delta?.content)
    .filter((content): content is string => typeof content === 'string')
    .join('')
}

describe('handleChatStreaming', () => {
  beforeEach(() => {
    runWorkerTextStream.mockReset()
  })

  it('streams benign text without suppression', async () => {
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([
        { type: 'text-delta', textDelta: 'hello' },
        { type: 'text-delta', textDelta: ' world' },
      ])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe('hello world')
    expect(chunks.join('')).not.toContain('suppressed')
  })

  it('streams benign JSON-like text that is not a tool call payload', async () => {
    const jsonText = '{"status":"ok","message":"normal structured explanation"}'
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([{ type: 'text-delta', textDelta: jsonText }])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(jsonText)
    expect(chunks.join('')).not.toContain('suppressed')
  })

  it('does not suppress prose that mentions tool-call-shaped JSON later in the text', async () => {
    const text = 'Example JSON: {"name":"lookup","arguments":{"query":"weather"}}'
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([{ type: 'text-delta', textDelta: text }])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(text)
    expect(chunks.join('')).not.toContain('suppressed')
  })

  it('suppresses tool-call-shaped JSON split across chunk boundaries', async () => {
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([
        { type: 'text-delta', textDelta: '{"na' },
        { type: 'text-delta', textDelta: 'me":"lookup","arg' },
        { type: 'text-delta', textDelta: 'uments":{"query":"secret"}}' },
      ])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(
      'Model output suppressed because it resembled a tool call payload.'
    )
    expect(chunks.join('')).not.toContain('lookup')
    expect(chunks.join('')).not.toContain('secret')
  })

  it('suppresses tool_calls payloads before streaming raw tool details', async () => {
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([
        { type: 'text-delta', textDelta: '{"tool_' },
        { type: 'text-delta', textDelta: 'calls":[{"function":{"name":"lookup"}}]}' },
      ])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(
      'Model output suppressed because it resembled a tool call payload.'
    )
    expect(chunks.join('')).not.toContain('tool_calls')
    expect(chunks.join('')).not.toContain('lookup')
  })

  it('flushes incomplete malformed JSON-like text without throwing when it is not tool-shaped', async () => {
    const malformed = '{"status":"ok"'
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([{ type: 'text-delta', textDelta: malformed }])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(malformed)
    expect(response.end).toHaveBeenCalledTimes(1)
  })

  it('streams refusal text normally', async () => {
    const refusal = "I can't help with that request."
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([{ type: 'text-delta', textDelta: refusal }])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello')

    expect(streamedContent(chunks)).toBe(refusal)
    expect(response.end).toHaveBeenCalledTimes(1)
  })

  it('falls back before content and keeps a single model in emitted chunks', async () => {
    runWorkerTextStream
      .mockImplementationOnce(() =>
        mockStream([
          {
            throw: {
              error_code: 'cyber_policy_violation',
              param: 'safety_identifier',
            },
          },
        ])
      )
      .mockImplementationOnce(() =>
        mockStream([{ type: 'text-delta', textDelta: 'fallback content' }])
      )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response, chunks } = makeResponse()

    await handleChatStreaming(
      response as never,
      'gpt-5.3-codex',
      'hello',
      0.1,
      256,
      'req-1',
      'usr_1'
    )

    expect(runWorkerTextStream).toHaveBeenCalledTimes(2)
    const payloads = parseSsePayloads(chunks)
    const models = payloads.map((p) => p.model).filter(Boolean)
    expect(models.every((model) => model === 'qwen2.5:14b')).toBe(true)
  })

  it('does not fallback when policy error happens after content is emitted', async () => {
    runWorkerTextStream.mockImplementationOnce(() =>
      mockStream([
        { type: 'text-delta', textDelta: 'partial' },
        {
          throw: {
            error_code: 'cyber_policy_violation',
            param: 'safety_identifier',
          },
        },
      ])
    )

    const { handleChatStreaming } = await import('./streaming.js')
    const { response } = makeResponse()

    await expect(
      handleChatStreaming(response as never, 'gpt-5.3-codex', 'hello', 0.1, 256, 'req-1', 'usr_1')
    ).rejects.toBeTruthy()

    expect(runWorkerTextStream).toHaveBeenCalledTimes(1)
  })
})
