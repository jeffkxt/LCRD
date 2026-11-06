/**
 * Runner-agnostic weight-evaluation base. It compares two command runners (for
 * example a base model and a LoRA adapter) on the same holdout tasks, giving
 * each task a fresh fixture copy and scoring it with the task's reward command.
 * It does not train, load model weights, or fabricate an endpoint: the operator
 * supplies a runner that reads the prompt and writes task artifacts.
 *
 * Runner contract:
 *   cwd       the isolated workspace (already containing the task fixture)
 *   env       LCRD_EVAL_PROMPT, LCRD_EVAL_TASK_ID, LCRD_EVAL_SIDE
 *   exit 0    runner completed; the reward command then scores the workspace
 *
 * Usage:
 *   pnpm run lcrd:weight-eval -- \
 *     --benchmark packages/experimental/lcrd/benchmarks/repo-fix \
 *     --base-runner "node ./runners/base.mjs" \
 *     --candidate-runner "node ./runners/checkpoint.mjs"
 *
 * @module lcrd-weight-eval
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadBenchmark,
  prepareWorkspace,
  runReward,
  type BenchmarkTask,
} from '@deepseek-ai/dsh-experimental-lcrd'

/** One scored run. */
export interface EvalSample {
  /** Task id. */
  taskId: string
  /** Which runner produced it. */
  side: 'base' | 'candidate'
  /** Runner exit code; -1 means spawn failure or timeout. */
  runnerExit: number
  /** Ground-truth reward after the runner finished. */
  reward: number
}

/** One side's evaluation summary. */
export interface EvalSide {
  /** Runner command, recorded verbatim for audit. */
  runner: string
  /** Mean reward over recorded runs. */
  rewardRate: number
  /** Runs that produced a reward. */
  runs: number
  /** Runner exits other than 0. */
  runnerFailures: number
}

/** One base-vs-candidate evaluation report. */
export interface WeightEvalReport {
  /** Report vocabulary version. */
  schemaVersion: 1
  /** Benchmark root used for the run. */
  benchmarkDir: string
  /** ISO-8601 instant. */
  createdAt: string
  /** Base runner summary. */
  base: EvalSide
  /** Candidate runner summary. */
  candidate: EvalSide
  /** Task ids paired on both sides. */
  pairedTasks: string[]
  /** Candidate minus base reward rate on the paired tasks. */
  meanDelta: number
  /** Every scored run. */
  samples: EvalSample[]
  /** Non-fatal issues worth reading before trusting the comparison. */
  warnings: string[]
}

/** Spawn one runner in the isolated workspace and return its exit code. */
function runRunner(command: string, workspace: string, task: BenchmarkTask, side: 'base' | 'candidate', timeoutMs: number): Promise<number> {
  return new Promise((resolveCode) => {
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      resolveCode(code)
    }
    const child = spawn(command, {
      shell: true,
      cwd: workspace,
      env: {
        ...process.env,
        LCRD_EVAL_PROMPT: task.anchor,
        LCRD_EVAL_TASK_ID: task.id,
        LCRD_EVAL_SIDE: side,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(-1)
    }, timeoutMs)
    child.on('error', () => { finish(-1) })
    child.on('close', (code) => {
      clearTimeout(timer)
      /* v8 ignore next -- a signal-only exit reports a null code */
      finish(code ?? -1)
    })
  })
}

/**
 * Run one side over the selected tasks.
 * @param side - which runner this is.
 * @param runner - shell command implementing the runner contract.
 * @param tasks - tasks to run.
 * @param benchmarkDir - benchmark root holding each fixture.
 * @param timeoutMs - per-run timeout.
 * @returns the scored samples.
 */
