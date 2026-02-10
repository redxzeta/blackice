import type { AnalyzeLogsRequest } from './schema.js';

export const SYSTEM_PROMPT = `You are a senior Linux infrastructure engineer acting as a log analysis assistant.

[...FULL SYSTEM PROMPT FROM PREVIOUS MESSAGE...]
`;

const MAX_LOG_CHARS = Number(process.env.MAX_LOG_CHARS ?? 40_000);

export function truncateLogs(input: string): { text: string; truncated: boolean } {
  if (input.length <= MAX_LOG_CHARS) {
    return { text: input, truncated: false };
  }

  // Keep recent lines because root-cause signals are usually near the tail.
  return {
    text: input.slice(input.length - MAX_LOG_CHARS),
    truncated: true
  };
}

export function buildUserPrompt(request: AnalyzeLogsRequest & { logs: string; truncated: boolean }): string {
  return `Analyze the following logs and produce a structured markdown report.

Context:
- source: ${request.source}
- target: ${request.target}
- hours: ${request.hours}
- maxLines: ${request.maxLines}
- logsTruncated: ${request.truncated}

Required output markdown sections:
1. Summary
2. Key Findings
3. Most Likely Root Cause
4. Confidence (High/Medium/Low)
5. Recommended Next Safe Checks (read-only)

Logs:
\`\`\`
${request.logs}
\`\`\``;
}
