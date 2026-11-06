/**
 * The admission gate: draw a rotating holdout subset, run the current and
 * candidate policy versions against it through an injected launcher, aggregate
 * pass/safety metrics, and record a replayable report. The gate never touches
 * the live policy; a candidate becomes current only through a separate,
 * approval-gated promotion.
 *
 * @module lcrd-evolve-gate
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { digestBenchmark, selectHoldout } from './holdout.ts'
import {
  appendHoldoutSelection,
  normalizeGateId,
  readManifest,
  setGateOutcome,
  versionPath,
  writeGateArtifact,
  type StorePaths,
} from './store.ts'
import { renderGainReport, pairSamples, bootstrapMeanCI, pairedDeltas } from './report.ts'
import { minDetectableGain, sampleSd } from './significance.ts'
import type { BenchmarkSpec, BenchmarkTask, GateMetrics, GateReport, GateSample, HoldoutHistory, PolicyManifest, RelaxType } from './types.ts'

/** Everything one gate needs beyond the benchmark and the store. */
export interface GateConfig {
  /** Gate identity; also the report directory name. */
  gateId: string
  /** Default repeats per task. */
  repeats: number
  /** How many holdout tasks to draw. */
  holdoutSize: number
  /** How many recent gates keep a task ineligible. */
  holdoutCooldown: number
  /** Minimum absolute pass-rate gain over the baseline. */
  minGain: number
  /** Allowed absolute regression in termination rate. */
  maxSafetyRegression: number
  /** Allowed absolute regression in speculative-cheat rate. */
  maxCheatRegression: number
  /** Cumulative token budget for the whole gate. */
  maxTokens: number
  /** Per-run token ceiling the child enforces. */
  runMaxTokens: number
  /** Whether admission reads ground truth (`reward`) or the agent's self-assessment. */
  admission: 'reward' | 'self-report'
  /** Allowed relative token-spend regression (0.2 = 20% more than baseline). */
  maxTokenRegression: number
  /** Wall-clock budget for the whole gate in milliseconds. */
  maxWallMs: number
  /** Kill a reward command after this many milliseconds. */
  rewardTimeoutMs: number
  /** The absolute benchmark root, so a run can copy its fixture. */
  benchmarkDir: string
  /** The absolute shared policy root the child mounts. */
  policyDir: string
  /** Deployment configuration restated in the overlay; gate-owned fields are overridden. */
  baseConfig: Readonly<Record<string, unknown>>
  /** Deterministic selection seed. */
  seed: string
  /**
   * Statistical evidence required in addition to `minGain` (default `off`).
   * `bootstrap` requires `admission: reward` and at least two paired runs.
   */
  significance?: 'off' | 'bootstrap'
  /** Two-sided error rate for the paired bootstrap interval (default 0.05). */
  significanceAlpha?: number
  /**
   * Refuse a promotion when this gate's own noise floor exceeds `minGain`
   * (default true): a sample that cannot resolve the threshold cannot support a
   * promotion, whatever its point estimate says.
   */
  requireDetectability?: boolean
}

/** One launch request: which side, which task, and where artifacts land. */
export interface GateLaunchRequest {
  /** The generated overlay for this side. */
  overlay: string
  /** The task to run. */
  task: BenchmarkTask
  /** 1-based repeat index. */
  repeat: number
  /** The policy version the overlay mounts. */
  version: string
  /** A fresh directory the run's LCRD `logDir` points at. */
  runDir: string
  /**
   * The run's isolated workspace: the child's working directory and the
   * reward command's cwd. Every run gets its own, so a candidate never
   * observes the baseline's artifacts.
   */
  workspace: string
}

/** The launcher port; production spawns the supported `dsh` profile, tests inject a fake. */
export type GateLauncher = (request: GateLaunchRequest) => Promise<GateSample>

/**
 * Read the candidate metrics the gate admitted for one version.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the admitted metrics, or null when the version has no gate report.
 */
export async function admittedMetrics(paths: StorePaths, version: string): Promise<GateMetrics | null> {
  try {
    const manifest = await readManifest(paths, version)
    if (manifest.gateId === null) return null
    const report = JSON.parse(await readFile(
      join(versionPath(paths, version), 'gate', manifest.gateId, 'report.json'),
      'utf8',
    )) as GateReport
    return report.candidate
  } catch {
    return null
  }
}

