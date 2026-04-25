import type { Response } from 'express'
import { getPolicyFallbackModel } from '../ai/modelPolicy.js'
import { parsePolicySignal } from '../ai/policySignal.js'
import { log } from '../log.js'
import { runWorkerTextStream } from '../ollama.js'
import { nowSeconds, openAICompletionId } from './responseBuilders.js'

type StreamDeltaEvent = {
  type: 'text-delta'
  textDelta: string
}

const MAX_STRUCTURED_GATE_BUFFER_CHARS = 8192
const SUPPRESSED_TOOL_PAYLOAD_MESSAGE =
  'Model output suppressed because it resembled a tool call payload.'

function sendSSEChunk(res: Response, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function isTextDeltaEvent(part: unknown): part is StreamDeltaEvent {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text-delta' &&
    typeof (part as { textDelta?: unknown }).textDelta === 'string'
  )
}

type JsonCandidate = { kind: 'none' } | { kind: 'pending' } | { kind: 'json'; text: string }

function getLeadingJsonCandidate(buffer: string): JsonCandidate {
  const trimmedStart = buffer.trimStart()

  if (!trimmedStart) {
    return { kind: 'pending' }
  }

  let candidate = trimmedStart

  if (candidate.startsWith('```')) {
    const fenceLineEnd = candidate.indexOf('\n')
    if (fenceLineEnd === -1) {
      return { kind: 'pending' }
    }

    candidate = candidate.slice(fenceLineEnd + 1).trimStart()

    if (!candidate) {
      return { kind: 'pending' }
    }
  }

  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    return { kind: 'none' }
  }

  return { kind: 'json', text: candidate }
}

function parseJsonStringEnd(text: string, start: number): number | null {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '"') {
      return index + 1
    }
  }

  return null
}

function collectTopLevelObjectKeys(text: string): Set<string> {
  const keys = new Set<string>()
  if (!text.startsWith('{')) {
    return keys
  }

  let index = 1
  while (index < text.length) {
    while (/\s|,/.test(text[index] ?? '')) {
      index += 1
    }

    if (text[index] === '}') {
      break
    }

    if (text[index] !== '"') {
      break
    }

    const keyEnd = parseJsonStringEnd(text, index)
    if (keyEnd === null) {
      break
    }

    let colonIndex = keyEnd
    while (/\s/.test(text[colonIndex] ?? '')) {
      colonIndex += 1
    }

    if (text[colonIndex] !== ':') {
      break
    }

    try {
      keys.add(JSON.parse(text.slice(index, keyEnd)) as string)
    } catch {
      break
    }

    index = colonIndex + 1
    const stack: string[] = []
    let inString = false

    while (index < text.length) {
      const char = text[index]

      if (inString) {
        if (char === '\\') {
          index += 2
          continue
        }
        if (char === '"') {
          inString = false
        }
        index += 1
        continue
      }

      if (char === '"') {
        inString = true
        index += 1
        continue
      }

      if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']')
      } else if ((char === '}' || char === ']') && stack.at(-1) === char) {
        stack.pop()
      } else if (stack.length === 0 && (char === ',' || char === '}')) {
        break
      }

      index += 1
    }

    if (keys.has('tool_calls') || (keys.has('name') && keys.has('arguments'))) {
      break
    }
  }

  return keys
}

function looksLikeToolCallPayload(text: string): boolean {
  const keys = collectTopLevelObjectKeys(text)
  return keys.has('tool_calls') || (keys.has('name') && keys.has('arguments'))
}

function findCompleteJsonEnd(text: string): number | null {
  const stack: string[] = []
  let inString = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']')
      continue
    }

    if (char !== '}' && char !== ']') {
      continue
    }

    if (stack.at(-1) !== char) {
      return index + 1
    }

    stack.pop()
    if (stack.length === 0) {
      return index + 1
    }
  }

  return null
}

