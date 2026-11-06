/**
 * Gain report for one gate: pair every baseline row with the candidate row for
 * the same task and repeat, compute the paired admission delta, and report a
 * seeded bootstrap confidence interval plus an explicit verdict. A gate can
 * admit on a point estimate that a small sample cannot distinguish from noise,
 * so "passed" and "proved a gain" are deliberately separate outcomes.
 *
 * @module lcrd-evolve-report
 */
import type { GateReport, GateSample } from './types.ts'

/** Paired rows required before the report can say anything about the mean. */
const MIN_PAIRED_ROWS = 3
/** Default bootstrap resamples. */
const DEFAULT_ITERATIONS = 2_000
/** Default two-sided error rate. */
const DEFAULT_ALPHA = 0.05

/** One baseline/candidate pair for the same task and repeat. */
export interface PairedRun {
  /** Task identity. */
  taskId: string
  /** Repeat index within the task. */
  repeat: number
  /** The baseline sample. */
  baseline: GateSample
  /** The candidate sample. */
  candidate: GateSample
  /** Baseline admission metric; null when the sample carries no value. */
  baselineMetric: number | null
  /** Candidate admission metric; null when the sample carries no value. */
  candidateMetric: number | null
  /** Candidate minus baseline; null when either side is missing. */
  delta: number | null
}

/** Explicit outcome of the gain analysis. */
export type GainVerdict = 'gain' | 'no-gain' | 'insufficient-evidence'

/** The structured form written beside the Markdown report. */
export interface GainReportJson {
  /** Report vocabulary version. */
  schemaVersion: 1
  /** Gate identity. */
  gateId: string
  /** The candidate version. */
  version: string
  /** The version it was compared against. */
  baselineVersion: string
  /** The metric admission used. */
  admission: 'reward' | 'self-report'
  /** The explicit gain verdict. */
  verdict: GainVerdict
  /** Number of paired task/repeat rows. */
  pairedRuns: number
  /** The admission threshold this gate was judged against. */
  minGain: number
  /** Smallest gain the sample could detect; null with fewer than two paired rows. */
  detectability: number | null
  /** Observed mean paired delta; zero when no row carried both metrics. */
  meanDelta: number
  /** Lower bootstrap bound. */
  ciLow: number
  /** Upper bootstrap bound. */
  ciHigh: number
  /** Two-sided error rate used for the interval. */
  alpha: number
  /** Resample count used for the interval. */
  iterations: number
  /** Baseline token spend. */
  baselineTokens: number
  /** Candidate token spend. */
  candidateTokens: number
  /** The raw pairs, including both samples. */
  rows: PairedRun[]
  /** The gate's own reasons. */
  reasons: string[]
}

/** One rendered gain report. */
export interface GainReport {
  /** The human-readable Markdown page. */
  markdown: string
  /** The same content as structured data. */
  json: GainReportJson
}

/** The pairing key: one task and one repeat. */
function sampleKey(sample: GateSample): string {
  return `${sample.taskId}#${String(sample.repeat)}`
}

/** The admission metric for one sample: ground-truth reward or run completion. */
function admissionMetric(sample: GateSample, admission: GateReport['admission']): number | null {
  if (admission === 'reward') return sample.reward
  return sample.termination === 'completed' ? 1 : 0
}

/**
 * Pair baseline and candidate samples for every task and repeat.
 * @param samples - both sides' runs.
 * @param version - the candidate version.
 * @param baselineVersion - the baseline version.
 * @param admission - which metric the pair reports.
 * @returns the pairs that exist on both sides.
 */
export function pairSamples(
  samples: readonly GateSample[],
  version: string,
  baselineVersion: string,
  admission: GateReport['admission'],
): PairedRun[] {
  const baseline = new Map<string, GateSample>()
  for (const sample of samples) {
    if (sample.version === baselineVersion) baseline.set(sampleKey(sample), sample)
  }
  const rows: PairedRun[] = []
  for (const sample of samples) {
    if (sample.version !== version) continue
    const peer = baseline.get(sampleKey(sample))
    if (peer === undefined) continue
    const baselineMetric = admissionMetric(peer, admission)
    const candidateMetric = admissionMetric(sample, admission)
    rows.push({
      taskId: sample.taskId,
      repeat: sample.repeat,
      baseline: peer,
      candidate: sample,
      baselineMetric,
      candidateMetric,
      delta: baselineMetric === null || candidateMetric === null ? null : candidateMetric - baselineMetric,
    })
  }
  return rows
}

/**
 * Extract the numeric paired deltas from a pairing result.
 * @param rows - paired runs, including pairs whose metric is unavailable.
 * @returns only the deltas that both sides supplied.
 */
export function pairedDeltas(rows: readonly PairedRun[]): number[] {
  const deltas: number[] = []
  for (const row of rows) if (row.delta !== null) deltas.push(row.delta)
  return deltas
}

/**
 * Pair the baseline and candidate samples for every task and repeat.
 * @param report - the gate report.
 * @returns the pairs that exist on both sides.
 */
