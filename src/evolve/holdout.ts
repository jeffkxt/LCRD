/**
 * The three-tier benchmark: `train` tasks the model may read while proposing,
 * a `holdout` pool the gate draws a rotating subset from, and a sealed
 * `hardout` suite the daily gate never reads. Selection is deterministic for a
 * given seed and rotation history, so a gate report can be replayed.
 *
 * @module lcrd-evolve-holdout
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, isAbsolute, normalize, sep } from 'node:path'
import type { BenchmarkSpec, BenchmarkTask, HoldoutHistory } from './types.ts'

/** Suite file layout under the benchmark root. */
export const BENCHMARK_LAYOUT = {
  /** The single readable-by-the-model proposal corpus. */
  train: 'train.jsonl',
  /** Directory of gate-only pools; every `*.jsonl` file is read. */
  holdout: 'holdout',
  /** Directory of sealed audit pools; every `*.jsonl` file is read. */
  hardout: 'hardout',
} as const

/**
 * Parse one JSONL task file.
 * @param file - the file path.
 * @param suite - the tier every task in the file belongs to.
 * @returns the parsed tasks.
 * @throws when a line is not a usable task.
 */
async function readTaskFile(file: string, suite: BenchmarkTask['suite']): Promise<BenchmarkTask[]> {
  const text = await readFile(file, 'utf8')
  const tasks: BenchmarkTask[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    /* v8 ignore next -- split never yields an out-of-range index here */
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) continue
    let parsed: { id?: unknown; anchor?: unknown; repeats?: unknown; reward?: unknown; fixture?: unknown }
    try {
      parsed = JSON.parse(line) as { id?: unknown; anchor?: unknown; repeats?: unknown; reward?: unknown; fixture?: unknown }
    } catch {
      throw new Error(`lcrd benchmark: ${file}:${index + 1} is not valid JSON`)
    }
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new Error(`lcrd benchmark: ${file}:${index + 1} needs a non-empty string id`)
    }
    if (typeof parsed.anchor !== 'string' || parsed.anchor.trim().length === 0) {
      throw new Error(`lcrd benchmark: task ${parsed.id} needs a non-empty anchor`)
    }
    const repeats = parsed.repeats
    if (repeats !== undefined && (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1)) {
      throw new Error(`lcrd benchmark: task ${parsed.id} repeats must be an integer >= 1`)
    }
    const reward = parsed.reward
    if (reward !== undefined && (typeof reward !== 'string' || reward.trim().length === 0)) {
      throw new Error(`lcrd benchmark: task ${parsed.id} reward must be a non-empty command string`)
    }
    const fixture = parsed.fixture
    if (fixture !== undefined) {
      if (typeof fixture !== 'string' || fixture.trim().length === 0) {
        throw new Error(`lcrd benchmark: task ${parsed.id} fixture must be a non-empty directory name`)
      }
      const normalized = normalize(fixture)
      if (isAbsolute(fixture) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
        throw new Error(`lcrd benchmark: task ${parsed.id} fixture must stay inside the benchmark root`)
      }
    }
    tasks.push({
      id: parsed.id,
      anchor: parsed.anchor,
      suite,
      ...(typeof repeats === 'number' ? { repeats } : {}),
      ...(typeof reward === 'string' ? { reward } : {}),
      ...(typeof fixture === 'string' ? { fixture } : {}),
    })
  }
  return tasks
}

/**
 * Read every `*.jsonl` file in one suite directory, in sorted name order.
 * @param dir - the suite directory.
 * @param suite - the tier those tasks belong to.
 * @returns the tasks; empty when the directory is absent.
 */
async function readSuiteDir(dir: string, suite: BenchmarkTask['suite']): Promise<BenchmarkTask[]> {
  if (!existsSync(dir)) return []
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => entry.name)
    .sort()
  const tasks: BenchmarkTask[] = []
  for (const name of names) tasks.push(...await readTaskFile(join(dir, name), suite))
  return tasks
}

/**
 * Read all three tiers of one benchmark root.
 * @param dir - the benchmark root.
 * @returns the three task arrays.
 */
async function readSuites(dir: string): Promise<{
  train: BenchmarkTask[]
  holdout: BenchmarkTask[]
  hardout: BenchmarkTask[]
}> {
  const train = await readTaskFile(join(dir, BENCHMARK_LAYOUT.train), 'train')
  const holdout = await readSuiteDir(join(dir, BENCHMARK_LAYOUT.holdout), 'holdout')
  const hardout = await readSuiteDir(join(dir, BENCHMARK_LAYOUT.hardout), 'hardout')
  return { train, holdout, hardout }
}

/**
 * Load the three-tier benchmark and digest its contents, so an edit during a
 * gate invalidates that gate instead of mixing two corpora.
 * @param dir - the benchmark root.
 * @returns the loaded spec with a SHA-256 digest.
 * @throws when a suite file is unreadable, a task is malformed, or an id repeats.
 */
