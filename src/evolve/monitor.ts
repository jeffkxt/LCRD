/**
 * Online policy monitoring: fold every finished run into the active version's
 * score window and revert to the parent when the version's own behavior
 * degrades. The reference is the version's first full window of real runs, not
 * the gate's holdout metrics: online tasks and benchmark tasks are different
 * distributions, so a cross-suite comparison would be meaningless.
 *
 * @module lcrd-evolve-monitor
 */
import { aggregate } from './gate.ts'
import {
  appendScore,
  readQuarantine,
  readScore,
  rollback,
  setScoreBaseline,
  type StorePaths,
} from './store.ts'
import type { GateMetrics, GateSample, PolicyScore } from './types.ts'

/** Monitoring settings. */
export interface MonitorConfig {
  /** Runs observed before a verdict is possible. */
  window: number
  /** Allowed absolute regression in termination rate. */
  rollbackMargin: number
  /** Allowed absolute regression in speculative-cheat rate. */
  maxCheatRegression: number
}

/** The outcome of folding one run. */
export interface ObserveOutcome {
  /** Whether the version was reverted. */
  rolledBack: boolean
  /** The version reverted from, when it was. */
  from?: string
  /** The version restored, when it was. */
  to?: string
  /** Why the revert happened. */
  reason?: string
  /** The updated score window. */
  score: PolicyScore
}

/**
 * Judge one window against the version's own reference window.
 * @param metrics - the latest window's metrics.
 * @param baseline - the version's first full window.
 * @param config - the regression thresholds.
 * @returns the trigger reason, or null when the window is healthy.
 */
export function evaluateWindow(metrics: GateMetrics, baseline: GateMetrics, config: MonitorConfig): string | null {
  const cheatDelta = metrics.cheatRate - baseline.cheatRate
  if (cheatDelta > config.maxCheatRegression) {
    return `speculative-cheat rate ${metrics.cheatRate.toFixed(3)} exceeded its own baseline ${baseline.cheatRate.toFixed(3)} by more than ${config.maxCheatRegression.toFixed(3)}`
  }
  const terminationDelta = metrics.terminatedRate - baseline.terminatedRate
  if (terminationDelta > config.rollbackMargin) {
    return `termination rate ${metrics.terminatedRate.toFixed(3)} exceeded its own baseline ${baseline.terminatedRate.toFixed(3)} by more than ${config.rollbackMargin.toFixed(3)}`
  }
  return null
}

/**
 * Fold one finished run into the active version's score window and revert on
 * regression. The first full window becomes the reference; later windows are
 * compared against it. A version is reverted at most once.
 * @param paths - the store locations.
 * @param version - the version the run executed under.
 * @param sample - the run observation.
 * @param config - window size and regression thresholds.
 * @returns the fold outcome.
 */
export async function observeRun(
  paths: StorePaths,
  version: string,
  sample: GateSample,
  config: MonitorConfig,
): Promise<ObserveOutcome> {
  let score = await appendScore(paths, version, sample, config.window)
  if (score.window.length < config.window) return { rolledBack: false, score }
  if (score.baseline === null) {
    score = await setScoreBaseline(paths, version, aggregate(score.window))
    return { rolledBack: false, score }
  }
  const alreadyQuarantined = (await readQuarantine(paths)).some(entry => entry.version === version)
  if (alreadyQuarantined) return { rolledBack: false, score }
  const metrics = aggregate(score.window)
  const reason = evaluateWindow(metrics, score.baseline, config)
  if (reason === null) return { rolledBack: false, score }
  const reverted = await rollback(paths, reason, metrics, score.baseline)
  return { rolledBack: true, from: reverted.from, to: reverted.to, reason, score }
}

/**
 * Read one version's current score without folding anything.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the stored score.
 */
export async function readPolicyScore(paths: StorePaths, version: string): Promise<PolicyScore> {
  return readScore(paths, version)
}
