import { execFileSync } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

const HOOKS = {
  "pre-commit": "npm run format:staged",
  "pre-push": "npm run format:branch:check",
};

function resolveGitHooksDir() {
  return execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    encoding: "utf8",
  }).trim();
}

async function installHook(name, command) {
  const hooksDir = resolveGitHooksDir();
  await mkdir(hooksDir, { recursive: true });

  const script = `#!/bin/sh
${command}
`;

  const hookPath = path.join(hooksDir, name);
  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
}

for (const [name, command] of Object.entries(HOOKS)) {
  await installHook(name, command);
}

console.log("Installed git hooks:", Object.keys(HOOKS).join(", "));