export async function evaluateSide(
  side: 'base' | 'candidate',
  runner: string,
  tasks: readonly BenchmarkTask[],
  benchmarkDir: string,
  timeoutMs: number,
): Promise<EvalSample[]> {
  const samples: EvalSample[] = []
  for (const task of tasks) {
    if (task.reward === undefined) throw new Error(`lcrd weight eval: task ${task.id} has no reward command`)
    const root = mkdtempSync(join(tmpdir(), 'lcrd-weight-eval-'))
    try {
      const workspace = join(root, 'workspace')
      await prepareWorkspace(workspace, task, benchmarkDir)
      const runnerExit = await runRunner(runner, workspace, task, side, timeoutMs)
      const reward = await runReward(task.reward, workspace, timeoutMs)
      samples.push({ taskId: task.id, side, runnerExit, reward })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  return samples
}

/** Summarize one side's samples. */
function summarizeSide(runner: string, samples: readonly EvalSample[]): EvalSide {
  return {
    runner,
    rewardRate: samples.length === 0 ? 0 : samples.reduce((sum, sample) => sum + sample.reward, 0) / samples.length,
    runs: samples.length,
    runnerFailures: samples.filter(sample => sample.runnerExit !== 0).length,
  }
}

/**
 * Build the comparison report from both sides' samples.
 * @param benchmarkDir - the benchmark root.
 * @param baseRunner - base runner command.
 * @param candidateRunner - candidate runner command.
 * @param baseSamples - base runs.
 * @param candidateSamples - candidate runs.
 * @returns the report.
 */
export function summarizeEval(
  benchmarkDir: string,
  baseRunner: string,
  candidateRunner: string,
  baseSamples: readonly EvalSample[],
  candidateSamples: readonly EvalSample[],
): WeightEvalReport {
  const base = summarizeSide(baseRunner, baseSamples)
  const candidate = summarizeSide(candidateRunner, candidateSamples)
  const baseByTask = new Map(baseSamples.map(sample => [sample.taskId, sample.reward]))
  const candidateByTask = new Map(candidateSamples.map(sample => [sample.taskId, sample.reward]))
  const pairedTasks = [...baseByTask.keys()].filter(taskId => candidateByTask.has(taskId)).sort()
  const meanDelta = pairedTasks.length === 0
    ? 0
    : pairedTasks.reduce((sum, taskId) => {
      const baseReward = baseByTask.get(taskId) ?? 0
      const candidateReward = candidateByTask.get(taskId) ?? 0
      return sum + candidateReward - baseReward
    }, 0) / pairedTasks.length
  const warnings: string[] = []
  if (pairedTasks.length === 0) warnings.push('no task was scored on both sides; the comparison is empty')
  if (base.runnerFailures > 0 || candidate.runnerFailures > 0) {
    warnings.push(`runner failures: base ${String(base.runnerFailures)}, candidate ${String(candidate.runnerFailures)}`)
  }
  if (baseSamples.length !== candidateSamples.length) warnings.push('the two sides ran different numbers of tasks')
  return {
    schemaVersion: 1,
    benchmarkDir: resolve(benchmarkDir),
    createdAt: new Date().toISOString(),
    base,
    candidate,
    pairedTasks,
    meanDelta,
    samples: [...baseSamples, ...candidateSamples],
    warnings,
  }
}

/** Read one `--name value` argument. */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Read a positive number argument. */
function numberArg(name: string, fallback: number): number {
  const raw = argOf(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`lcrd:weight-eval ${name} requires a positive number`)
  return value
}

/** CLI entry. */
async function main(): Promise<void> {
  const benchmarkDir = argOf('--benchmark')
  const baseRunner = argOf('--base-runner')
  const candidateRunner = argOf('--candidate-runner')
  if (benchmarkDir === undefined) throw new Error('lcrd:weight-eval requires --benchmark <dir>')
  if (baseRunner === undefined) throw new Error('lcrd:weight-eval requires --base-runner <command>')
  if (candidateRunner === undefined) throw new Error('lcrd:weight-eval requires --candidate-runner <command>')
  const benchmark = await loadBenchmark(benchmarkDir)
  const limit = numberArg('--tasks', benchmark.holdout.length)
  const tasks = [...benchmark.holdout].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit)
  if (tasks.length === 0) throw new Error('lcrd:weight-eval requires at least one holdout task')
  const timeoutMs = numberArg('--timeout', 900_000)
  const baseSamples = await evaluateSide('base', baseRunner, tasks, benchmarkDir, timeoutMs)
  const candidateSamples = await evaluateSide('candidate', candidateRunner, tasks, benchmarkDir, timeoutMs)
  const report = summarizeEval(benchmarkDir, baseRunner, candidateRunner, baseSamples, candidateSamples)
  const json = `${JSON.stringify(report, null, 2)}\n`
  const out = argOf('--out')
  if (out !== undefined) writeFileSync(out, json, 'utf8')
  console.log(json)
  if (report.warnings.length > 0) process.exitCode = 1
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) await main()