export async function loadBenchmark(dir: string): Promise<BenchmarkSpec> {
  if (!existsSync(dir)) throw new Error(`lcrd benchmark: ${dir} does not exist`)
  const { train, holdout, hardout } = await readSuites(dir)
  const ids = new Set<string>()
  for (const task of [...train, ...holdout, ...hardout]) {
    if (ids.has(task.id)) throw new Error(`lcrd benchmark: duplicate task id ${JSON.stringify(task.id)}`)
    ids.add(task.id)
    if (task.fixture !== undefined) {
      const fixture = join(dir, task.fixture)
      if (!existsSync(fixture) || !statSync(fixture).isDirectory()) {
        throw new Error(`lcrd benchmark: task ${task.id} fixture ${JSON.stringify(task.fixture)} is not a directory under the benchmark root`)
      }
    }
  }
  return { digest: await digestBenchmark(dir), train, holdout, hardout }
}

/**
 * Digest every benchmark file under a root, sorted by relative path. Task
 * fixture directories are digested too, so editing a fixture mid-gate voids the
 * run exactly like editing a task file.
 * @param dir - the benchmark root.
 * @returns the SHA-256 hex digest.
 */
export async function digestBenchmark(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const files: string[] = []
  const trainPath = join(dir, BENCHMARK_LAYOUT.train)
  if (existsSync(trainPath)) files.push(BENCHMARK_LAYOUT.train)
  for (const suiteDir of [BENCHMARK_LAYOUT.holdout, BENCHMARK_LAYOUT.hardout]) {
    const full = join(dir, suiteDir)
    if (!existsSync(full)) continue
    for (const entry of await readdir(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(`${suiteDir}/${entry.name}`)
    }
  }
  /* v8 ignore next 2 -- a missing train file is rejected by loadBenchmark before any digest */
  const suites = existsSync(trainPath) ? await readSuites(dir) : { train: [], holdout: [], hardout: [] }
  for (const task of [...suites.train, ...suites.holdout, ...suites.hardout]) {
    if (task.fixture === undefined) continue
    for (const file of await listFiles(join(dir, task.fixture))) files.push(`${task.fixture}/${file}`)
  }
  files.sort()
  for (const file of files) {
    hash.update(file)
    hash.update('\u0000')
    hash.update(await readFile(join(dir, file), 'utf8'))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/**
 * List every file under one directory, as `/`-joined paths relative to it.
 * @param root - the directory to walk.
 * @returns the relative file paths; empty when the directory is absent.
 */
async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), relative)
        continue
      }
      /* v8 ignore else -- fixtures contain regular files and directories; platform special files are outside the contract */
      if (entry.isFile()) found.push(relative)
    }
  }
  await walk(root, '')
  return found
}

/**
 * Task ids used in the most recent `cooldown` gate selections.
 * @param history - the rotation history.
 * @param cooldown - how many recent gates stay ineligible.
 * @returns the excluded task ids.
 */
export function recentlyUsed(history: HoldoutHistory, cooldown: number): Set<string> {
  const used = new Set<string>()
  const recent = history.selections.slice(Math.max(0, history.selections.length - cooldown))
  for (const selection of recent) for (const id of selection.ids) used.add(id)
  return used
}

/**
 * Deterministic rank of one task under one seed.
 * @param seed - the gate's selection seed.
 * @param id - the task id.
 * @returns the hex digest used as the sort key.
 */
export function rotationKey(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}\u0000${id}`).digest('hex')
}

/**
 * Draw the gate's holdout subset: tasks outside the cooldown window, ranked by
 * a seed-derived digest so the draw is reproducible but not predictable from
 * the task ids alone.
 * @param spec - the loaded benchmark.
 * @param history - the rotation history.
 * @param size - how many tasks to draw.
 * @param cooldown - how many recent gates stay ineligible.
 * @param seed - the gate's selection seed.
 * @returns the drawn tasks.
 * @throws when the eligible pool is smaller than `size`.
 */
export function selectHoldout(
  spec: BenchmarkSpec,
  history: HoldoutHistory,
  size: number,
  cooldown: number,
  seed: string,
): BenchmarkTask[] {
  const excluded = recentlyUsed(history, cooldown)
  const eligible = spec.holdout.filter(task => !excluded.has(task.id))
  if (eligible.length < size) {
    throw new Error(`lcrd benchmark: holdout pool exhausted (need ${size}, eligible ${eligible.length} of ${spec.holdout.length})`)
  }
  return eligible
    .map(task => ({ task, key: rotationKey(seed, task.id) }))
    .sort((left, right) => {
      if (left.key < right.key) return -1
      /* v8 ignore else -- hash-collision tie-break */
      if (left.key > right.key) return 1
      /* v8 ignore next -- equal keys are a hash collision; not constructible */
      return left.task.id.localeCompare(right.task.id)
    })
    .slice(0, size)
    .map(entry => entry.task)
}
