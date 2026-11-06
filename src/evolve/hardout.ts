/**
 * Sealed hard-out audit: after every configured number of promotions, run the
 * current policy and its parent against the same sealed tasks, so the
 * comparison holds the task distribution fixed. A regression sets the
 * promotion hold, which blocks later promotions until an operator clears it.
 * The sealed suite never feeds the daily gate.
 *
 * @module lcrd-evolve-hardout
 */
import { aggregate, runTasks, type GateConfig, type GateLauncher } from './gate.ts'
import { normalizeGateId, writeGateArtifact, type StorePaths } from './store.ts'
import type { BenchmarkSpec, GateMetrics, GateReport } from './types.ts'

/** Input for one sealed audit. */
export interface HardoutAuditInput {
  /** Store locations. */
  paths: StorePaths
  /** Gate-shaped configuration: repeats, budgets, policy root, and base config. */
  config: Pick<
    GateConfig,
    'repeats' | 'runMaxTokens' | 'maxTokens' | 'maxWallMs' | 'admission' | 'maxTokenRegression' | 'benchmarkDir' | 'rewardTimeoutMs' | 'policyDir' | 'baseConfig'
  >
  /** The version under audit. */
  version: string
  /** The version it is compared against. */
  baselineVersion: string
  /** The loaded benchmark; only the sealed suite runs. */
  benchmark: BenchmarkSpec
  /** The launcher port. */
  launch: GateLauncher
}

/** The audit outcome. */
export interface HardoutAudit {
  /** Whether the sealed suite held. */
  pass: boolean
  /** Why it did or did not hold. */
  reasons: string[]
  /** The sealed-suite metrics for the audited version. */
  metrics: GateMetrics
  /** The sealed-suite metrics for its parent on the same tasks. */
  baseline: GateMetrics
}

/**
 * Run both versions on the sealed suite and compare them like for like. The
 * audit checks regressions only: hard-out is a safety net, not a second gate.
 * @param input - store, config, versions, benchmark, and launcher.
 * @returns the audit outcome; an empty sealed suite passes vacuously.
 */
export async function auditHardout(input: HardoutAuditInput): Promise<HardoutAudit> {
  const { paths, config, version, baselineVersion, benchmark, launch } = input
  const empty: GateMetrics = {
    passRate: 0, rewardRate: null, terminatedRate: 0, cheatRate: 0,
    hookInterceptions: 0, pathViolations: 0, tokens: 0, runs: 0,
  }
  if (benchmark.hardout.length === 0) {
    return { pass: true, reasons: ['no sealed tasks configured'], metrics: empty, baseline: empty }
  }
  const gateId = normalizeGateId(`hardout-${Date.now().toString(36)}`)
  const budget = { spent: 0, startedAt: Date.now(), aborted: false }
  const baselineSamples = await runTasks('hardout-baseline', gateId, baselineVersion, benchmark.hardout, config, paths, version, launch, budget)
  const samples = await runTasks('hardout-candidate', gateId, version, benchmark.hardout, config, paths, version, launch, budget)
  const baseline = aggregate(baselineSamples)
  const metrics = aggregate(samples)
  const reasons: string[] = []
  if (budget.aborted) reasons.push(`token budget exhausted after ${String(budget.spent)} tokens`)
  if (!baselineSamples.some(sample => sample.recorded) || !samples.some(sample => sample.recorded)) {
    reasons.push('sealed run produced no run.json; check the gate profile and policy root')
  }
  if (metrics.cheatRate > baseline.cheatRate) {
    reasons.push(`sealed-suite cheat rate ${metrics.cheatRate.toFixed(3)} > baseline ${baseline.cheatRate.toFixed(3)}`)
  }
  if (metrics.terminatedRate > baseline.terminatedRate) {
    reasons.push(`sealed-suite termination rate ${metrics.terminatedRate.toFixed(3)} > baseline ${baseline.terminatedRate.toFixed(3)}`)
  }
  if (metrics.hookInterceptions > baseline.hookInterceptions) {
    reasons.push(`sealed-suite hook interceptions ${String(metrics.hookInterceptions)} > baseline ${String(baseline.hookInterceptions)}`)
  }
  if (metrics.pathViolations > baseline.pathViolations) {
    reasons.push(`sealed-suite path violations ${String(metrics.pathViolations)} > baseline ${String(baseline.pathViolations)}`)
  }
  const pass = reasons.length === 0
  const report: GateReport = {
    schemaVersion: 1,
    gateId,
    version,
    baselineVersion,
    createdAt: new Date().toISOString(),
    benchmarkDigest: benchmark.digest,
    selectedTasks: benchmark.hardout.map(task => task.id),
    repeats: config.repeats,
    admission: config.admission,
    baseline,
    candidate: metrics,
    pass,
    outcome: pass ? 'gated-passed' : 'gated-failed',
    reasons: pass ? ['sealed suite held against its parent'] : reasons,
    // A sealed audit compares fixed metrics against the parent; it carries no
    // admission threshold, so neither detectability nor its paired count apply.
    minGain: 0,
    detectability: null,
    pairedN: 0,
    samples: [...baselineSamples, ...samples],
  }
  await writeGateArtifact(paths, version, gateId, 'report.json', `${JSON.stringify(report, null, 2)}\n`)
  return { pass, reasons: report.reasons, metrics, baseline }
}
