/**
 * Noise-floor statistics for the LCRD gate. These functions describe an
 * observed reward-rate distribution; they never decide a gate on their own.
 * `minDetectableGain` is the normal-approximation half-width for the mean of
 * `pairs` independent runs, not a guarantee for a paired or stratified design.
 *
 * @module lcrd-evolve-significance
 */

/** Report vocabulary version. */
export const NOISE_SCHEMA_VERSION = 1

/**
 * Arithmetic mean.
 * @param values - the observations.
 * @returns the mean, or 0 when the list is empty.
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Sample standard deviation (denominator `n - 1`).
 * @param values - the observations.
 * @returns the deviation, or 0 when fewer than two observations exist.
 */
export function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0
  const average = mean(values)
  const sum = values.reduce((total, value) => total + (value - average) ** 2, 0)
  return Math.sqrt(sum / (values.length - 1))
}

/**
 * Nearest-rank percentile over a copy of the observations.
 * @param values - the observations.
 * @param p - fraction in `[0, 1]`; values outside are clamped.
 * @returns the selected observation, or 0 when the list is empty.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const clamped = Math.min(1, Math.max(0, p))
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1))
  return sorted[index] as number
}

/**
 * Inverse standard-normal CDF (Acklam's rational approximation).
 * @param p - probability in `(0, 1)`.
 * @returns the quantile.
 * @throws when `p` is outside `(0, 1)`.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('lcrd significance: normalQuantile requires 0 < p < 1')
  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00,
  ]
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01,
  ]
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00,
  ]
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00,
  ]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  const polynomial = (coefficients: readonly number[], q: number): number => {
    let value = coefficients[0] as number
    for (let index = 1; index < coefficients.length; index += 1) {
      value = value * q + (coefficients[index] as number)
    }
    return value
  }
  const tailDenominator = (q: number): number => polynomial([...d, 1], q)
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return polynomial(c, q) / tailDenominator(q)
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return polynomial(a, r) * q / polynomial([...b, 1], r)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -polynomial(c, q) / tailDenominator(q)
}

/** Two-sided normal quantile for an error rate. */
function zForAlpha(alpha: number): number {
  if (!(alpha > 0 && alpha < 1)) throw new Error('lcrd significance: alpha must be in (0, 1)')
  return normalQuantile(1 - alpha / 2)
}

/**
 * Smallest mean gain distinguishable from zero at the configured alpha.
 * @param sd - observed round-level standard deviation.
 * @param pairs - runs contributing to one gate-side mean.
 * @param alpha - two-sided error rate.
 * @returns the half-width, or `Infinity` when `pairs <= 0`.
 */
export function minDetectableGain(sd: number, pairs: number, alpha = 0.05): number {
  if (pairs <= 0) return Infinity
  return zForAlpha(alpha) * sd / Math.sqrt(pairs)
}

/**
 * Runs needed for the half-width to reach `targetGain`.
 * @param sd - observed round-level standard deviation.
 * @param targetGain - desired detectable gain.
 * @param alpha - two-sided error rate.
 * @returns the required run count, or `Infinity` for a non-positive target.
 */
export function requiredPairs(sd: number, targetGain: number, alpha = 0.05): number {
  if (targetGain <= 0) return Infinity
  const z = zForAlpha(alpha)
  return Math.ceil((z * sd / targetGain) ** 2)
}

/** One noise-floor measurement. */
export interface NoiseSummary {
  /** Report vocabulary version. */
  schemaVersion: 1
  /** Completed rounds. */
  rounds: number
  /** Child runs per round (tasks x repeats). */
  runsPerRound: number
  /** Two-sided error rate used for the normal approximation. */
  alpha: number
  /** Gain the deployment wants to detect (`evolveMinGain`). */
  targetGain: number
  /** Mean reward rate over rounds. */
  mean: number
  /** Sample standard deviation over rounds. */
  sd: number
  /** Nearest-rank fifth percentile. */
  p5: number
  /** Nearest-rank ninety-fifth percentile. */
  p95: number
  /**
   * Whether every round scored the same extreme (0 or 1). The zero variance then
   * means the suite cannot separate runs, not that the measurement is precise:
   * a larger sample never fixes it, harder tasks do.
   */
  saturated: boolean
  /** Theoretical standard deviation of a Bernoulli reward at `mean`. */
  bernoulliSd: number
  /** Normal-approximation half-width for one round's runs. */
  minDetectableGain: number
  /** Runs needed to detect `targetGain` at this variance. */
  requiredPairs: number
  /** Whether `promote: auto` is defensible at this sample size. */
  safeForAuto: boolean
  /**
   * Standard deviation of the individual run rewards, which is what a gate's
   * paired deltas are built from. Null when the caller supplied only round means.
   */
  runSd: number | null
  /**
   * Detectable gain predicted for one real gate draw: `1.96 * sqrt(2) * runSd / sqrt(runsPerRound)`.
   * The `roundSd`-based {@link NoiseSummary.minDetectableGain} averages runs inside a
   * round and therefore understates the paired variance the gate actually sees.
   * Null when the caller supplied only round means.
   */
  pairedDetectability: number | null
}

