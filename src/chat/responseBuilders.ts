import { randomUUID } from 'node:crypto';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function openAICompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function buildMessageResponse(model: string, text: string) {
  return {
    id: openAICompletionId(),
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ]
  };
}
