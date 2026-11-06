/**
 * Operator tooling for the LCRD policy store: offline promotion of a
 * gated version, rollback, sealed hard-out audit, promotion-hold release, and
 * inspection. Repository development tooling; the npm package exposes the same
 * operations through the plugin's exported store API.
 *
 * Usage:
 *   pnpm run lcrd:policy -- show
 *   pnpm run lcrd:policy -- promote v0002
 *   pnpm run lcrd:policy -- rollback
 *   pnpm run lcrd:policy -- audit-hardout --benchmark ./benchmark
 *   pnpm run lcrd:policy -- clear-hold
 *   pnpm run lcrd:policy -- noise --benchmark ./benchmark --rounds 10
 *
 * @module lcrd-policy
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditHardout,
  createGateLauncher,
  ensureStore,
  loadBenchmark,
  mean,
  policyNoticeText,
  promote,
  readManifest,
  readPointer,
  readQuarantine,
  renderNoiseReport,
  rollback,
  runTasks,
  setPromotionHeld,
  storePaths,
  summarizeNoise,
} from '@deepseek-ai/dsh-experimental-lcrd'

/** The default policy root, matching the plugin's `<logDir 父目录>/policy`. */
const DEFAULT_POLICY_DIR = 'packages/experimental/lcrd/policy'

/** Read one `--name value` argument. */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Read a positive numeric argument. */
function numberArg(name: string, fallback: number): number {
  const raw = argOf(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`lcrd:policy ${name} requires a positive number`)
  return value
}

/** Read a positive integer argument. */
function integerArg(name: string, fallback: number): number {
  const value = numberArg(name, fallback)
  if (!Number.isInteger(value)) throw new Error(`lcrd:policy ${name} requires an integer`)
  return value
}