export function pairedRuns(report: GateReport): PairedRun[] {
  return pairSamples(report.samples, report.version, report.baselineVersion, report.admission)
}

/** FNV-1a over the seed string, so one gate always resamples identically. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

/**
 * Percentile bootstrap confidence interval for one mean.
 * @param values - the observed paired deltas; must not be empty.
 * @param seed - deterministic resampling seed.
 * @param iterations - resample count.
 * @param alpha - two-sided error rate.
 * @returns the observed mean and the interval bounds.
 */
export function bootstrapMeanCI(
  values: readonly number[],
  seed: string,
  iterations = DEFAULT_ITERATIONS,
  alpha = DEFAULT_ALPHA,
): { mean: number; low: number; high: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const random = mulberry32(hashSeed(seed))
  const means: number[] = []
  for (let draw = 0; draw < iterations; draw += 1) {
    let sum = 0
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] as number
    }
    means.push(sum / values.length)
  }
  means.sort((left, right) => left - right)
  const lowIndex = Math.floor((alpha / 2) * iterations)
  const highIndex = Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))
  return { mean, low: means[lowIndex] as number, high: means[highIndex] as number }
}

/** Classify the evidence, not just the gate decision. */
function verdictOf(
  report: GateReport,
  rows: readonly PairedRun[],
  deltas: readonly number[],
  interval: { mean: number; low: number },
): GainVerdict {
  if (rows.length < MIN_PAIRED_ROWS || deltas.length === 0) return 'insufficient-evidence'
  if (!report.pass) {
    // A gate that refused on its own noise floor is not evidence of no gain.
    return report.detectability !== null && report.detectability > report.minGain
      ? 'insufficient-evidence'
      : 'no-gain'
  }
  if (interval.mean <= 0) return 'no-gain'
  return interval.low > 0 ? 'gain' : 'insufficient-evidence'
}

/** Render one number with an explicit sign. */
function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`
}

/** Render one optional number. */
function show(value: number | null): string {
  return value === null ? '—' : value.toFixed(3)
}

/**
 * Build the gain report for one gate.
 * @param report - the gate report.
 * @param options - optional seed and resample controls.
 * @returns the Markdown page and structured JSON.
 */
export function renderGainReport(
  report: GateReport,
  options: { seed?: string; iterations?: number; alpha?: number } = {},
): GainReport {
  const rows = pairedRuns(report)
  const deltas = rows.flatMap(row => row.delta === null ? [] : [row.delta])
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const alpha = options.alpha ?? DEFAULT_ALPHA
  const interval = deltas.length === 0
    ? { mean: 0, low: 0, high: 0 }
    : bootstrapMeanCI(deltas, options.seed ?? report.gateId, iterations, alpha)
  const verdict = verdictOf(report, rows, deltas, interval)
  const lines = [
    `# LCRD gain report — ${report.version}`,
    '',
    `- Gate: \`${report.gateId}\` (baseline \`${report.baselineVersion}\`)`,
    `- Admission: ${report.admission}`,
    `- Verdict: ${verdict.toUpperCase()}`,
    `- Paired runs: ${String(rows.length)}`,
    `- Detectable gain: ${show(report.detectability)} (paired n=${String(report.pairedN)}, threshold ${report.minGain.toFixed(3)})`,
    `- Mean paired delta: ${signed(interval.mean)}`,
    `- ${((1 - alpha) * 100).toFixed(0)}% bootstrap CI: [${signed(interval.low)}, ${signed(interval.high)}]`,
    `- Gate decision: ${report.pass ? 'PASS' : 'FAIL'} — ${report.reasons.join('; ')}`,
    `- Tokens: baseline ${String(report.baseline.tokens)}, candidate ${String(report.candidate.tokens)}`,
    '',
    '| Task | Repeat | B reward | C reward | B verdict | C verdict | B termination | C termination | Δ admission | B tokens | C tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    lines.push(
      `| ${row.taskId} | ${String(row.repeat)} | ${show(row.baseline.reward)} | ${show(row.candidate.reward)} `
      + `| ${row.baseline.finalVerdict} | ${row.candidate.finalVerdict} `
      + `| ${row.baseline.termination} | ${row.candidate.termination} `
      + `| ${row.delta === null ? '—' : signed(row.delta)} | ${String(row.baseline.tokens)} | ${String(row.candidate.tokens)} |`,
    )
  }
  if (verdict === 'insufficient-evidence') {
    lines.push('', 'The sample cannot distinguish this change from noise; keep human approval and a larger run.')
  }
  lines.push('')
  return {
    markdown: lines.join('\n'),
    json: {
      schemaVersion: 1,
      gateId: report.gateId,
      version: report.version,
      baselineVersion: report.baselineVersion,
      admission: report.admission,
      verdict,
      pairedRuns: rows.length,
      minGain: report.minGain,
      detectability: report.detectability,
      meanDelta: interval.mean,
      ciLow: interval.low,
      ciHigh: interval.high,
      alpha,
      iterations,
      baselineTokens: report.baseline.tokens,
      candidateTokens: report.candidate.tokens,
      rows,
      reasons: report.reasons,
    },
  }
}
