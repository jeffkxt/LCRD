/**
 * Checkpoint registry: immutable manifests, evaluation evidence, promotion, and
 * rollback. Uses a temporary root; no model or GPU is involved.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listCheckpoints, promoteCheckpoint, registerCheckpoint, rollbackCheckpoint } from './lcrd-checkpoint.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One valid evaluation report. */
function evalReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    benchmarkDir: 'bench',
    base: { runner: 'base', rewardRate: 0.4, runs: 2 },
    candidate: { runner: 'candidate', rewardRate: 0.7, runs: 2 },
    pairedTasks: ['h-1', 'h-2'],
    meanDelta: 0.3,
  }
}

/** A temp registry root plus an evaluation file. */
function fixture(): { root: string; evalPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-checkpoint-'))
  dirs.push(dir)
  const evalPath = join(dir, 'eval.json')
  writeFileSync(evalPath, JSON.stringify(evalReport()))
  return { root: join(dir, 'checkpoints'), evalPath }
}

describe('checkpoint registry', () => {
  it('registers, lists, promotes, and rolls back a parent chain', () => {
    const { root, evalPath } = fixture()
    const first = registerCheckpoint({ root, id: 'base-lora', baseModel: 'base', adapterPath: 'a1', evalPath })
    expect(first).toMatchObject({ id: 'base-lora', parent: null })
    expect(listCheckpoints(root)).toEqual([{ id: 'base-lora', baseModel: 'base', parent: null, current: false }])
    expect(promoteCheckpoint(root, 'base-lora')).toMatchObject({ id: 'base-lora', previous: null })

    const second = registerCheckpoint({ root, id: 'second', baseModel: 'base', adapterPath: 'a2', evalPath })
    expect(second.parent).toBe('base-lora')
    promoteCheckpoint(root, 'second')
    expect(listCheckpoints(root).map(entry => [entry.id, entry.current])).toEqual([['base-lora', false], ['second', true]])
    expect(rollbackCheckpoint(root)).toMatchObject({ id: 'base-lora', previous: 'second' })
  })

  it('rejects duplicate ids, invalid evals, bad ids, and missing parents', () => {
    const { root, evalPath } = fixture()
    registerCheckpoint({ root, id: 'first', baseModel: 'base', adapterPath: 'a', evalPath })
    expect(() => registerCheckpoint({ root, id: 'first', baseModel: 'base', adapterPath: 'a', evalPath })).toThrow('already exists')
    expect(() => registerCheckpoint({ root, id: 'Bad ID', baseModel: 'base', adapterPath: 'a', evalPath })).toThrow('checkpoint id')
    expect(() => registerCheckpoint({ root, id: 'missing', baseModel: 'base', adapterPath: 'a', evalPath, parent: 'nope' })).toThrow('not registered')
    const bad = join(root, 'bad.json')
    writeFileSync(bad, JSON.stringify({ ...evalReport(), pairedTasks: [] }))
    expect(() => registerCheckpoint({ root, id: 'bad', baseModel: 'base', adapterPath: 'a', evalPath: bad })).toThrow('pairedTasks')
  })

  it('refuses a rollback without a current checkpoint or parent', () => {
    const { root, evalPath } = fixture()
    expect(() => rollbackCheckpoint(root)).toThrow('no current')
    registerCheckpoint({ root, id: 'only', baseModel: 'base', adapterPath: 'a', evalPath })
    promoteCheckpoint(root, 'only')
    expect(() => rollbackCheckpoint(root)).toThrow('has no parent')
  })
})
