/**
 * Behaviour tests for the gate's gain report: paired rows, deterministic
 * bootstrap intervals, and the separation between "the gate passed" and "the
 * sample proves a gain".
 */
import { describe, expect, it } from 'vitest'
import { aggregate } from '../src/evolve/gate.ts'
import { bootstrapMeanCI, pairedDeltas, pairedRuns, renderGainReport } from '../src/evolve/report.ts'
import type { GateReport, GateSample, RelaxType } from '../src/evolve/types.ts'

const ZERO: Record<RelaxType, number> = { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 }

/** One sample with the given outcome. */
function sample(version: string, taskId: string, input: Partial<GateSample> = {}): GateSample {
  return {
    taskId,
    repeat: input.repeat ?? 1,
    version,
    recorded: input.recorded ?? true,
    reward: input.reward ?? null,
    termination: input.termination ?? 'completed',
    finalVerdict: input.finalVerdict ?? 'pass',
    relaxTypes: input.relaxTypes ?? ZERO,
    planCount: input.planCount ?? 1,
    tokens: input.tokens ?? 10,
    hookInterceptions: input.hookInterceptions ?? 0,
    pathViolations: input.pathViolations ?? 0,
  }
}

/** A report with five paired tasks by default. */
function report(input: {
  baselineRewards?: number[]
  candidateRewards?: number[]
  admission?: GateReport['admission']
  pass?: boolean
  outcome?: GateReport['outcome']
  samples?: GateSample[]
  baselineTermination?: GateSample['termination']
  candidateTermination?: GateSample['termination']
  detectability?: number | null
  minGain?: number
} = {}): GateReport {
  const baselineRewards = input.baselineRewards ?? [0, 0, 0, 0, 0]
  const candidateRewards = input.candidateRewards ?? [1, 1, 1, 1, 1]
  const baseline = baselineRewards.map((reward, index) => sample('v0001', `h-${String(index + 1)}`, {
    reward,
    termination: input.baselineTermination ?? 'completed',
  }))
  const candidate = candidateRewards.map((reward, index) => sample('v0002', `h-${String(index + 1)}`, {
    reward,
    termination: input.candidateTermination ?? 'completed',
  }))
  const samples = input.samples ?? [...baseline, ...candidate]
  return {
    schemaVersion: 1,
    gateId: 'gate-1',
    version: 'v0002',
    baselineVersion: 'v0001',
    createdAt: 't',
    benchmarkDigest: 'd',
    selectedTasks: baseline.map(entry => entry.taskId),
    repeats: 1,
    admission: input.admission ?? 'reward',
    baseline: aggregate(baseline),
    candidate: aggregate(candidate),
    pass: input.pass ?? true,
    outcome: input.outcome ?? ((input.pass ?? true) ? 'gated-passed' : 'gated-failed'),
    reasons: ['paired report'],
    minGain: input.minGain ?? 0.1,
    detectability: input.detectability ?? null,
    pairedN: 0,
    samples,
  }
}

