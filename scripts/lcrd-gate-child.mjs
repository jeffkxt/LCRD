/**
 * Gate-child launcher: boots the repository CLI from source through tsx's ESM
 * hook and forwards argv and the exit code.
 *
 * The gate spawns every child with `cwd` set to an isolated run workspace, so a
 * bare `dsh` (a pnpm script, not an executable) and a relative `--import
 * tsx/esm` both fail to resolve there. This wrapper resolves the tsx hook and
 * the CLI entry against its own location and re-execs Node with `--import`, so
 * the child starts from any working directory.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptsDir)

// `import.meta.resolve` resolves against this file, which lives in the
// repository that owns the checked-out tsx install, not against the cwd.
const tsxHook = import.meta.resolve('tsx/esm')
const cliEntry = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
// tsx resolves workspace imports through `tsconfig` `paths`; from a foreign cwd
// it would find no tsconfig and load built `lib/` outputs instead of `src/`.
const tsconfig = join(repoRoot, 'tsconfig.json')

const child = spawnSync(
  process.execPath,
  ['--import', tsxHook, cliEntry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig } },
)
process.exit(child.status ?? 1)
