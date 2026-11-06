/**
 * Three-tier benchmark loading, deterministic rotating selection, cooldown,
 * and digests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestBenchmark, loadBenchmark, recentlyUsed, rotationKey, selectHoldout } from '../src/evolve/holdout.ts'
import type { BenchmarkSpec, HoldoutHistory } from '../src/evolve/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Build one benchmark root with the given tiers. */
function makeBenchmark(input: {
  train?: unknown[]
  holdout?: Record<string, unknown[]>
  hardout?: Record<string, unknown[]>
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-bench-'))
  dirs.push(dir)
  const lines = (rows: unknown[]): string => rows.map(row => `${JSON.stringify(row)}\n`).join('')
  writeFileSync(join(dir, 'train.jsonl'), lines(input.train ?? [{ id: 'train-1', anchor: 'a' }]))
  for (const [name, rows] of Object.entries(input.holdout ?? { pool: [{ id: 'h-1', anchor: 'a' }, { id: 'h-2', anchor: 'a' }, { id: 'h-3', anchor: 'a' }] })) {
    mkdirSync(join(dir, 'holdout'), { recursive: true })
    writeFileSync(join(dir, 'holdout', `${name}.jsonl`), lines(rows))
  }
  for (const [name, rows] of Object.entries(input.hardout ?? { sealed: [{ id: 's-1', anchor: 'a' }] })) {
    mkdirSync(join(dir, 'hardout'), { recursive: true })
    writeFileSync(join(dir, 'hardout', `${name}.jsonl`), lines(rows))
  }
  return dir
}

describe('benchmark loading', () => {
  it('loads all three tiers with a stable digest', async () => {
    const dir = makeBenchmark({})
    const first = await loadBenchmark(dir)
    expect(first.train.map(task => task.id)).toEqual(['train-1'])
    expect(first.holdout.map(task => task.id)).toEqual(['h-1', 'h-2', 'h-3'])
    expect(first.hardout.map(task => task.id)).toEqual(['s-1'])
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await digestBenchmark(dir)).toBe(first.digest)
    writeFileSync(join(dir, 'train.jsonl'), `${JSON.stringify({ id: 'train-2', anchor: 'b' })}\n`)
    expect(await digestBenchmark(dir)).not.toBe(first.digest)
  })

  it('tolerates absent optional directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-bench-min-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'train.jsonl'), '')
    const spec = await loadBenchmark(dir)
    expect(spec.holdout).toEqual([])
    expect(spec.hardout).toEqual([])
  })

  it('rejects malformed files, tasks, repeats, duplicates, and a missing root', async () => {
    await expect(loadBenchmark(join(tmpdir(), 'lcrd-bench-missing'))).rejects.toThrow('does not exist')
    const badJson = mkdtempSync(join(tmpdir(), 'lcrd-bench-json-'))
    dirs.push(badJson)
    writeFileSync(join(badJson, 'train.jsonl'), '{not json}\n')
    await expect(loadBenchmark(badJson)).rejects.toThrow('not valid JSON')
    const badId = makeBenchmark({ train: [{ anchor: 'a' }] })
    await expect(loadBenchmark(badId)).rejects.toThrow('non-empty string id')
    const badAnchor = makeBenchmark({ train: [{ id: 't', anchor: ' ' }] })
    await expect(loadBenchmark(badAnchor)).rejects.toThrow('non-empty anchor')
    const badRepeats = makeBenchmark({ train: [{ id: 't', anchor: 'a', repeats: 0 }] })
    await expect(loadBenchmark(badRepeats)).rejects.toThrow('repeats must be an integer')
    const dupes = makeBenchmark({ train: [{ id: 'same', anchor: 'a' }], holdout: { pool: [{ id: 'same', anchor: 'b' }] } })
    await expect(loadBenchmark(dupes)).rejects.toThrow('duplicate task id')
    const repeats = makeBenchmark({ train: [{ id: 't', anchor: 'a', repeats: 2 }] })
    expect((await loadBenchmark(repeats)).train[0]?.repeats).toBe(2)
  })
})