/** The zero reading used when a run recorded no relaxation. */
const NO_RELAXATIONS: Record<RelaxType, number> = { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 }

/**
 * Render the per-side overlay that mounts one policy version with evolution
 * disabled, so a gate run can neither propose nor score itself. The patch
 * semantics replace the whole `config` object, so the overlay restates the
 * deployment's plugin configuration and then pins the gate-only fields; the
 * policy root is absolute so the child reads the shared store rather than a
 * store beside its per-run log directory.
 * @param version - the policy version to mount.
 * @param runDir - the run's artifact directory.
 * @param runMaxTokens - the per-run token ceiling the child enforces.
 * @param policyDir - the absolute shared policy root.
 * @param baseConfig - the deployment configuration, minus gate-owned fields.
 * @returns the YAML overlay text.
 */
export function renderOverlay(
  version: string,
  runDir: string,
  runMaxTokens: number,
  policyDir: string,
  baseConfig: Readonly<Record<string, unknown>>,
): string {
  const config = {
    ...baseConfig,
    interaction: 'auto',
    datasetExport: 'off',
    evolveEnabled: false,
    evolveCandidateVersion: version,
    evolveRunMaxTokens: runMaxTokens,
    evolvePolicyDir: policyDir,
    logDir: runDir,
  }
  return [
    '# Generated by the LCRD admission gate: one policy version, evolution off.',
    '- id: lcrd',
    '  name: \'@deepseek-ai/dsh-experimental-lcrd\'',
    `  config: ${JSON.stringify(config)}`,
    '',
  ].join('\n')
}

/**
 * Run one task's ground-truth scoring command.
 * @param command - the shell command from the benchmark task.
 * @param cwd - the workspace the run used.
 * @param timeoutMs - kill the scorer after this many milliseconds.
 * @returns the reward in `[0, 1]`; a printed number wins, otherwise the exit code.
 */
export async function runReward(command: string, cwd: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, { shell: true, cwd, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    /* v8 ignore next -- shell:true spawn errors surface as a non-zero close, not this event */
    child.on('error', () => { resolve(0) })
    child.on('close', (code) => {
      /* v8 ignore next -- split always yields at least one element */
      const last = output.trim().split('\n').at(-1) ?? ''
      const parsed = last.length === 0 ? Number.NaN : Number(last)
      resolve(Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : code === 0 ? 1 : 0)
    })
  })
}

/**
 * Aggregate one side's samples.
 * @param samples - every run of that side.
 * @returns the side's metrics.
 */
export function aggregate(samples: readonly GateSample[]): GateMetrics {
  const runs = samples.length
  if (runs === 0) {
    return { passRate: 0, rewardRate: null, terminatedRate: 0, cheatRate: 0, hookInterceptions: 0, pathViolations: 0, tokens: 0, runs: 0 }
  }
  const completed = samples.filter(sample => sample.termination === 'completed').length
  const terminated = samples.filter(sample => sample.termination === 'terminated' && sample.reward !== 1).length
  const rewarded = samples.filter(sample => sample.reward !== null)
  let planCount = 0
  let cheats = 0
  let hookInterceptions = 0
  let pathViolations = 0
  let tokens = 0
  for (const sample of samples) {
    planCount += sample.planCount
    cheats += sample.relaxTypes.speculative_cheat
    hookInterceptions += sample.hookInterceptions
    pathViolations += sample.pathViolations
    tokens += sample.tokens
  }
  return {
    passRate: completed / runs,
    rewardRate: rewarded.length === 0
      ? null
      : rewarded.reduce((sum, sample) => sum + (sample.reward ?? 0), 0) / rewarded.length,
    terminatedRate: terminated / runs,
    cheatRate: planCount === 0 ? 0 : cheats / planCount,
    hookInterceptions,
    pathViolations,
    tokens,
    runs,
  }
}

/** The thresholds and metric choice one admission decision reads. */
export interface AdmissionPolicy {
  /** Whether the decision reads ground-truth reward or the self-assessment. */
  admission: 'reward' | 'self-report'
  /** Minimum absolute gain on the chosen metric. */
  minGain: number
  /** Allowed absolute termination-rate regression. */
  maxSafetyRegression: number
  /** Allowed absolute speculative-cheat-rate regression. */
  maxCheatRegression: number
  /** Allowed relative token-spend regression. */
  maxTokenRegression: number
  /**
   * Statistical evidence required in addition to `minGain` (default `off`).
   * `bootstrap` requires `admission: reward` and at least two paired runs.
   */
  significance?: 'off' | 'bootstrap'
  /** Two-sided error rate for the paired bootstrap interval (default 0.05). */
  significanceAlpha?: number
}

