import { describe, expect, it, vi } from 'vitest'

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

describe('handleChatStreaming', () => {
  it('falls back before content and keeps a single model in emitted chunks', async () => {
    runWorkerTextStream.mockReset()
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
    runWorkerTextStream.mockReset()
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
