// Legacy compatibility shim.
// Source of truth is now TypeScript in src/, compiled to dist/.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const distServerPath = path.join(projectRoot, 'dist', 'server.js');

if (!existsSync(distServerPath)) {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (build.status !== 0 || !existsSync(distServerPath)) {
    process.exit(build.status ?? 1);
  }
}

await import('./dist/server.js');