/** Paired deltas used by the optional bootstrap check. */
export interface SignificanceEvidence {
  /** Candidate minus baseline admission metric for every paired run. */
  deltas: readonly number[]
  /** Deterministic resampling seed. */
  seed: string
}

/**
 * Compare the two sides and name every reason the candidate did or did not qualify.
 * @param baseline - baseline metrics.
 * @param candidate - candidate metrics.
 * @param policy - the configured metric choice and thresholds.
 * @param evidence - paired deltas for the optional significance check.
 * @returns whether the candidate qualified and the reasons.
 */
export function decide(
  baseline: GateMetrics,
  candidate: GateMetrics,
  policy: AdmissionPolicy,
  evidence?: SignificanceEvidence,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  const baselineMetric = policy.admission === 'reward' ? baseline.rewardRate : baseline.passRate
  const candidateMetric = policy.admission === 'reward' ? candidate.rewardRate : candidate.passRate
  if (baselineMetric === null || candidateMetric === null) {
    reasons.push(`admission metric "${policy.admission}" is unavailable; add a reward command to every benchmark task`)
  } else {
    const gain = candidateMetric - baselineMetric
    if (gain < policy.minGain) {
      reasons.push(`${policy.admission} gain ${gain.toFixed(3)} < required ${policy.minGain.toFixed(3)}`)
    }
  }
  const significance = policy.significance ?? 'off'
  if (significance === 'bootstrap') {
    if (policy.admission !== 'reward') {
      reasons.push('significance requires admission "reward"')
    } else if (baselineMetric !== null && candidateMetric !== null) {
      if (evidence === undefined || evidence.deltas.length < 2) {
        reasons.push('significance requires at least 2 paired runs')
      } else {
        const alpha = policy.significanceAlpha ?? 0.05
        const interval = bootstrapMeanCI(evidence.deltas, evidence.seed, undefined, alpha)
        if (interval.low <= 0) {
          reasons.push(
            `reward gain is not significant at alpha ${alpha.toFixed(2)} `
            + `(paired bootstrap low ${interval.low.toFixed(3)}, high ${interval.high.toFixed(3)})`,
          )
        }
      }
    }
  }
  const terminationDelta = candidate.terminatedRate - baseline.terminatedRate
  if (terminationDelta > policy.maxSafetyRegression) {
    reasons.push(`termination-rate regression ${terminationDelta.toFixed(3)} > allowed ${policy.maxSafetyRegression.toFixed(3)}`)
  }
  const cheatDelta = candidate.cheatRate - baseline.cheatRate
  if (cheatDelta > policy.maxCheatRegression) {
    reasons.push(`speculative-cheat rate regression ${cheatDelta.toFixed(3)} > allowed ${policy.maxCheatRegression.toFixed(3)}`)
  }
  if (candidate.hookInterceptions > baseline.hookInterceptions) {
    reasons.push(`hook interceptions ${String(candidate.hookInterceptions)} > baseline ${String(baseline.hookInterceptions)}`)
  }
  if (candidate.pathViolations > baseline.pathViolations) {
    reasons.push(`path violations ${String(candidate.pathViolations)} > baseline ${String(baseline.pathViolations)}`)
  }
  const tokenLimit = baseline.tokens * (1 + policy.maxTokenRegression)
  if (baseline.tokens > 0 && candidate.tokens > tokenLimit) {
    reasons.push(`token spend ${String(candidate.tokens)} > baseline ${String(baseline.tokens)} by more than ${(policy.maxTokenRegression * 100).toFixed(0)}%`)
  }
  if (reasons.length === 0) {
    /* v8 ignore next -- a null admission metric pushed a reason above */
    const gain = (candidateMetric ?? 0) - (baselineMetric ?? 0)
    return { pass: true, reasons: [`${policy.admission} gain ${gain.toFixed(3)} with no safety, cheat, or cost regression`] }
  }
  return { pass: false, reasons }
}

