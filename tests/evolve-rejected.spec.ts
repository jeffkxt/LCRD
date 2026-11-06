/**
 * The rejected-edit log: append-only records, bounded reads, malformed-line
 * tolerance, and the best-effort write that must never replace a rejection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendRejectedEdit,
  ensureStore,
  readRejectedEdits,
  rejectedEditsPath,
  storePaths,
} from '../src/evolve/store.ts'
import type { RejectedEdit } from '../src/evolve/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One rejection with the given version. */
function rejection(version: string): RejectedEdit {
  return {
    schemaVersion: 1,
    version,
    parent: 'v0001',
    ts: '2026-10-26T00:00:00.000Z',
    stage: 'gate-failed',
    reasons: ['reward gain 0.050 < required 0.100'],
    metrics: null,
  }
}

describe('rejected-edit log', () => {
  it('appends records and returns the newest within the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-rejected-'))
    dirs.push(dir)
    const paths = storePaths(join(dir, 'policy'))
    await ensureStore(paths)
    for (let index = 1; index <= 25; index += 1) await appendRejectedEdit(paths, rejection(`v${String(index)}`))
    expect((await readRejectedEdits(paths, 3)).map(edit => edit.version)).toEqual(['v25', 'v24', 'v23'])
    expect((await readRejectedEdits(paths, 0)).map(edit => edit.version)).toEqual([])
    expect(await readRejectedEdits(storePaths(join(dir, 'missing')))).toEqual([])
  })

  it('skips malformed lines and every shape a reader must not trust', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-rejected-bad-'))
    dirs.push(dir)
    const paths = storePaths(join(dir, 'policy'))
    mkdirSync(paths.root, { recursive: true })
    const invalid = [
      'not json',
      '1',
      'null',
      JSON.stringify({ ...rejection('v1'), schemaVersion: 2 }),
      JSON.stringify({ ...rejection('v1'), version: 1 }),
      JSON.stringify({ ...rejection('v1'), parent: 1 }),
      JSON.stringify({ ...rejection('v1'), ts: 1 }),
      JSON.stringify({ ...rejection('v1'), stage: 1 }),
      JSON.stringify({ ...rejection('v1'), stage: 'unknown' }),
      JSON.stringify({ ...rejection('v1'), reasons: 'nope' }),
      JSON.stringify({ ...rejection('v1'), reasons: [1] }),
    ]
    writeFileSync(rejectedEditsPath(paths), `${invalid.join('\n')}\n\n${JSON.stringify(rejection('v9'))}\n`)
    expect((await readRejectedEdits(paths, 10)).map(edit => edit.version)).toEqual(['v9'])
  })

  it('returns no records when the log limit is not positive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-rejected-zero-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'file'), 'x')
    expect(await readRejectedEdits(storePaths(join(dir, 'file')), -1)).toEqual([])
  })

  it('swallows a write failure so the original rejection still wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-rejected-fail-'))
    dirs.push(dir)
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    await expect(appendRejectedEdit(storePaths(blocker), rejection('v1'))).resolves.toBeUndefined()
  })
})
