/**
 * Noise-floor statistics: deterministic quantiles, percentiles, and the
 * normal-approximation minimum detectable gain used by `lcrd:policy noise`.
 */
import { describe, expect, it } from 'vitest'
import {
  mean,
  minDetectableGain,
  normalQuantile,
  percentile,
  renderNoiseReport,
  requiredPairs,
  sampleSd,
  summarizeNoise,
} from '../src/evolve/significance.ts'

describe('noise statistics', () => {
  it('computes means, sample deviations, and nearest-rank percentiles', () => {
    expect(mean([])).toBe(0)
    expect(mean([2, 4])).toBe(3)
    expect(sampleSd([1])).toBe(0)
    expect(sampleSd([1, 1, 1])).toBe(0)
    expect(sampleSd([1, 3])).toBeCloseTo(Math.SQRT2, 10)
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5], 2)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5], -1)).toBe(1)
  })

  it('approximates normal quantiles across the three approximation regions', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5)
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 5)
    expect(normalQuantile(0.0005)).toBeCloseTo(-3.290527, 5)
    expect(() => normalQuantile(0)).toThrow('0 < p < 1')
    expect(() => normalQuantile(1)).toThrow('0 < p < 1')
  })

  it('computes the minimum detectable gain and the required run count', () => {
    expect(minDetectableGain(0.5, 4)).toBeCloseTo(0.489991, 5)
    expect(minDetectableGain(1, 1, 0.1)).toBeCloseTo(1.644854, 5)
    expect(minDetectableGain(0.5, 0)).toBe(Infinity)
    expect(() => minDetectableGain(0.5, 4, 0)).toThrow('alpha')
    expect(requiredPairs(0.5, 0.1)).toBe(97)
    expect(requiredPairs(0.5, 0)).toBe(Infinity)
    expect(requiredPairs(0, 0.1)).toBe(0)
    expect(() => requiredPairs(0.5, 0.1, 1)).toThrow('alpha')
  })

  it('summarizes rounds and marks auto promotion safe only when the floor allows it', () => {
    const summary = summarizeNoise([0, 1, 1], 10, 0.1)
    expect(summary).toMatchObject({ schemaVersion: 1, rounds: 3, runsPerRound: 10, targetGain: 0.1, safeForAuto: false })
    expect(summary.mean).toBeCloseTo(2 / 3, 10)
    expect(summary.sd).toBeCloseTo(Math.sqrt(1 / 3), 10)
    expect(summary.p5).toBe(0)
    expect(summary.p95).toBe(1)
    expect(summary.bernoulliSd).toBeCloseTo(Math.sqrt(2) / 3, 10)
    expect(summary.minDetectableGain).toBeCloseTo(0.35784, 4)
    expect(summary.requiredPairs).toBeGreaterThan(0)
    expect(() => summarizeNoise([], 10, 0.1)).toThrow('at least one round')
    expect(summarizeNoise([2], 10, 0.1).bernoulliSd).toBe(0)
    expect(summarizeNoise([0.3, 0.7], 10, 0.1).safeForAuto).toBe(false)
    expect(summarizeNoise([0.5], 100_000, 0.5).safeForAuto).toBe(false)
    expect(summarizeNoise([0.5, 0.5], 100_000, 0.5).safeForAuto).toBe(true)
  })

  it('renders a table and an explicit warning for the unsafe case', () => {
    const unsafe = renderNoiseReport(summarizeNoise([0.3, 0.7], 10, 0.1))
    expect(unsafe.markdown).toContain('| rounds | runs/round | mean | sd | p5 | p95 | min detectable gain | required n |')
    expect(unsafe.markdown).toContain('minDetectableGain(n)')
    expect(unsafe.markdown).toContain('keep `promote: approval`')
    expect(unsafe.json).toEqual(summarizeNoise([0.3, 0.7], 10, 0.1))
    const safe = renderNoiseReport(summarizeNoise([0.5, 0.5], 100_000, 0.5))
    expect(safe.markdown).toContain('`promote: auto` is defensible')
    const oneRound = renderNoiseReport(summarizeNoise([0.5], 100_000, 0.5))
    expect(oneRound.markdown).toContain('At least two rounds')
    const infinite = renderNoiseReport(summarizeNoise([0.5, 0.5], 10, 0))
    expect(infinite.markdown).toContain('Infinity')
  })

  it('marks a saturated suite and refuses auto promotion', () => {
    const saturated = summarizeNoise([1, 1, 1], 5, 0.1)
    expect(saturated).toMatchObject({ saturated: true, sd: 0, safeForAuto: false })
    expect(renderNoiseReport(saturated).markdown).toContain('no discriminating power')
    // A deterministic but non-extreme rate is noise-free, not saturated.
    const precise = summarizeNoise([0.5, 0.5], 100_000, 0.5)
    expect(precise).toMatchObject({ saturated: false, safeForAuto: true })
  })

  it('judges the gate floor on per-run spread, not on averaged round means', () => {
    // Round means look stable, but every round mixes perfect and imperfect runs;
    // a gate pairs two independent runs, so its deltas carry that spread.
    const runs = [1, 1, 1, 1, 0, 0, 1, 1, 1, 1]
    const summary = summarizeNoise([0.9, 0.9, 0.9], 10, 0.1, 0.05, runs)
    expect(summary.minDetectableGain).toBeLessThan(0.1)
    expect(summary.runSd).toBeGreaterThan(0.4)
    expect(summary.pairedDetectability).toBeGreaterThan(0.1)
    // The optimistic round-mean reading must not license auto promotion.
    expect(summary.safeForAuto).toBe(false)
    // The warning names the reading that refused it, not the round-mean one.
    expect(renderNoiseReport(summary).markdown).toContain('The gate floor is 0.')
    expect(renderNoiseReport(summary).markdown).toContain('round means alone read')
    // Without per-run data the summary falls back to the round means.
    expect(summarizeNoise([0.9, 0.9, 0.9], 10, 0.1).pairedDetectability).toBeNull()
  })
})