/**
 * Summarize one noise run.
 * @param rates - reward rate per round.
 * @param runsPerRound - runs contributing to each round.
 * @param targetGain - gain the deployment wants to detect.
 * @param alpha - two-sided error rate.
 * @param runRewards - per-run rewards, when the caller has run-level samples.
 * @returns the summary.
 * @throws when no round was observed.
 */
export function summarizeNoise(
  rates: readonly number[],
  runsPerRound: number,
  targetGain: number,
  alpha = 0.05,
  runRewards?: readonly number[],
): NoiseSummary {
  if (rates.length === 0) throw new Error('lcrd noise: at least one round is required')
  const average = mean(rates)
  const sd = sampleSd(rates)
  const detectable = minDetectableGain(sd, runsPerRound, alpha)
  const saturated = sd === 0 && (average === 0 || average === 1)
  // A gate compares two independent runs of the same task, so a paired delta has
  // twice the variance of one run. Judging `safeForAuto` on the round-mean sd
  // would call a sample precise when it only averaged the noise away.
  const runSd = runRewards === undefined || runRewards.length < 2 ? null : sampleSd(runRewards)
  const pairedDetectability = runSd === null
    ? null
    : 1.96 * Math.SQRT2 * runSd / Math.sqrt(runsPerRound)
  return {
    schemaVersion: NOISE_SCHEMA_VERSION,
    rounds: rates.length,
    runsPerRound,
    alpha,
    targetGain,
    mean: average,
    sd,
    p5: percentile(rates, 0.05),
    p95: percentile(rates, 0.95),
    saturated,
    bernoulliSd: average >= 0 && average <= 1 ? Math.sqrt(average * (1 - average)) : 0,
    minDetectableGain: detectable,
    requiredPairs: requiredPairs(sd, targetGain, alpha),
    runSd,
    pairedDetectability,
    safeForAuto: rates.length >= 2
      && detectable <= targetGain
      && !saturated
      && (pairedDetectability === null || pairedDetectability <= targetGain),
  }
}

/**
 * Render a noise summary as Markdown plus its structured form.
 * @param summary - the measured noise floor.
 * @returns the Markdown page and JSON value.
 */
export function renderNoiseReport(summary: NoiseSummary): { json: NoiseSummary; markdown: string } {
  const fixed = (value: number): string => Number.isFinite(value) ? value.toFixed(3) : 'Infinity'
  // `safeForAuto` can be refused by the paired floor while the round-mean floor
  // sits below the target, so the warning must name the reading that decided.
  const effective = summary.pairedDetectability ?? summary.minDetectableGain
  const neededPairs = summary.runSd === null
    ? summary.requiredPairs
    : Math.ceil((1.96 * Math.SQRT2 * summary.runSd / summary.targetGain) ** 2)
  const warning = summary.rounds < 2
    ? 'At least two rounds are required before treating the noise floor as evidence.'
    : summary.saturated
      ? 'Every round scored the same extreme, so this suite has no discriminating power: a larger sample cannot help, the tasks must be harder.'
      : summary.safeForAuto
        ? `The detectable gain is at most the ${fixed(summary.targetGain)} target; \`promote: auto\` is defensible at this sample size.`
        : `The gate floor is ${fixed(effective)} against the ${fixed(summary.targetGain)} target`
          + ` (round means alone read ${fixed(summary.minDetectableGain)}); keep \`promote: approval\` until one gate draws at least ${String(neededPairs)} paired runs.`
  const markdown = [
    '# LCRD noise floor',
    '',
    '| rounds | runs/round | mean | sd | p5 | p95 | min detectable gain | required n |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${String(summary.rounds)} | ${String(summary.runsPerRound)} | ${fixed(summary.mean)} | ${fixed(summary.sd)} | ${fixed(summary.p5)} | ${fixed(summary.p95)} | ${fixed(summary.minDetectableGain)} | ${fixed(summary.requiredPairs)} |`,
    '',
    `Formula: \`minDetectableGain(n) = ${fixed(zForAlpha(summary.alpha))} * sd / sqrt(n)\` with \`n = holdoutSize * repeats\`; alpha ${fixed(summary.alpha)}.`,
    '',
    warning,
    '',
  ].join('\n')
  return { json: summary, markdown }
}
