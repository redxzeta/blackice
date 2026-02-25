import { readFileSync } from 'node:fs';

export type VersionInfo = {
  name: string;
  version: string;
  gitSha: string | null;
  buildTime: string | null;
};

let cached: VersionInfo | null = null;

function readPackageJson(): { name: string; version: string } {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'blackice-policy-router',
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  };
}

export function getVersionInfo(): VersionInfo {
  if (cached) {
    return cached;
  }

  const pkg = readPackageJson();
  cached = {
    name: pkg.name,
    version: pkg.version,
    gitSha: process.env.BUILD_GIT_SHA ?? null,
    buildTime: process.env.BUILD_TIME ?? null
  };
  return cached;
}
