const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bapt(?:-get)?\b/i,
  /\byum\b/i,
  /\bdnf\b/i,
  /\bpacman\b/i,
  /\bbrew\b/i,
  /\brm\b\s+-/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsystemctl\s+(?:start|restart|enable|disable|stop)\b/i,
  /\bservice\s+\S+\s+(?:start|restart|stop)\b/i,
  /\bpostconf\b/i,
  /\bpostfix\s+(?:reload|start|stop|restart)\b/i,
  /\btee\b\s+\/etc\//i,
  />\s*\/etc\//i,
  /\bmv\b\s+\S+\s+\/(?:etc|usr|var)\//i,
  /\bcp\b\s+\S+\s+\/(?:etc|usr|var)\//i,
  /\bkill(?:all)?\b/i,
  // Allow plain mention of firewall tools in explanations; block mutating commands.
  /\biptables\s+-(?:A|D|I|P|F|X|N|R|Z)\b/i,
  /\bufw\s+(?:enable|disable|reset|allow|deny|reject|limit|delete|reload)\b/i
];

export function ensureReadOnlyAnalysisOutput(analysis: string): { safe: true } | { safe: false; reason: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(analysis)) {
      return {
        safe: false,
        reason: `Unsafe remediation content detected (${pattern})`
      };
    }
  }

  return { safe: true };
}

function linePrefixForRedaction(line: string): string {
  const match = line.match(/^(\s*(?:[-*]|\d+\.)\s*)/);
  if (!match) {
    return '';
  }
  return match[1];
}

export function sanitizeReadOnlyAnalysisOutput(analysis: string): {
  analysis: string;
  redacted: boolean;
  reasons: string[];
} {
  const reasons = new Set<string>();
  const lines = analysis.split('\n');
  let inFence = false;
  let changed = false;

  const sanitizedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      return line;
    }

    const matched = FORBIDDEN_PATTERNS.find((pattern) => pattern.test(line));
    if (!matched) {
      return line;
    }

    reasons.add(String(matched));
    changed = true;

    // Redact actionable content in code blocks, bullets, or command-like suggestions.
    if (inFence || line.includes('`') || /^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      return `${linePrefixForRedaction(line)}[REDACTED unsafe remediation command removed]`;
    }

    // Fallback for prose containing imperative command snippets.
    return line.replace(matched, '[REDACTED]');
  });

  if (!changed) {
    return { analysis, redacted: false, reasons: [] };
  }

  const safetyNote = [
    '### Safety Note',
    'Potentially unsafe remediation commands were removed from this analysis.',
    ''
  ].join('\n');

  return {
    analysis: `${safetyNote}${sanitizedLines.join('\n')}`,
    redacted: true,
    reasons: Array.from(reasons)
  };
}
