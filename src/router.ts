import type { ActionName, ChatMessage } from './schema.js';
import { getObservabilityModel, isCodexModel } from './ai/modelPolicy.js';

export type RouteDecision = {
  model: string;
  reason: string;
};

const MODEL_DEFAULT = (process.env.BLACKICE_GENERAL_MODEL ?? 'llama3.1:8b').trim();
const MODEL_CODE = (process.env.BLACKICE_CODE_MODEL ?? 'qwen2.5-coder:14b').trim();
const MODEL_LONGFORM = (process.env.BLACKICE_LONGFORM_MODEL ?? 'qwen2.5:14b').trim();

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
    const nonCodexLongform = isCodexModel(MODEL_LONGFORM) ? getObservabilityModel(MODEL_LONGFORM) : MODEL_LONGFORM;
    return { model: nonCodexLongform, reason: 'longform_summary' };
  }

  const nonCodexDefault = isCodexModel(MODEL_DEFAULT) ? getObservabilityModel(MODEL_DEFAULT) : MODEL_DEFAULT;
  return { model: nonCodexDefault, reason: 'default_general' };
}

export function chooseActionModel(action: ActionName): RouteDecision {
  const nonCodexLongform = isCodexModel(MODEL_LONGFORM) ? getObservabilityModel(MODEL_LONGFORM) : MODEL_LONGFORM;
  const nonCodexDefault = isCodexModel(MODEL_DEFAULT) ? getObservabilityModel(MODEL_DEFAULT) : MODEL_DEFAULT;

  if (action === 'summarize' || action === 'transform' || action === 'extract') {
    return { model: nonCodexLongform, reason: `action_${action}` };
  }

  return { model: nonCodexDefault, reason: `action_${action}` };
}
