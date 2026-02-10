import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function buildTimestampUTC() {
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, 'Z');
}

function getVersion() {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw);
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', tag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const version = getVersion();
const tag = `change/v${version}-${buildTimestampUTC()}`;

if (tagExists(tag)) {
  console.error(`Tag already exists: ${tag}`);
  process.exit(1);
}

execFileSync('git', ['tag', '-a', tag, '-m', `Change tag ${tag}`], { stdio: 'inherit' });
console.log(`Created tag: ${tag}`);
