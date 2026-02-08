import type { ActionName, ChatMessage } from './schema.js';

export type RouteDecision = {
  model: string;
  reason: string;
};

const MODEL_DEFAULT = 'llama3.1:8b';
const MODEL_CODE = 'qwen2.5-coder:14b';
const MODEL_LONGFORM = 'qwen2.5:14b';

const codeRegex = /(typescript|javascript|node\.js|nodejs|python|go|rust|java|c\+\+|debug|bug|stack trace|regex|sql|api|function|class|compile|refactor|test|npm|yarn|pnpm|dockerfile|bash script|shell script|code)/i;
const longformRegex = /(summarize|summary|rewrite|rephrase|improve writing|draft|long|detailed|condense|extract key points)/i;

function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return messages[messages.length - 1]?.content ?? '';
}

export function chooseChatModel(messages: ChatMessage[]): RouteDecision {
  const text = latestUserText(messages);

  if (codeRegex.test(text)) {
    return { model: MODEL_CODE, reason: 'code_keywords' };
  }

  if (longformRegex.test(text) && text.length > 300) {
    return { model: MODEL_LONGFORM, reason: 'longform_summary' };
  }

  return { model: MODEL_DEFAULT, reason: 'default_general' };
}

export function chooseActionModel(action: ActionName): RouteDecision {
  if (action === 'summarize' || action === 'transform' || action === 'extract') {
    return { model: MODEL_LONGFORM, reason: `action_${action}` };
  }

  return { model: MODEL_DEFAULT, reason: `action_${action}` };
}