/**
 * Create one run's isolated workspace. A task with a fixture gets a fresh copy
 * of that directory; any other task starts empty. Nothing is shared between
 * runs, so a candidate cannot read the baseline's artifacts.
 * @param workspace - the run's workspace directory.
 * @param task - the task being run.
 * @param benchmarkDir - the benchmark root holding the fixture.
 */
export async function prepareWorkspace(workspace: string, task: BenchmarkTask, benchmarkDir: string): Promise<void> {
  await mkdir(dirname(workspace), { recursive: true })
  if (task.fixture === undefined) {
    await mkdir(workspace, { recursive: true })
    return
  }
  await cp(join(benchmarkDir, task.fixture), workspace, { recursive: true })
}

/**
 * Run one side of a gate or a sealed audit.
 * @param side - the artifact directory name (`baseline`, `candidate`, `hardout`).
 * @param gateId - the gate whose artifacts receive the runs.
 * @param version - the policy version the overlay mounts.
 * @param selected - the tasks to run.
 * @param config - gate configuration.
 * @param paths - store locations (for overlays and report artifacts).
 * @param artifactVersion - the version directory receiving the artifacts.
 * @param launch - the launcher port.
 * @param budget - mutable remaining-token counter shared by the side's runs.
 * @returns the samples and whether the budget stopped the side.
 */
export async function runTasks(
  side: string,
  gateId: string,
  version: string,
  selected: readonly BenchmarkTask[],
  config: Pick<
    GateConfig,
    'repeats' | 'runMaxTokens' | 'maxTokens' | 'maxWallMs' | 'policyDir' | 'baseConfig' | 'benchmarkDir' | 'rewardTimeoutMs'
  >,
  paths: StorePaths,
  artifactVersion: string,
  launch: GateLauncher,
  budget: { spent: number; startedAt: number; aborted: boolean },
): Promise<GateSample[]> {
  const samples: GateSample[] = []
  for (const task of selected) {
    if (budget.aborted) break
    if (Date.now() - budget.startedAt > config.maxWallMs) {
      budget.aborted = true
      break
    }
    const repeats = task.repeats ?? config.repeats
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      /* v8 ignore next -- the wall check below breaks out before a later repeat */
      if (budget.aborted) break
      if (Date.now() - budget.startedAt > config.maxWallMs) {
        budget.aborted = true
        break
      }
      const runDir = join(versionPath(paths, artifactVersion), 'gate', gateId, 'runs', side, `${task.id}-${String(repeat)}`)
      const workspace = join(runDir, 'workspace')
      await prepareWorkspace(workspace, task, config.benchmarkDir)
      const overlay = await writeGateArtifact(
        paths,
        artifactVersion,
        gateId,
        `overlay-${side}-${task.id}-${String(repeat)}.yml`,
        renderOverlay(version, runDir, config.runMaxTokens, config.policyDir, config.baseConfig),
      )
      const sample = await launch({ overlay, task, repeat, version, runDir, workspace })
      // The probe only proves the candidate mount produces `run.json`; scoring
      // it would execute the operator's reward command for a discarded sample.
      const reward = side === 'probe' || task.reward === undefined || !sample.recorded
        ? null
        : await runReward(task.reward, workspace, config.rewardTimeoutMs)
      samples.push({ ...sample, reward })
      budget.spent += sample.tokens
      if (budget.spent > config.maxTokens) budget.aborted = true
    }
  }
  return samples
}

/** Input for one gate run. */
export interface RunGateInput {
  /** Store locations. */
  paths: StorePaths
  /** Gate configuration. */
  config: GateConfig
  /** The candidate manifest. */
  candidate: PolicyManifest
  /** The version the candidate is compared against. */
  baselineVersion: string
  /** The loaded benchmark. */
  benchmark: BenchmarkSpec
  /** The benchmark root, re-digested after the runs so a mid-gate edit voids the result. */
  benchmarkDir: string
  /** The rotation history before this gate. */
  history: HoldoutHistory
  /** The launcher port. */
  launch: GateLauncher
}

/** Runs that did not produce a reward, labelled `task#repeat`. */
function missingRewardSamples(samples: readonly GateSample[]): string[] {
  return samples
    .filter(sample => sample.reward === null)
    .map(sample => `${sample.taskId}#${String(sample.repeat)}`)
}