/** Read the deployment base config from a JSON file. */
function baseConfigOf(path: string | undefined): Record<string, unknown> {
  if (path === undefined) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('lcrd:policy --base-config requires a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Print the store's current state.
 * @param policyDir - the policy root.
 */
async function show(policyDir: string): Promise<void> {
  const paths = storePaths(policyDir)
  const pointer = await ensureStore(paths)
  const manifest = await readManifest(paths, pointer.version)
  const quarantine = await readQuarantine(paths)
  console.log(JSON.stringify({ pointer, manifest, quarantine }, null, 2))
}

/**
 * Promote one gated version as the operator.
 * @param policyDir - the policy root.
 * @param version - the version to promote.
 */
async function promoteOffline(policyDir: string, version: string): Promise<void> {
  const paths = storePaths(policyDir)
  const pointer = await readPointer(paths)
  const result = await promote(paths, version, pointer.revision, 'operator', null)
  console.log(`${policyNoticeText('promoted', pointer.version, result.version, 'manual')}\nRevision: ${String(result.revision)}`)
}

/**
 * Revert the current version to its parent.
 * @param policyDir - the policy root.
 * @param reason - the operator's reason.
 */
async function rollbackOffline(policyDir: string, reason: string): Promise<void> {
  const paths = storePaths(policyDir)
  const result = await rollback(paths, reason, null, null)
  console.log(`${policyNoticeText('rolled-back', result.from, result.to, reason)}\nRevision: ${String(result.pointer.revision)}`)
}

/**
 * Run the sealed audit and set the promotion hold when it regresses.
 * @param policyDir - the policy root.
 * @param benchmarkDir - the benchmark root.
 * @param profile - the harness profile gate children boot.
 * @param command - the command that starts the harness.
 */
async function audit(policyDir: string, benchmarkDir: string, profile: string, command: string): Promise<void> {
  const paths = storePaths(policyDir)
  const pointer = await readPointer(paths)
  const manifest = await readManifest(paths, pointer.version)
  if (manifest.parent === null) throw new Error('lcrd:policy audit-hardout requires a non-bootstrap current version')
  const benchmark = await loadBenchmark(benchmarkDir)
  const launcher = createGateLauncher({ command, profile, timeoutMs: 900_000 })
  const result = await auditHardout({
    paths,
    config: {
      repeats: 1,
      runMaxTokens: 200_000,
      maxTokens: 2_000_000,
      maxWallMs: 900_000,
      admission: 'self-report',
      maxTokenRegression: 0.2,
      rewardTimeoutMs: 900_000,
      policyDir: paths.root,
      baseConfig: {},
      benchmarkDir,
    },
    version: pointer.version,
    baselineVersion: manifest.parent,
    benchmark,
    launch: launcher,
  })
  if (!result.pass) await setPromotionHeld(paths, true)
  console.log(JSON.stringify({ ...result, promotionHeld: !result.pass }, null, 2))
}

/**
 * Measure the current policy's reward-rate noise floor.
 * @param policyDir - the policy root.
 * @param benchmarkDir - the benchmark root.
 */
/** JSON array of leading arguments for the gate child command, e.g. `--gate-args '["D:/repo/scripts/lcrd-gate-child.mjs"]'`. */
function gateArgs(): string[] {
  const raw = argOf('--gate-args')
  if (raw === undefined) return []
  const trimmed = raw.trim()
  const parsed: unknown = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(/\s+/).filter(part => part.length > 0)
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error('lcrd:policy --gate-args must be a JSON array of strings')
  }
  return parsed
}

async function noise(policyDir: string, benchmarkDir: string): Promise<void> {
  const paths = storePaths(policyDir)
  const pointer = await readPointer(paths)
  const benchmark = await loadBenchmark(benchmarkDir)
  const taskLimit = integerArg('--tasks', benchmark.holdout.length)
  const tasks = [...benchmark.holdout].sort((left, right) => left.id.localeCompare(right.id)).slice(0, taskLimit)
  if (tasks.length === 0) throw new Error('lcrd:policy noise requires at least one holdout task')
  const missing = tasks.filter(task => task.reward === undefined).map(task => task.id)
  if (missing.length > 0) throw new Error(`lcrd:policy noise requires a reward command on ${missing.join(', ')}`)
  const rounds = integerArg('--rounds', 10)
  const repeats = integerArg('--repeats', 3)
  const timeout = numberArg('--timeout', 900_000)
  const targetGain = numberArg('--min-gain', 0.1)
  const alpha = numberArg('--alpha', 0.05)
  const launcher = createGateLauncher({
    command: argOf('--command') ?? 'dsh',
    args: gateArgs(),
    profile: argOf('--profile') ?? 'lcrd-gate',
    timeoutMs: timeout,
  })
  const runMaxTokens = numberArg('--run-max-tokens', 200_000)
  const config = {
    repeats,
    runMaxTokens,
    maxTokens: numberArg('--max-tokens', runMaxTokens * tasks.length * repeats),
    maxWallMs: numberArg('--max-wall-ms', timeout * tasks.length * repeats),
    policyDir: paths.root,
    baseConfig: baseConfigOf(argOf('--base-config')),
    benchmarkDir,
    rewardTimeoutMs: timeout,
  }
  const keepArtifacts = argOf('--keep-artifacts')
  const rates: number[] = []
  const runRewards: number[] = []
  for (let round = 1; round <= rounds; round += 1) {
    const artifactRoot = mkdtempSync(join(keepArtifacts ?? tmpdir(), 'lcrd-noise-'))
    try {
      const budget = { spent: 0, startedAt: Date.now(), aborted: false }
      const samples = await runTasks(
        'noise',
        `noise-${String(round)}`,
        pointer.version,
        tasks,
        config,
        storePaths(artifactRoot),
        pointer.version,
        launcher,
        budget,
      )
      if (budget.aborted) throw new Error(`lcrd:policy noise round ${String(round)} hit its budget`)
      const rewards = samples.map(sample => sample.reward)
      if (rewards.some(reward => reward === null)) {
        throw new Error(`lcrd:policy noise round ${String(round)} produced a run without a reward`)
      }
      rates.push(mean(rewards as number[]))
      runRewards.push(...(rewards as number[]))
    } finally {
      if (keepArtifacts === undefined) rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  const report = renderNoiseReport(summarizeNoise(rates, tasks.length * repeats, targetGain, alpha, runRewards))
  console.log(JSON.stringify(report.json, null, 2))
  console.log(report.markdown)
  const markdownPath = argOf('--markdown')
  if (markdownPath !== undefined) writeFileSync(markdownPath, report.markdown, 'utf8')
}

/** Parse and run one operator command. */
async function main(): Promise<void> {
  const policyDir = argOf('--policy') ?? DEFAULT_POLICY_DIR
  const command = process.argv[2] ?? 'show'
  switch (command) {
    case 'show':
      await show(policyDir)
      return
    case 'promote': {
      const version = process.argv[3]
      if (version === undefined) throw new Error('lcrd:policy promote requires a version')
      await promoteOffline(policyDir, version)
      return
    }
    case 'rollback':
      await rollbackOffline(policyDir, argOf('--reason') ?? 'operator rollback')
      return
    case 'audit-hardout': {
      const benchmarkDir = argOf('--benchmark')
      if (benchmarkDir === undefined) throw new Error('lcrd:policy audit-hardout requires --benchmark <dir>')
      await audit(policyDir, benchmarkDir, argOf('--profile') ?? 'headless', argOf('--command') ?? 'dsh')
      return
    }
    case 'clear-hold': {
      const pointer = await setPromotionHeld(storePaths(policyDir), false)
      console.log(`promotion hold cleared at revision ${String(pointer.revision)}`)
      return
    }
    case 'noise': {
      const benchmarkDir = argOf('--benchmark')
      if (benchmarkDir === undefined) throw new Error('lcrd:policy noise requires --benchmark <dir>')
      await noise(policyDir, benchmarkDir)
      return
    }
    default:
      throw new Error(`unknown command ${command}; expected show|promote|rollback|audit-hardout|clear-hold|noise`)
  }
}

await main()
