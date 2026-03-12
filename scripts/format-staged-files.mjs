import { execFileSync } from 'node:child_process'

function getStagedFiles() {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    {
      encoding: 'utf8',
    }
  )

  return output
    .split('\0')
    .map((value) => value.trim())
    .filter(Boolean)
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

const stagedFiles = getStagedFiles()

if (stagedFiles.length === 0) {
  process.exit(0)
}

run('pnpm', [
  'exec',
  'biome',
  'format',
  '--write',
  '--files-ignore-unknown=true',
  '--no-errors-on-unmatched',
  ...stagedFiles,
])

run('git', ['add', '--', ...stagedFiles])
