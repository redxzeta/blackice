import { ActionEnvelopeSchema, ChatMessage } from './schema.js';

export type ParsedEnvelope =
  | { kind: 'action'; raw: string; action: ReturnType<typeof ActionEnvelopeSchema.parse> }
  | { kind: 'chat'; raw: string };

function latestUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return messages[messages.length - 1]?.content ?? '';
}

function looksSingleLineJsonObject(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  return !trimmed.includes('\n');
}

export function parseEnvelope(messages: ChatMessage[]): ParsedEnvelope {
  const raw = latestUserContent(messages).trim();

  if (!looksSingleLineJsonObject(raw)) {
    return { kind: 'chat', raw };
  }

  try {
    const parsed = JSON.parse(raw);
    const action = ActionEnvelopeSchema.parse(parsed);
    return { kind: 'action', raw, action };
  } catch {
    return { kind: 'chat', raw };
  }
}