describe('holdout rotation', () => {
  const spec: BenchmarkSpec = {
    digest: 'd',
    train: [],
    holdout: Array.from({ length: 5 }, (_, index) => ({ id: `h-${String(index)}`, anchor: 'a', suite: 'holdout' as const })),
    hardout: [],
  }

  it('ranks deterministically and is independent of input order', () => {
    expect(rotationKey('seed', 'h-1')).toBe(rotationKey('seed', 'h-1'))
    expect(rotationKey('seed', 'h-1')).not.toBe(rotationKey('other', 'h-1'))
    const first = selectHoldout(spec, { selections: [] }, 3, 3, 'seed')
    const reversed = selectHoldout({ ...spec, holdout: [...spec.holdout].reverse() }, { selections: [] }, 3, 3, 'seed')
    expect(first.map(task => task.id)).toEqual(reversed.map(task => task.id))
  })

  it('excludes tasks used in the cooldown window and reports them', () => {
    const history: HoldoutHistory = {
      selections: [
        { gateId: 'g1', ts: 't1', ids: ['h-0'] },
        { gateId: 'g2', ts: 't2', ids: ['h-1'] },
        { gateId: 'g3', ts: 't3', ids: ['h-2'] },
      ],
    }
    expect([...recentlyUsed(history, 1)].sort()).toEqual(['h-2'])
    expect([...recentlyUsed(history, 3)].sort()).toEqual(['h-0', 'h-1', 'h-2'])
    expect([...recentlyUsed(history, 0)]).toEqual([])
    const selected = selectHoldout(spec, history, 2, 3, 'seed')
    expect(selected.map(task => task.id).sort()).toEqual(['h-3', 'h-4'])
  })

  it('fails loud when the eligible pool is too small', () => {
    const history: HoldoutHistory = {
      selections: [{ gateId: 'g', ts: 't', ids: ['h-0', 'h-1', 'h-2'] }],
    }
    expect(() => selectHoldout(spec, history, 3, 3, 'seed')).toThrow('holdout pool exhausted')
  })
})

describe('benchmark fixtures', () => {
  it('digests fixture contents, including nested files', async () => {
    const dir = makeBenchmark({ holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: 'fixtures/one' }] } })
    mkdirSync(join(dir, 'fixtures', 'one', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'fixtures', 'one', 'seed.txt'), 'seed\n')
    writeFileSync(join(dir, 'fixtures', 'one', 'nested', 'note.txt'), 'note\n')
    const before = await digestBenchmark(dir)
    expect((await loadBenchmark(dir)).holdout[0]?.fixture).toBe('fixtures/one')
    writeFileSync(join(dir, 'fixtures', 'one', 'nested', 'note.txt'), 'changed\n')
    expect(await digestBenchmark(dir)).not.toBe(before)
  })

  it('digests a missing fixture as an empty contribution', async () => {
    const dir = makeBenchmark({ holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: 'fixtures/missing' }] } })
    expect(await digestBenchmark(dir)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects malformed, escaping, missing, and non-directory fixtures', async () => {
    await expect(loadBenchmark(makeBenchmark({
      holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: 7 }] },
    }))).rejects.toThrow('fixture must be a non-empty directory name')
    await expect(loadBenchmark(makeBenchmark({
      holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: '../outside' }] },
    }))).rejects.toThrow('must stay inside the benchmark root')
    await expect(loadBenchmark(makeBenchmark({
      holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: 'fixtures/none' }] },
    }))).rejects.toThrow('is not a directory')
    const file = makeBenchmark({ holdout: { pool: [{ id: 'h-1', anchor: 'a', fixture: 'fixtures/one' }] } })
    mkdirSync(join(file, 'fixtures'), { recursive: true })
    writeFileSync(join(file, 'fixtures', 'one'), 'not a directory')
    await expect(loadBenchmark(file)).rejects.toThrow('is not a directory')
  })
})
