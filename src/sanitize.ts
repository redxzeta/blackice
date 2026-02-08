function stripFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/gm, '')
    .replace(/```$/gm, '')
    .trim();
}

function isToolCallLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const hasName = typeof parsed.name === 'string';
    const hasArgs = Object.prototype.hasOwnProperty.call(parsed, 'arguments');
    const hasToolCalls = Object.prototype.hasOwnProperty.call(parsed, 'tool_calls');
    return (hasName && hasArgs) || hasToolCalls;
  } catch {
    return false;
  }
}

export function sanitizeLLMOutput(text: string): { ok: true; text: string } | { ok: false; error: string } {
  const cleaned = stripFences(text);

  if (isToolCallLikeJson(cleaned)) {
    return {
      ok: false,
      error: 'Model returned tool-call-shaped JSON, which is not allowed by the worker contract.'
    };
  }

  return { ok: true, text: cleaned };
}

export function buildWorkerContractPrompt(input: string, explicitJsonAllowed = false): string {
  const jsonRule = explicitJsonAllowed
    ? 'JSON is allowed only because this action explicitly requested it.'
    : 'Do not output JSON.';

  return [
    'Worker Contract:',
    'Respond in plain English text only.',
    'Do not use markdown fences.',
    jsonRule,
    'Do not propose or emit tool calls.',
    'Do not include meta commentary about rules or policy.',
    'No preamble and no postscript.',
    '',
    'User Input:',
    input
  ].join('\n');
}
