/**
 * Dataset audit: corpus counts, DPO shape, trainability, group sizes, and
 * benchmark leakage. Pure fixture tests; no model or GPU.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DATASET_FILES } from '../packages/experimental/lcrd/src/dataset.ts'
import { auditDataset, renderAudit } from './lcrd-dataset-audit.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One dataset row with the fields the audit reads. */
function datasetRow(taskId: string, group: string, trainability: string): string {
  return JSON.stringify({ run_id: `run-${taskId}`, session_id: 'session-1', task_id: taskId, task_group: group, trainability })
}

/** A corpus with two groups, one DPO pair, and one malformed line. */
function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-audit-'))
  dirs.push(dir)
  writeFileSync(join(dir, DATASET_FILES.dataset), [
    datasetRow('h-1', 'group-a', 'trainable'),
    datasetRow('h-2', 'group-b', 'needs-review'),
    'not json',
    '',
  ].join('\n'))
  writeFileSync(join(dir, DATASET_FILES.trainable), `${datasetRow('h-1', 'group-a', 'trainable')}\n`)
  writeFileSync(join(dir, DATASET_FILES.needsReview), `${datasetRow('h-2', 'group-b', 'needs-review')}\n`)
  writeFileSync(join(dir, DATASET_FILES.runs), `${JSON.stringify({ run_id: 'run-h-1', task_group: 'group-a' })}\n`)
  writeFileSync(join(dir, DATASET_FILES.dpo), `${JSON.stringify({
    prompt: 'p',
    chosen: 'good',
    rejected: 'bad',
    meta: { synthetic: true },
  })}\n`)
  return dir
}

describe('lcrd dataset audit', () => {
  it('counts rows, trainability, DPO shape, groups, and malformed lines', async () => {
    const dir = corpus()
    const audit = await auditDataset(dir)
    expect(audit.counts).toMatchObject({
      dataset: 2,
      trainable: 1,
      needsReview: 1,
      runs: 1,
      dpoPairs: 1,
      uniqueTaskIds: 2,
      uniqueTaskGroups: 2,
    })
    expect(audit.files.dataset).toMatchObject({ exists: true, lines: 3, invalid: 1 })
    expect(audit.trainability).toEqual({ trainable: 1, 'needs-review': 1 })
    expect(audit.dpo).toMatchObject({ pairs: 1, uniquePrompts: 1, synthetic: 1 })
    expect(audit.groups).toEqual({ 'group-a': 1, 'group-b': 1 })
    expect(audit.warnings.join(' ')).toContain('every DPO pair is synthetic')
    expect(renderAudit(audit)).toContain('| dataset | 2 |')
  })

  it('reports missing files and benchmark leakage', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lcrd-audit-empty-'))
    dirs.push(empty)
    const missing = await auditDataset(empty)
    expect(Object.values(missing.files).every(file => !file.exists)).toBe(true)
    expect(missing.warnings.join(' ')).toContain('missing corpus file')

    const dir = corpus()
    const bench = mkdtempSync(join(tmpdir(), 'lcrd-audit-bench-'))
    dirs.push(bench)
    mkdirSync(join(bench, 'holdout'))
    writeFileSync(join(bench, 'train.jsonl'), '')
    writeFileSync(join(bench, 'holdout', 'pool.jsonl'), `${JSON.stringify({ id: 'h-1', anchor: 'a' })}\n`)
    const leaked = await auditDataset(dir, bench)
    expect(leaked.leakage).toEqual({ benchmarkTasks: 1, overlappingTaskIds: ['h-1'] })
    expect(leaked.warnings.join(' ')).toContain('overlaps benchmark')
  })
})