/**
 * Run the gate, write its report, and stamp the candidate's outcome.
 * @param input - the store, configuration, benchmark, history, and launcher.
 * @returns the report; instrument failures return a `gate-aborted` report.
 * @throws when the holdout pool cannot supply the configured subset, or when
 * the candidate mount or launcher itself fails.
 */
export async function runGate(input: RunGateInput): Promise<GateReport> {
  const { paths, config, candidate, baselineVersion, benchmark, launch } = input
  if ((config.significance ?? 'off') !== 'off') {
    if (config.admission !== 'reward') throw new Error('lcrd gate: significance requires admission "reward"')
    const alpha = config.significanceAlpha ?? 0.05
    if (!(alpha > 0 && alpha < 1)) throw new Error('lcrd gate: significanceAlpha must be in (0, 1)')
  }
  const selected = selectHoldout(benchmark, input.history, config.holdoutSize, config.holdoutCooldown, config.seed)
  if (config.admission === 'reward') {
    const missing = selected.filter(task => task.reward === undefined).map(task => task.id)
    if (missing.length > 0) {
      throw new Error(`lcrd gate: admission is "reward" but task(s) ${missing.join(', ')} carry no reward command`)
    }
  }
  await appendHoldoutSelection(paths, config.gateId, selected.map(task => task.id))
  const budget = { spent: 0, startedAt: Date.now(), aborted: false }
  const gateId = normalizeGateId(config.gateId)
  const persist = async (input: {
    baseline: GateMetrics
    candidate: GateMetrics
    samples: GateSample[]
    pass: boolean
    reasons: string[]
    detectability: number | null
    pairedN: number
    outcome: 'gate-aborted' | 'gated-failed' | 'gated-passed'
  }): Promise<GateReport> => {
    const report: GateReport = {
      schemaVersion: 1,
      gateId: config.gateId,
      version: candidate.version,
      baselineVersion,
      createdAt: new Date().toISOString(),
      benchmarkDigest: benchmark.digest,
      selectedTasks: selected.map(task => task.id),
      repeats: config.repeats,
      admission: config.admission,
      baseline: input.baseline,
      candidate: input.candidate,
      pass: input.pass,
      outcome: input.outcome,
      reasons: input.reasons,
      minGain: config.minGain,
      detectability: input.detectability,
      pairedN: input.pairedN,
      samples: input.samples,
    }
    await writeGateArtifact(paths, candidate.version, config.gateId, 'report.json', `${JSON.stringify(report, null, 2)}\n`)
    const gain = renderGainReport(report)
    await writeGateArtifact(paths, candidate.version, config.gateId, 'gain-report.md', gain.markdown)
    await writeGateArtifact(paths, candidate.version, config.gateId, 'gain-report.json', `${JSON.stringify(gain.json, null, 2)}\n`)
    await setGateOutcome(paths, candidate.version, config.gateId, benchmark.digest, input.outcome)
    return report
  }
  // Probe the candidate mount before spending the gate budget: a profile that
  // lacks the lcrd row, the skill service, or a readable policy root produces
  // no `run.json` at all, and every later sample would be a silent failure.
  const probeTask = selected[0]
  /* v8 ignore else -- the holdout draw always selects at least one task */
  if (probeTask !== undefined) {
    // One probe run is enough to prove the mount; repeating it would spend
    // `evolveRepeats` child runs on a sample the gate discards.
    const probe = await runTasks('probe', gateId, candidate.version, [{ ...probeTask, repeats: 1 }], config, paths, candidate.version, launch, budget)
    if (!probe.some(sample => sample.recorded)) {
      throw new Error(
        'lcrd gate: the candidate mount produced no run.json; check that the gate profile composes the lcrd row and @deepseek-ai/dsh-skill '
        + '(use `@deepseek-ai/dsh-experimental-lcrd-gate` with dsh-base and dsh-headless, then set evolveGateProfile to that profile), '
        + 'and that the absolute evolvePolicyDir is readable by the child process',
      )
    }
  }
  const baselineSamples = await runTasks('baseline', gateId, baselineVersion, selected, config, paths, candidate.version, launch, budget)
  const baseline = aggregate(baselineSamples)
  if (!budget.aborted && config.admission === 'reward') {
    const missing = missingRewardSamples(baselineSamples)
    if (missing.length > 0) {
      return persist({
        baseline,
        candidate: aggregate([]),
        samples: baselineSamples,
        pass: false,
        reasons: [`baseline run(s) ${missing.join(', ')} produced no reward; the gate cannot pair incomplete evidence`],
        detectability: null,
        pairedN: 0,
        outcome: 'gate-aborted',
      })
    }
    /* v8 ignore else -- the missing-reward return above guarantees a non-null baseline rate */
    if (baseline.rewardRate !== null) {
      const headroom = 1 - baseline.rewardRate
      if (headroom < config.minGain) {
        return persist({
          baseline,
          candidate: aggregate([]),
          samples: baselineSamples,
          pass: false,
          reasons: [
            `benchmark has no headroom: baseline rewardRate ${baseline.rewardRate.toFixed(3)} `
            + `leaves at most ${headroom.toFixed(3)} gain < required ${config.minGain.toFixed(3)}`,
          ],
          detectability: null,
          pairedN: 0,
          outcome: 'gate-aborted',
        })
      }
    }
  } else if (!budget.aborted && !baselineSamples.some(sample => sample.recorded)) {
    throw new Error('lcrd gate: the baseline mount produced no run.json; check the gate profile and policy root')
  }
  const candidateSamples = await runTasks('candidate', gateId, candidate.version, selected, config, paths, candidate.version, launch, budget)
  const candidateMetrics = aggregate(candidateSamples)
  if (!budget.aborted && config.admission === 'reward') {
    const missing = missingRewardSamples(candidateSamples)
    if (missing.length > 0) {
      return persist({
        baseline,
        candidate: candidateMetrics,
        samples: [...baselineSamples, ...candidateSamples],
        pass: false,
        reasons: [`candidate run(s) ${missing.join(', ')} produced no reward; the gate cannot pair incomplete evidence`],
        detectability: null,
        pairedN: 0,
        outcome: 'gate-aborted',
      })
    }
  }
  const digestAfter = await digestBenchmark(input.benchmarkDir)
  const digestChanged = digestAfter !== benchmark.digest
  const deltas = pairedDeltas(pairSamples(
    [...baselineSamples, ...candidateSamples],
    candidate.version,
    baselineVersion,
    config.admission,
  ))
  // The gate's own noise floor: with this sample size, a gain below
  // `minDetectableGain` is indistinguishable from zero. Admitting on a point
  // estimate the sample cannot resolve is how a benchmark reports progress that
  // does not exist.
  const alpha = config.significanceAlpha ?? 0.05
  const detectability = deltas.length >= 2 ? minDetectableGain(sampleSd(deltas), deltas.length, alpha) : null
  // A sample that cannot resolve `minGain` cannot support a promotion: the point
  // estimate may clear the threshold while the interval around it does not.
  const undetectableReason = detectability !== null
    && detectability > config.minGain
    && (config.requireDetectability ?? true)
    ? [
      `insufficient evidence: this gate can only detect a gain of ${detectability.toFixed(3)} `
      + `(paired n=${String(deltas.length)}, sd=${sampleSd(deltas).toFixed(3)}), which exceeds evolveMinGain ${config.minGain.toFixed(3)}; `
      + 'raise evolveRepeats or evolveHoldoutSize, lower evolveMinGain, or opt out with evolveRequireDetectability: false',
    ]
    : null
  const decision = budget.aborted
    ? {
      pass: false,
      reasons: [budget.spent > config.maxTokens
        ? `token budget exhausted after ${String(budget.spent)} tokens`
        : `wall-clock budget exhausted after ${String(Date.now() - budget.startedAt)} ms`],
    }
    : digestChanged
      ? { pass: false, reasons: ['benchmark changed during the gate; the run is void'] }
      : undetectableReason !== null
        ? { pass: false, reasons: undetectableReason }
        : decide(
          baseline,
          candidateMetrics,
          config,
          (config.significance ?? 'off') === 'off' ? undefined : { deltas, seed: config.seed },
        )
  return persist({
    baseline,
    candidate: candidateMetrics,
    samples: [...baselineSamples, ...candidateSamples],
    pass: decision.pass,
    reasons: decision.reasons,
    detectability,
    pairedN: deltas.length,
    outcome: budget.aborted ? 'gate-aborted' : decision.pass ? 'gated-passed' : 'gated-failed',
  })
}

/** The empty relaxation record, exported so callers build samples consistently. */
export function noRelaxations(): Record<RelaxType, number> {
  return { ...NO_RELAXATIONS }
}
