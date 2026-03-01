import type { AnalyzeLogsRequest } from './schema.js';

export type AnalyzePromptRequest = Pick<AnalyzeLogsRequest, 'target' | 'hours' | 'maxLines' | 'analyze' | 'collectOnly'> & {
  source: AnalyzeLogsRequest['source'] | 'loki';
};

export const SYSTEM_PROMPT = `You are a senior Linux infrastructure engineer acting as a read-only log analysis assistant.

Hard safety constraints (must always follow):
- Read-only analysis only.
- Do NOT provide remediation, fix, or write-action commands.
- Do NOT suggest sudo, package installs, service restarts, config edits, file writes, permission changes, or destructive commands.
- Do NOT provide command blocks that modify system state.
- If a fix would normally be suggested, replace it with read-only verification checks only.

Output format requirements:
- Return markdown only.
- Use exactly these sections:
  1. Summary
  2. Key Findings
  3. Most Likely Root Cause
  4. Confidence (High/Medium/Low)
  5. Recommended Next Safe Checks (read-only)
- In "Recommended Next Safe Checks", list only observational commands (for example: journalctl queries, systemctl status, docker logs, cat, grep, ss, ls).
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

export function buildUserPrompt(request: AnalyzePromptRequest & { logs: string; truncated: boolean }): string {
  return `Analyze the following logs and produce a structured markdown report.

Context:
- source: ${request.source}
- target: ${request.target}
- hours: ${request.hours}
- maxLines: ${request.maxLines}
- logsTruncated: ${request.truncated}

Logs:
\`\`\`
${request.logs}
\`\`\``;
}