describe('gain report', () => {
  it('marks a gate refused on its own noise floor as insufficient evidence', () => {
    const gain = renderGainReport(report({ pass: false, detectability: 0.4, minGain: 0.1 }))
    expect(gain.json.verdict).toBe('insufficient-evidence')
    expect(gain.markdown).toContain('Detectable gain: 0.400')
  })
  it('calls a positive, noise-free delta a gain', () => {
    const gain = renderGainReport(report())
    expect(gain.json).toMatchObject({ verdict: 'gain', pairedRuns: 5, meanDelta: 1, ciLow: 1, ciHigh: 1 })
    expect(gain.markdown).toContain('Verdict: GAIN')
    expect(gain.markdown).toContain('| h-1 | 1 | 0.000 | 1.000 |')
    expect(gain.markdown).toContain('| +1.000 |')
  })

  it('keeps a rejected gate at no-gain even when the metric is positive', () => {
    expect(renderGainReport(report({ pass: false })).json.verdict).toBe('no-gain')
  })

  it('renders a negative delta when the candidate regresses', () => {
    const rendered = renderGainReport(report({
      baselineRewards: [1, 1, 1, 1, 1],
      candidateRewards: [0, 0, 0, 0, 0],
      pass: false,
    }))
    expect(rendered.json).toMatchObject({ verdict: 'no-gain', meanDelta: -1, ciLow: -1, ciHigh: -1 })
    expect(rendered.markdown).toContain('-1.000')
  })

  it('calls a passed gate with a zero delta no-gain', () => {
    expect(renderGainReport(report({ candidateRewards: [0, 0, 0, 0, 0] })).json.verdict).toBe('no-gain')
  })

  it('refuses to claim a gain when the interval includes zero', () => {
    const rendered = renderGainReport(report({ candidateRewards: [1, 0, 1, 0, 0] }))
    expect(rendered.json.verdict).toBe('insufficient-evidence')
    expect(rendered.json.ciLow).toBeLessThanOrEqual(0)
    expect(rendered.markdown).toContain('cannot distinguish this change from noise')
  })

  it('excludes a pair whose reward is missing and stays insufficient when none remain', () => {
    const rendered = renderGainReport(report({ baselineRewards: [null as never, 0, 0, 0, 0] }))
    expect(rendered.json).toMatchObject({ verdict: 'gain', meanDelta: 1 })
    expect(rendered.markdown).toContain('| h-1 | 1 | — | 1.000 |')
    const candidateMissing = report({ candidateRewards: [null as never, 1, 1, 1, 1] })
    expect(pairedRuns(candidateMissing)[0]?.delta).toBeNull()
    const allMissing = renderGainReport(report({
      baselineRewards: [null as never, null as never, null as never, null as never, null as never],
      candidateRewards: [null as never, null as never, null as never, null as never, null as never],
    }))
    expect(allMissing.json.verdict).toBe('insufficient-evidence')
    expect(allMissing.json.meanDelta).toBe(0)
  })

  it('requires at least three paired rows', () => {
    const rendered = renderGainReport(report({ baselineRewards: [0, 0], candidateRewards: [1, 1] }))
    expect(rendered.json.verdict).toBe('insufficient-evidence')
  })

  it('uses run completion for self-report admission', () => {
    const rendered = renderGainReport(report({
      admission: 'self-report',
      baselineTermination: 'incomplete',
      candidateTermination: 'completed',
    }))
    expect(rendered.json).toMatchObject({ admission: 'self-report', verdict: 'gain', meanDelta: 1 })
  })

  it('pairs only rows that exist on both sides and is deterministic per seed', () => {
    const base = report()
    const withExtras = report({
      samples: [
        ...base.samples,
        sample('v0002', 'h-9', { reward: 1 }),
        sample('v0001', 'h-8', { reward: 0 }),
      ],
    })
    expect(pairedRuns(withExtras).map(row => row.taskId)).toEqual(['h-1', 'h-2', 'h-3', 'h-4', 'h-5'])
    const first = renderGainReport(withExtras, { seed: 'fixed', iterations: 200, alpha: 0.1 })
    const second = renderGainReport(withExtras, { seed: 'fixed', iterations: 200, alpha: 0.1 })
    expect(first.json.ciLow).toBe(second.json.ciLow)
    expect(first.json.alpha).toBe(0.1)
    expect(first.json.iterations).toBe(200)
  })

  it('drops pairs whose admission metric is unavailable', () => {
    const candidateMissing = report({ candidateRewards: [null as never, 1, 1, 1, 1] })
    expect(pairedDeltas(pairedRuns(candidateMissing))).toEqual([1, 1, 1, 1])
    expect(pairedDeltas([])).toEqual([])
  })

  it('bootstraps a known vector around its mean', () => {
    const interval = bootstrapMeanCI([1, 2, 3], 'seed', 100, 0.05)
    expect(interval.mean).toBe(2)
    expect(interval.low).toBeLessThanOrEqual(interval.mean)
    expect(interval.high).toBeGreaterThanOrEqual(interval.mean)
  })
})