export async function handleChatStreaming(
  res: Response,
  modelId: string,
  input: string,
  temperature?: number,
  maxTokens?: number,
  requestId?: string,
  safetyIdentifier?: string
): Promise<void> {
  const id = openAICompletionId()
  const created = nowSeconds()
  let responseModel = modelId
  let emittedAnyContent = false
  let roleSent = false

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const sendRoleChunk = (): void => {
    if (roleSent) {
      return
    }
    roleSent = true
    sendSSEChunk(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: responseModel,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null,
        },
      ],
    })
  }

  const pipeModelStream = async (activeModel: string): Promise<void> => {
    const streamResult = runWorkerTextStream({
      modelId: activeModel,
      input,
      temperature,
      maxTokens,
      requestId,
      safetyIdentifier,
      routeKind: 'chat',
    })

    let gating = true
    let preBuffer = ''

    const emitContent = (content: string): void => {
      if (!content) {
        return
      }

      sendRoleChunk()
      sendSSEChunk(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      })
      emittedAnyContent = true
    }

    const suppressToolPayload = (): void => {
      gating = false
      preBuffer = ''
      emitContent(SUPPRESSED_TOOL_PAYLOAD_MESSAGE)
    }

    const inspectBufferedPrefix = (): void => {
      const candidate = getLeadingJsonCandidate(preBuffer)

      if (candidate.kind === 'pending') {
        return
      }

      if (candidate.kind === 'none') {
        gating = false
        emitContent(preBuffer)
        preBuffer = ''
        return
      }

      if (looksLikeToolCallPayload(candidate.text)) {
        suppressToolPayload()
        return
      }

      const completeJsonEnd = findCompleteJsonEnd(candidate.text)
      if (completeJsonEnd !== null) {
        try {
          JSON.parse(candidate.text.slice(0, completeJsonEnd))
        } catch {
          gating = false
          emitContent(preBuffer)
          preBuffer = ''
          return
        }

        gating = false
        emitContent(preBuffer)
        preBuffer = ''
        return
      }

      if (preBuffer.length > MAX_STRUCTURED_GATE_BUFFER_CHARS) {
        gating = false
        emitContent(preBuffer)
        preBuffer = ''
      }
    }

    for await (const part of streamResult.fullStream) {
      if (!isTextDeltaEvent(part)) {
        continue
      }

      const delta = String(part.textDelta ?? '')
      if (!delta) {
        continue
      }

      if (gating) {
        preBuffer += delta
        inspectBufferedPrefix()
        continue
      }

      emitContent(delta)
    }

    if (gating && preBuffer) {
      const candidate = getLeadingJsonCandidate(preBuffer)
      if (candidate.kind === 'json' && looksLikeToolCallPayload(candidate.text)) {
        suppressToolPayload()
        return
      }

      emitContent(preBuffer)
    }
  }

  try {
    await pipeModelStream(modelId)
  } catch (error: unknown) {
    const signal = parsePolicySignal(error)
    if (!signal.isCyberPolicyViolation) {
      throw error
    }

    // Avoid mixing partial output from two different model executions in one stream.
    if (emittedAnyContent) {
      throw error
    }

    const fallbackModel = getPolicyFallbackModel(modelId)
    if (fallbackModel === modelId) {
      throw error
    }
    responseModel = fallbackModel

    log.info('policy_trigger_event', {
      request_id: requestId ?? null,
      route_kind: 'chat',
      trigger: 'cyber_policy_violation',
      error_code: signal.errorCode ?? 'cyber_policy_violation',
      param: signal.param ?? null,
      primary_model: modelId,
      fallback_model: fallbackModel,
      safety_identifier_present: Boolean(safetyIdentifier),
      fallback_attempted: true,
    })

    try {
      await pipeModelStream(fallbackModel)
      log.info('policy_trigger_event', {
        request_id: requestId ?? null,
        route_kind: 'chat',
        trigger: 'cyber_policy_violation',
        primary_model: modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: true,
      })
    } catch (fallbackError: unknown) {
      log.error('policy_trigger_event', {
        request_id: requestId ?? null,
        route_kind: 'chat',
        trigger: 'cyber_policy_violation',
        primary_model: modelId,
        fallback_model: fallbackModel,
        fallback_attempted: true,
        fallback_success: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      })
      throw fallbackError
    }
  }

  sendRoleChunk()
  sendSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: responseModel,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  })

  res.write('data: [DONE]\n\n')
  res.end()
}
