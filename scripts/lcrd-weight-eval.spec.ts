/**
 * Weight-eval reporting: paired task deltas, runner-failure warnings, and the
 * empty-comparison guard. No model or runner process is started here.
 */
import { describe, expect, it } from 'vitest'
import { summarizeEval, type EvalSample } from './lcrd-weight-eval.ts'

/** One sample. */
function sample(taskId: string, side: 'base' | 'candidate', reward: number, runnerExit = 0): EvalSample {
  return { taskId, side, runnerExit, reward }
}

describe('weight eval report', () => {
  it('pairs task rewards and reports the candidate delta', () => {
    const report = summarizeEval(
      'bench',
      'base-runner',
      'candidate-runner',
      [sample('h-1', 'base', 0), sample('h-2', 'base', 1)],
      [sample('h-1', 'candidate', 1), sample('h-2', 'candidate', 1)],
    )
    expect(report).toMatchObject({
      schemaVersion: 1,
      pairedTasks: ['h-1', 'h-2'],
      base: { rewardRate: 0.5, runs: 2 },
      candidate: { rewardRate: 1, runs: 2 },
      meanDelta: 0.5,
    })
    expect(report.warnings).toEqual([])
  })

  it('warns on runner failures, unequal task sets, and an empty comparison', () => {
    const report = summarizeEval(
      'bench',
      'base',
      'candidate',
      [sample('h-1', 'base', 1, 1), sample('h-2', 'base', 0)],
      [sample('h-3', 'candidate', 1)],
    )
    expect(report.pairedTasks).toEqual([])
    expect(report.meanDelta).toBe(0)
    expect(report.warnings.join(' ')).toContain('runner failures')
    expect(report.warnings.join(' ')).toContain('no task was scored on both sides')
    expect(report.warnings.join(' ')).toContain('different numbers of tasks')
  })
})
