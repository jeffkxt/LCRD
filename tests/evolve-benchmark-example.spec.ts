/**
 * The example benchmark is runnable under the isolated-workspace contract:
 * every task copies its fixture, the reward script lives inside the fixture,
 * and answering writes only inside the run workspace.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWorkspace, runReward } from '../src/evolve/gate.ts'
import { loadBenchmark } from '../src/evolve/holdout.ts'

const example = resolve(import.meta.dirname, '../benchmarks/example')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('example benchmark', () => {
  it('loads ten holdout tasks and one sealed task, each with a fixture and a reward command', async () => {
    const benchmark = await loadBenchmark(example)
    expect(benchmark.holdout).toHaveLength(10)
    expect(benchmark.hardout).toHaveLength(1)
    expect(benchmark.holdout.every(task => task.fixture === 'fixtures/task')).toBe(true)
    expect(benchmark.holdout.every(task => task.reward?.startsWith('node reward.mjs') === true)).toBe(true)
    expect(benchmark.hardout[0]?.fixture).toBe('fixtures/task')
  })

  it('names only fixture-local source files in every anchor', async () => {
    const benchmark = await loadBenchmark(example)
    const fixture = join(example, 'fixtures', 'task')
    for (const task of [...benchmark.train, ...benchmark.holdout, ...benchmark.hardout]) {
      const references = [...task.anchor.matchAll(/source\/[A-Za-z0-9._/-]+/g)].map(match => match[0])
      expect(references.length, `${task.id} names a source file`).toBeGreaterThan(0)
      for (const reference of references) expect(existsSync(join(fixture, reference)), `${task.id} -> ${reference}`).toBe(true)
    }
  })

  it('scores answers inside the copied workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lcrd-bench-workspace-'))
    dirs.push(workspace)
    await prepareWorkspace(workspace, { id: 'h-01', anchor: 'a', suite: 'holdout', fixture: 'fixtures/task' }, example)
    expect(existsSync(join(workspace, 'source', 'index.ts'))).toBe(true)
    expect(existsSync(join(workspace, 'answers'))).toBe(true)
    expect(existsSync(join(workspace, 'reward.mjs'))).toBe(true)
    const reward = `node "${join(workspace, 'reward.mjs')}" h-01`
    expect(await runReward(reward, workspace, 10_000)).toBe(0)
    writeFileSync(join(workspace, 'answers', 'h-01.txt'), '@deepseek-ai/dsh-experimental-lcrd\n')
    expect(await runReward(reward, workspace, 10_000)).toBe(1)
    writeFileSync(join(workspace, 'answers', 'h-01.txt'), 'wrong\n')
    expect(await runReward(reward, workspace, 10_000)).toBe(0)
    expect(readFileSync(join(workspace, 'answers', 'h-01.txt'), 'utf8')).toBe('wrong\n')
    expect(existsSync(join(example, 'fixtures', 'task', 'answers', 'h-01.txt'))).toBe(false)
  })
})
