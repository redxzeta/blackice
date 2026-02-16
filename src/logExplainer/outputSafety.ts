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
