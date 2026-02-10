const DEFAULT_MAX_LOG_CHARS = Number(process.env.MAX_LOG_CHARS ?? 40_000);

export function truncateLogs(input) {
  if (input.length <= DEFAULT_MAX_LOG_CHARS) {
    return {
      text: input,
      truncated: false
    };
  }

  // Keep the newest part by trimming from the front, since failures are usually near the end.
  return {
    text: input.slice(input.length - DEFAULT_MAX_LOG_CHARS),
    truncated: true
  };
}

export function buildUserPrompt({ source, target, hours, maxLines, logs, truncated }) {
  return `Analyze the following logs and produce a structured markdown report.

Context:
- source: ${source}
- target: ${target}
- hours: ${hours}
- maxLines: ${maxLines}
- logsTruncated: ${truncated}

Required output markdown sections:
1. Summary
2. Key Findings
3. Most Likely Root Cause
4. Confidence (High/Medium/Low)
5. Recommended Next Safe Checks (read-only)

Logs:
\`\`\`
${logs}
\`\`\``;
}
