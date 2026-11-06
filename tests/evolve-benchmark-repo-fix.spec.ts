/**
 * The repo-fix benchmark family: every task must carry a fixture the agent
 * edits and a reward command that executes the edited code. The score starts
 * below 1 (the bug is real) and reaches 1 once the module is fixed.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runReward } from '../src/evolve/gate.ts'
import { loadBenchmark } from '../src/evolve/holdout.ts'

const root = join(import.meta.dirname, '..', 'benchmarks', 'repo-fix')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Copy one task fixture into a fresh workspace and grade it. */
async function grade(benchmarkDir: string, fixture: string, reward: string | undefined): Promise<number | null> {
  const workspace = mkdtempSync(join(tmpdir(), 'lcrd-repo-fix-'))
  dirs.push(workspace)
  cpSync(join(benchmarkDir, fixture), workspace, { recursive: true })
  return await runReward(reward as string, workspace, 30_000)
}

describe('repo-fix benchmark', () => {
  it('ships five holdout tasks and one sealed task, each gradeable by command', async () => {
    const benchmark = await loadBenchmark(root)
    expect(benchmark.holdout).toHaveLength(5)
    expect(benchmark.hardout).toHaveLength(1)
    for (const task of [...benchmark.holdout, ...benchmark.hardout]) {
      expect(task.fixture, `${task.id} must name a fixture`).toBeTruthy()
      expect(task.reward, `${task.id} must carry a reward command`).toBe('node reward.mjs')
    }
  })

  it('scores every fixture below 1 before the fix and 1 after it', async () => {
    const benchmark = await loadBenchmark(root)
    for (const task of benchmark.holdout) {
      const before = await grade(root, task.fixture as string, task.reward)
      // A task that already passes grades nothing: the bug must be real.
      expect(before, `${task.id} should fail before the fix`).toBeLessThan(1)
      expect(before, `${task.id} should score a fraction`).toBeGreaterThanOrEqual(0)
    }

    // Fix one task by hand and confirm the reward reads the edited module.
    const workspace = mkdtempSync(join(tmpdir(), 'lcrd-repo-fix-fixed-'))
    dirs.push(workspace)
    cpSync(join(root, 'fixtures', 'clamp-bounds'), workspace, { recursive: true })
    writeFileSync(join(workspace, 'source', 'clamp.js'), `export function clamp(value, min, max) {
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  if (Number.isNaN(value)) return low
  if (value < low) return low
  if (value > high) return high
  return value
}
`, 'utf8')
    expect(await runReward('node reward.mjs', workspace, 30_000)).toBe(1)
  })

  it('reads the task anchors from the three tiers', async () => {
    const benchmark = await loadBenchmark(root)
    for (const task of [...benchmark.holdout, ...benchmark.hardout]) {
      expect(task.anchor.length).toBeGreaterThan(40)
    }
    const train = readFileSync(join(root, 'train.jsonl'), 'utf8').trim().split('\n')
    expect(train).toHaveLength(5)
  })
})
