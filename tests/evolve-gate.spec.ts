/**
 * Gate execution, brief rendering, sealed audit, and online monitoring against
 * a fake launcher: admission, safety regression, budget abort, digest voids,
 * rotating draws, brief contents, and automatic rollback.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBrief, diffSkills } from '../src/evolve/brief.ts'
import {
  admittedMetrics,
  aggregate,
  decide,
  renderOverlay,
  runGate,
  runTasks,
  type GateLauncher,
  type GateLaunchRequest,
  type RunGateInput,
} from '../src/evolve/gate.ts'
import { auditHardout } from '../src/evolve/hardout.ts'
import { loadBenchmark } from '../src/evolve/holdout.ts'
import { evaluateWindow, observeRun } from '../src/evolve/monitor.ts'
import {
  ensureStore,
  promote,
  readManifest,
  readPointer,
  readQuarantine,
  stageVersion,
  storePaths,
  versionPath,
} from '../src/evolve/store.ts'
import type { GateReport, GateSample, PolicyManifest, RelaxType } from '../src/evolve/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ZERO: Record<RelaxType, number> = { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 }

/** One sample with the given outcome. */
function sample(version: string, input: Partial<GateSample> & { taskId?: string } = {}): GateSample {
  return {
    taskId: input.taskId ?? 'h-1',
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

/** A benchmark root with two holdout tasks and one sealed task. */
function benchmarkDir(reward = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-gate-bench-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'holdout'))
  mkdirSync(join(dir, 'hardout'))
  const command = 'node reward.mjs'
  const task = (id: string, anchor: string): Record<string, unknown> =>
    reward ? { id, anchor, reward: command } : { id, anchor }
  writeFileSync(join(dir, 'train.jsonl'), `${JSON.stringify(task('t-1', 'train'))}\n`)
  writeFileSync(join(dir, 'holdout', 'pool.jsonl'), [
    JSON.stringify(task('h-1', 'holdout one')),
    JSON.stringify(task('h-2', 'holdout two')),
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'hardout', 'sealed.jsonl'), `${JSON.stringify(task('s-1', 'sealed'))}\n`)
  return dir
}

/** A launcher that writes a scripted reward and can mark one side unrecorded. */
function rewardLauncher(input: {
  exitCode: number
  missing?: (taskId: string, side: 'baseline' | 'candidate') => boolean
}): GateLauncher {
  return async ({ task, repeat, version, runDir, workspace }) => {
    const probe = runDir.includes('probe')
    const side = probe ? 'probe' : runDir.includes('baseline') ? 'baseline' : 'candidate'
    writeFileSync(join(workspace, 'reward.mjs'), `process.exit(${String(input.exitCode)})`)
    const recorded = probe || !(side !== 'probe' && (input.missing?.(task.id, side) ?? false))
    return sample(version, { recorded, taskId: task.id, repeat })
  }
}

/** A store with a staged candidate v0002 on top of the bootstrap v0001. */
async function stagedCandidate(): Promise<{ root: string; paths: ReturnType<typeof storePaths>; candidate: PolicyManifest }> {
  const root = mkdtempSync(join(tmpdir(), 'lcrd-gate-store-'))
  dirs.push(root)
  const paths = storePaths(join(root, 'policy'))
  await ensureStore(paths)
  const candidate = await stageVersion(paths, {
    parent: 'v0001',
    authorSession: 's-1',
    rationale: 'better checks',
    benchmarkDigest: 'd',
    skills: [{ name: 'better-checks', description: 'desc', content: '# better\n' }],
  })
  return { root, paths, candidate }
}

/** A launcher whose outcome depends on the mounted version. */
function launcherFor(outcome: (version: string) => Partial<GateSample>): GateLauncher {
  return async ({ task, repeat, version }) => sample(version, { ...outcome(version), taskId: task.id, repeat })
}

/** The standard gate input. */
async function gateInput(input: {
  paths: ReturnType<typeof storePaths>
  candidate: PolicyManifest
  benchmarkDir: string
  launch: GateLauncher
  overrides?: Partial<RunGateInput['config']>
}): Promise<RunGateInput> {
  return {
    paths: input.paths,
    config: {
      gateId: 'gate-1',
      repeats: 1,
      holdoutSize: 2,
      holdoutCooldown: 0,
      minGain: 0.1,
      maxSafetyRegression: 0,
      maxCheatRegression: 0,
      maxTokenRegression: 0.2,
      maxTokens: 10_000,
      maxWallMs: 60_000,
      runMaxTokens: 1_000,
      admission: 'self-report',
      benchmarkDir: input.benchmarkDir,
      rewardTimeoutMs: 5_000,
      policyDir: input.paths.root,
      baseConfig: {},
      seed: 'seed-1',
      ...input.overrides,
    },
    candidate: input.candidate,
    baselineVersion: 'v0001',
    benchmark: await loadBenchmark(input.benchmarkDir),
    benchmarkDir: input.benchmarkDir,
    history: { selections: [] },
    launch: input.launch,
  }
}

describe('gate helpers', () => {
  it('renders one overlay with the shared policy root and the deployment config', () => {
    const text = renderOverlay('v0002', 'C:/runs/one', 500, 'C:/policy', { maxRetries: 10, learningEnabled: true })
    expect(text).toContain('"evolveCandidateVersion":"v0002"')
    expect(text).toContain('"evolveEnabled":false')
    expect(text).toContain('"evolveRunMaxTokens":500')
    expect(text).toContain('"evolvePolicyDir":"C:/policy"')
    expect(text).toContain('"logDir":"C:/runs/one"')
    expect(text).toContain('"maxRetries":10')
    expect(text).toContain('"learningEnabled":true')
  })

  it('aggregates empty and populated samples', () => {
    expect(aggregate([])).toMatchObject({ runs: 0, passRate: 0, cheatRate: 0, rewardRate: null })
    const metrics = aggregate([
      sample('v', { termination: 'completed' }),
      sample('v', { termination: 'terminated', relaxTypes: { ...ZERO, speculative_cheat: 1 }, planCount: 2, tokens: 5 }),
    ])
    expect(metrics).toMatchObject({
      runs: 2,
      passRate: 0.5,
      rewardRate: null,
      terminatedRate: 0.5,
      cheatRate: 1 / 3,
      tokens: 15,
    })
    expect(aggregate([sample('v', { reward: 1 }), sample('v', { reward: 0 })])).toMatchObject({ rewardRate: 0.5 })
  })

  it('decides admission from gain and the two safety margins', () => {
    const policy = {
      admission: 'self-report' as const,
      minGain: 0.1,
      maxSafetyRegression: 0,
      maxCheatRegression: 0,
      maxTokenRegression: 10,
    }
    const base = aggregate([sample('v', { termination: 'incomplete' })])
    const good = aggregate([sample('v'), sample('v')])
    expect(decide(base, good, policy)).toMatchObject({ pass: true })
    expect(decide(good, good, policy).pass).toBe(false)
    const terminated = aggregate([sample('v', { termination: 'terminated' }), sample('v')])
    expect(decide(good, terminated, { ...policy, minGain: 0 }).reasons)
      .toContain('termination-rate regression 0.500 > allowed 0.000')
    const cheating = aggregate([sample('v', { relaxTypes: { ...ZERO, speculative_cheat: 1 } }), sample('v')])
    expect(decide(good, cheating, { ...policy, minGain: 0, maxSafetyRegression: 1 }).reasons)
      .toContain('speculative-cheat rate regression 0.500 > allowed 0.000')
    const hooked = aggregate([sample('v', { hookInterceptions: 1 }), sample('v')])
    expect(decide(good, hooked, { ...policy, minGain: 0 }).reasons).toContain('hook interceptions 1 > baseline 0')
    const paths = aggregate([sample('v', { pathViolations: 2 }), sample('v')])
    expect(decide(good, paths, { ...policy, minGain: 0 }).reasons).toContain('path violations 2 > baseline 0')
    const expensive = aggregate([sample('v', { tokens: 100 }), sample('v', { tokens: 100 })])
    expect(decide(good, expensive, { ...policy, minGain: 0, maxTokenRegression: 0.2 }).reasons.join('|')).toContain('token spend')
    const rewarding = aggregate([sample('v', { reward: 1 }), sample('v', { reward: 1 })])
    const unrewarded = aggregate([sample('v', { reward: 0 }), sample('v', { reward: 0 })])
    expect(decide(unrewarded, rewarding, { ...policy, admission: 'reward', minGain: 0.5 }).pass).toBe(true)
    expect(decide(aggregate([sample('v'), sample('v')]), unrewarded, { ...policy, admission: 'reward' }).reasons.join('|'))
      .toContain('admission metric "reward" is unavailable')
  })

  it('adds paired bootstrap evidence only when configured', () => {
    const policy = {
      admission: 'reward' as const,
      minGain: 0.1,
      maxSafetyRegression: 1,
      maxCheatRegression: 1,
      maxTokenRegression: 10,
    }
    const base = aggregate([sample('v', { reward: 0 }), sample('v', { reward: 1 })])
    const candidate = aggregate([sample('v', { reward: 1 }), sample('v', { reward: 1 })])
    expect(decide(base, candidate, policy, { deltas: [1, 1, 1, 1], seed: 's' })).toMatchObject({ pass: true })
    expect(decide(base, candidate, { ...policy, significance: 'bootstrap' }, { deltas: [1, 1, 1, 1], seed: 's' }))
      .toMatchObject({ pass: true })
    expect(decide(base, candidate, { ...policy, significance: 'bootstrap' }, { deltas: [1, -1, 1, -1], seed: 's' }).reasons.join('|'))
      .toContain('not significant')
    expect(decide(base, candidate, { ...policy, significance: 'bootstrap' }, { deltas: [1], seed: 's' }).reasons)
      .toContain('significance requires at least 2 paired runs')
    expect(decide(base, candidate, { ...policy, significance: 'bootstrap' }).reasons)
      .toContain('significance requires at least 2 paired runs')
    expect(decide(base, candidate, { ...policy, admission: 'self-report', significance: 'bootstrap' }).reasons)
      .toContain('significance requires admission "reward"')
    const unavailable = aggregate([sample('v')])
    expect(decide(unavailable, unavailable, { ...policy, significance: 'bootstrap' }, { deltas: [1, 1], seed: 's' }).reasons.join('|'))
      .toContain('admission metric "reward" is unavailable')
  })

  it('rejects a significance configuration the gate cannot honor', async () => {
    const { paths, candidate } = await stagedCandidate()
    const benchmark = benchmarkDir(true)
    await expect(runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmark,
      launch: launcherFor(() => ({})),
      overrides: { admission: 'self-report', significance: 'bootstrap' },
    }))).rejects.toThrow('significance requires admission "reward"')
    await expect(runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmark,
      launch: launcherFor(() => ({})),
      overrides: { admission: 'reward', significance: 'bootstrap', significanceAlpha: 1.5 },
    }))).rejects.toThrow('significanceAlpha must be in (0, 1)')
  })

  it('honors per-task repeats and stops on the token budget', async () => {
    const { paths, candidate } = await stagedCandidate()
    const budget = { spent: 0, startedAt: Date.now(), aborted: false }
    const tasks = [
      { id: 'h-1', anchor: 'a', suite: 'holdout' as const, repeats: 2 },
      { id: 'h-2', anchor: 'b', suite: 'holdout' as const },
    ]
    const samples = await runTasks(
      'baseline',
      'gate-x',
      'v0001',
      tasks,
      {
        repeats: 1,
        runMaxTokens: 10,
        maxTokens: 15,
        maxWallMs: 60_000,
        policyDir: paths.root,
        baseConfig: {},
        benchmarkDir: paths.root,
        rewardTimeoutMs: 1_000,
      },
      paths,
      candidate.version,
      launcherFor(() => ({ tokens: 10 })),
      budget,
    )
    expect(samples).toHaveLength(2)
    expect(budget.aborted).toBe(true)
  })
})

describe('runGate', () => {
  it('probes the candidate exactly once regardless of the repeat count', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    const requests: GateLaunchRequest[] = []
    const launch: GateLauncher = async (request) => {
      requests.push(request)
      return sample(request.version, { taskId: request.task.id, repeat: request.repeat })
    }
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch,
      overrides: { repeats: 3, holdoutSize: 1, minGain: 0 },
    }))
    expect(requests.filter(request => request.runDir.includes('probe'))).toHaveLength(1)
    expect(requests.filter(request => request.runDir.includes('baseline'))).toHaveLength(3)
    expect(requests.filter(request => request.runDir.includes('candidate'))).toHaveLength(3)
    const reportDir = join(versionPath(paths, candidate.version), 'gate', report.gateId)
    expect(readFileSync(join(reportDir, 'gain-report.md'), 'utf8')).toContain('# LCRD gain report')
    expect(JSON.parse(readFileSync(join(reportDir, 'gain-report.json'), 'utf8'))).toMatchObject({ verdict: 'no-gain' })
  })

  it('gives every run its own fixture copy', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-gate-fixture-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'holdout'), { recursive: true })
    mkdirSync(join(dir, 'fixtures', 'one'), { recursive: true })
    writeFileSync(join(dir, 'train.jsonl'), '')
    writeFileSync(join(dir, 'holdout', 'pool.jsonl'), `${JSON.stringify({ id: 'h-1', anchor: 'a', fixture: 'fixtures/one' })}\n`)
    writeFileSync(join(dir, 'fixtures', 'one', 'seed.txt'), 'seed')
    const seen: { side: string; workspace: string }[] = []
    const launch: GateLauncher = async ({ task, repeat, version, runDir, workspace }) => {
      const side = runDir.includes('probe') ? 'probe' : runDir.includes('baseline') ? 'baseline' : 'candidate'
      expect(existsSync(join(workspace, 'seed.txt'))).toBe(true)
      seen.push({ side, workspace })
      writeFileSync(join(workspace, `${side}.txt`), side)
      return sample(version, { taskId: task.id, repeat })
    }
    await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch,
      overrides: { repeats: 1, holdoutSize: 1, minGain: 0 },
    }))
    const bySide = new Map(seen.map(entry => [entry.side, entry.workspace]))
    expect(bySide.size).toBe(3)
    expect(new Set(seen.map(entry => entry.workspace)).size).toBe(3)
    expect(existsSync(join(bySide.get('baseline') as string, 'baseline.txt'))).toBe(true)
    expect(existsSync(join(bySide.get('candidate') as string, 'baseline.txt'))).toBe(false)
    expect(existsSync(join(bySide.get('candidate') as string, 'candidate.txt'))).toBe(true)
  })

  it('admits on the ground-truth reward when admission is "reward"', async () => {
    const { paths, candidate } = await stagedCandidate()
    const bench = benchmarkDir(true)
    const launch: GateLauncher = async ({ task, repeat, version, workspace }) => {
      writeFileSync(join(workspace, 'reward.mjs'), [
        "import { readFileSync } from 'node:fs'",
        "process.exit(readFileSync('result.txt', 'utf8').trim() === 'v0002' ? 0 : 1)",
      ].join('\n'))
      writeFileSync(join(workspace, 'result.txt'), version)
      return sample(version, { taskId: task.id, repeat })
    }
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: bench,
      launch,
      overrides: { admission: 'reward', minGain: 0.5, significance: 'bootstrap' },
    }))
    expect(report.baseline.rewardRate).toBe(0)
    expect(report.candidate.rewardRate).toBe(1)
    expect(report.pass).toBe(true)
  })

  it('returns a baseline-only gate-aborted report when the benchmark has no headroom', async () => {
    const { paths, candidate } = await stagedCandidate()
    const sides: string[] = []
    const launch: GateLauncher = async (request) => {
      sides.push(request.runDir.includes('probe') ? 'probe' : request.runDir.includes('baseline') ? 'baseline' : 'candidate')
      return rewardLauncher({ exitCode: 0 })(request)
    }
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(true),
      launch,
      overrides: { admission: 'reward', minGain: 0.1, holdoutSize: 1 },
    }))
    expect(report).toMatchObject({
      outcome: 'gate-aborted',
      pass: false,
      candidate: { runs: 0 },
      detectability: null,
      pairedN: 0,
    })
    expect(report.reasons.join(' ')).toContain('no headroom')
    expect(sides).toEqual(['probe', 'baseline'])
    expect((await readManifest(paths, candidate.version)).status).toBe('gate-aborted')
    const reportPath = join(versionPath(paths, candidate.version), 'gate', 'gate-1', 'report.json')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ outcome: 'gate-aborted', candidate: { runs: 0 } })
    expect(existsSync(join(versionPath(paths, candidate.version), 'gate', 'gate-1', 'gain-report.md'))).toBe(true)
  })

  it('returns a baseline-only gate-aborted report when every baseline run lacks a reward', async () => {
    const { paths, candidate } = await stagedCandidate()
    const sides: string[] = []
    const launch: GateLauncher = async (request) => {
      sides.push(request.runDir.includes('probe') ? 'probe' : request.runDir.includes('baseline') ? 'baseline' : 'candidate')
      return rewardLauncher({ exitCode: 0, missing: (_task, side) => side === 'baseline' })(request)
    }
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(true),
      launch,
      overrides: { admission: 'reward', minGain: 0.1, holdoutSize: 1 },
    }))
    expect(report.outcome).toBe('gate-aborted')
    expect(report.baseline.runs).toBe(1)
    expect(report.candidate.runs).toBe(0)
    expect(report.reasons.join(' ')).toContain('baseline run(s) h-1#1 produced no reward')
    expect(sides).toEqual(['probe', 'baseline'])
    expect((await readManifest(paths, candidate.version)).status).toBe('gate-aborted')
  })

  it('keeps the partial missing-baseline detail and still skips the candidate', async () => {
    const { paths, candidate } = await stagedCandidate()
    const sides: string[] = []
    const launch: GateLauncher = async (request) => {
      sides.push(request.runDir.includes('probe') ? 'probe' : request.runDir.includes('baseline') ? 'baseline' : 'candidate')
      return rewardLauncher({ exitCode: 0, missing: (task, side) => side === 'baseline' && task === 'h-2' })(request)
    }
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(true),
      launch,
      overrides: { admission: 'reward', minGain: 0.1, holdoutSize: 2 },
    }))
    expect(report.outcome).toBe('gate-aborted')
    expect(report.baseline.runs).toBe(2)
    expect(report.candidate.runs).toBe(0)
    expect(report.reasons.join(' ')).toContain('h-2#1')
    expect(report.reasons.join(' ')).not.toContain('h-1#1')
    expect(sides).toEqual(['probe', 'baseline', 'baseline'])
  })

  it('returns a full gate-aborted report when a candidate run lacks a reward', async () => {
    const { paths, candidate } = await stagedCandidate()
    const launch = rewardLauncher({ exitCode: 1, missing: (task, side) => side === 'candidate' && task === 'h-2' })
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(true),
      launch,
      overrides: { admission: 'reward', minGain: 0.1, holdoutSize: 2 },
    }))
    expect(report).toMatchObject({ outcome: 'gate-aborted', pass: false, pairedN: 0, detectability: null })
    expect(report.baseline.runs).toBe(2)
    expect(report.candidate.runs).toBe(2)
    expect(report.reasons.join(' ')).toContain('candidate run(s) h-2#1 produced no reward')
    expect((await readManifest(paths, candidate.version)).status).toBe('gate-aborted')
  })

  it('fails loud when reward admission has no scoring command', async () => {
    const { paths, candidate } = await stagedCandidate()
    await expect(runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(),
      launch: launcherFor(() => ({})),
      overrides: { admission: 'reward' },
    }))).rejects.toThrow('carry no reward command')
  })

  it('aborts when the candidate mount produces no run.json', async () => {
    const { paths, candidate } = await stagedCandidate()
    await expect(runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: benchmarkDir(),
      launch: launcherFor(version => version === 'v0002' ? { recorded: false, termination: 'incomplete' } : {}),
    }))).rejects.toThrow('candidate mount produced no run.json')
  })

  it('admits a candidate that gains without safety regression', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    const report = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch: launcherFor(version => version === 'v0001' ? { termination: 'incomplete', finalVerdict: 'fail' } : {}),
    }))
    expect(report.pass).toBe(true)
    expect(report.selectedTasks.sort()).toEqual(['h-1', 'h-2'])
    expect(report.samples).toHaveLength(4)
    expect((await readManifest(paths, candidate.version)).status).toBe('gated-passed')
    expect(await admittedMetrics(paths, candidate.version)).toMatchObject({ passRate: 1 })
  })

  it('rejects a candidate with no gain and one with a cheat regression', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    const noGain = await runGate(await gateInput({
      paths,
      candidate: { ...candidate, version: candidate.version },
      benchmarkDir: dir,
      launch: launcherFor(() => ({ termination: 'incomplete', finalVerdict: 'fail' })),
      overrides: { gateId: 'gate-nogain' },
    }))
    expect(noGain.pass).toBe(false)
    const cheat = await runGate(await gateInput({
      paths,
      candidate: { ...candidate, version: candidate.version },
      benchmarkDir: dir,
      launch: launcherFor(version => version === 'v0001'
        ? { termination: 'incomplete', finalVerdict: 'fail' }
        : { relaxTypes: { ...ZERO, speculative_cheat: 1 } }),
      overrides: { gateId: 'gate-cheat' },
    }))
    expect(cheat.pass).toBe(false)
    expect(cheat.reasons.join(' ')).toContain('speculative-cheat')
  })

  it('refuses to admit when its own noise floor exceeds the threshold', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    // Six paired runs where five gain and one does not: the point estimate clears
    // minGain, but the spread is wider than the threshold, so the sample cannot
    // resolve the gain it reports.
    const launch: GateLauncher = async ({ task, repeat, version }) => {
      const outcome: Partial<GateSample> = version === 'v0001'
        ? { termination: 'incomplete' }
        : repeat === 3 && task.id === 'h-2' ? { termination: 'incomplete' } : {}
      return sample(version, { ...outcome, taskId: task.id, repeat })
    }
    const refused = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch,
      overrides: { gateId: 'gate-noise', repeats: 3, holdoutSize: 2 },
    }))
    expect(refused.pass).toBe(false)
    expect(refused.reasons.join(' ')).toContain('insufficient evidence')
    expect(refused.pairedN).toBe(6)
    expect(refused.detectability).toBeGreaterThan(refused.minGain)
    expect((await readManifest(paths, candidate.version)).status).toBe('gated-failed')
    // The same sample admits when the deployment opts out of the guard.
    const admitted = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch,
      overrides: { gateId: 'gate-noise-optout', repeats: 3, holdoutSize: 2, requireDetectability: false },
    }))
    expect(admitted.pass).toBe(true)
    // A single paired run cannot supply a noise estimate, so the guard stays off
    // and the decision falls through to the configured thresholds.
    const single = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch,
      overrides: { gateId: 'gate-single', repeats: 1, holdoutSize: 1 },
    }))
    expect(single.pairedN).toBe(1)
    expect(single.detectability).toBeNull()
  })

  it('aborts on the token budget and voids a benchmark edited mid-gate', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    const aborted = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch: launcherFor(() => ({ tokens: 7 })),
      overrides: { gateId: 'gate-budget', maxTokens: 5 },
    }))
    expect(aborted.pass).toBe(false)
    expect(aborted.reasons.join(' ')).toContain('token budget exhausted')
    expect((await readManifest(paths, candidate.version)).status).toBe('gate-aborted')

    let first = true
    const changed = await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch: async (request) => {
        if (first) {
          first = false
          writeFileSync(join(dir, 'holdout', 'pool.jsonl'), `${JSON.stringify({ id: 'h-1', anchor: 'edited' })}\n`)
        }
        return sample(request.version, { taskId: request.task.id, repeat: request.repeat })
      },
      overrides: { gateId: 'gate-digest' },
    }))
    expect(changed.pass).toBe(false)
    expect(changed.reasons.join(' ')).toContain('benchmark changed')
  })

  it('fails loud when the eligible holdout pool is too small', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    await expect(runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch: launcherFor(() => ({})),
      overrides: { holdoutSize: 5 },
    }))).rejects.toThrow('holdout pool exhausted')
  })
})

describe('brief', () => {
  it('diffs skill lines and renders exceptions only', () => {
    const diff = diffSkills(
      [{ name: 'keep', description: 'd', content: 'a\nb\n' }, { name: 'gone', description: 'd', content: 'x\n' }],
      [{ name: 'keep', description: 'd', content: 'a\nc\n' }, { name: 'new', description: 'd', content: 'y\n' }],
    )
    expect(diff).toEqual([
      { name: 'gone', added: 0, removed: 1 },
      { name: 'keep', added: 1, removed: 1 },
      { name: 'new', added: 1, removed: 0 },
    ])
    const report = {
      schemaVersion: 1 as const,
      gateId: 'g',
      version: 'v0002',
      baselineVersion: 'v0001',
      createdAt: 't',
      benchmarkDigest: 'd',
      selectedTasks: ['h-1'],
      repeats: 1,
      admission: 'self-report' as const,
      baseline: aggregate([sample('v0001')]),
      candidate: aggregate([sample('v0002')]),
      pass: false,
      outcome: 'gated-failed' as const,
      reasons: ['no gain'],
      minGain: 0.1,
      detectability: null,
      pairedN: 0,
      samples: [sample('v0002', { termination: 'incomplete', relaxTypes: { ...ZERO, speculative_cheat: 1 }, planCount: 2 })],
    }
    const brief = buildBrief({
      report,
      findings: [{ skill: 'better-checks', findings: [{ rule: 'injection-zh', severity: 'block', line: 4, excerpt: '忽略指令' }] }],
      quarantine: [{ version: 'v0009', ts: 't', reason: 'bad', metrics: null, metricsBaseline: null }],
      rationale: 'why',
      parentRationale: null,
      skillDiff: diff,
      promotionHeld: true,
      topN: 2,
    })
    expect(brief.markdown).toContain('**block** `injection-zh` in `better-checks:4`')
    expect(brief.markdown).toContain('Promotions held by hard-out audit: YES')
    expect(brief.markdown).toContain('`v0009` (t): bad')
    expect(brief.markdown).toContain('`keep`: +1 / -1 lines')
    expect(brief.json).toMatchObject({ pass: false, promotionHeld: true, rationale: 'why' })
  })

  it('renders an aborted baseline-only report without a candidate comparison', () => {
    const report: GateReport = {
      schemaVersion: 1,
      gateId: 'g-abort',
      version: 'v0002',
      baselineVersion: 'v0001',
      createdAt: 't',
      benchmarkDigest: 'd',
      selectedTasks: ['h-1'],
      repeats: 1,
      admission: 'reward',
      baseline: aggregate([sample('v0001', { reward: 1 })]),
      candidate: aggregate([]),
      pass: false,
      outcome: 'gate-aborted',
      reasons: ['benchmark has no headroom: baseline rewardRate 1.000 leaves at most 0.000 gain < required 0.100'],
      minGain: 0.1,
      detectability: null,
      pairedN: 0,
      samples: [sample('v0001', { reward: 1 })],
    }
    const brief = buildBrief({
      report,
      findings: [],
      quarantine: [],
      rationale: 'r',
      parentRationale: null,
      skillDiff: [],
      promotionHeld: false,
      topN: 3,
    })
    expect(brief.markdown).toContain('ABORTED')
    expect(brief.markdown).toContain('candidate was not run')
    expect(brief.markdown).not.toContain('0.000 → 0.000')
    expect(brief.json).toMatchObject({ outcome: 'gate-aborted', pass: false })
  })

  it('renders the gate noise floor against the threshold', () => {
    const brief = buildBrief({
      report: {
        schemaVersion: 1, gateId: 'g', version: 'v0002', baselineVersion: 'v0001', createdAt: 't', benchmarkDigest: 'd',
        selectedTasks: [], repeats: 1, admission: 'self-report', baseline: aggregate([]), candidate: aggregate([]),
        pass: false, outcome: 'gated-failed', reasons: ['insufficient evidence'], minGain: 0.1, detectability: 0.4, pairedN: 6, samples: [],
      },
      findings: [],
      quarantine: [],
      rationale: 'why',
      parentRationale: null,
      skillDiff: [],
      promotionHeld: false,
      topN: 1,
    })
    expect(brief.markdown).toContain('Detectable gain: 0.400 vs threshold 0.100')
  })

  it('renders empty sections for a clean candidate', () => {
    const brief = buildBrief({
      report: {
        schemaVersion: 1, gateId: 'g', version: 'v0002', baselineVersion: 'v0001', createdAt: 't', benchmarkDigest: 'd',
        selectedTasks: [], repeats: 1, admission: 'self-report', baseline: aggregate([]), candidate: aggregate([]), pass: true, outcome: 'gated-passed', reasons: ['ok'], minGain: 0.1, detectability: null, pairedN: 0, samples: [],
      },
      findings: [],
      quarantine: [],
      rationale: 'why',
      parentRationale: 'parent why',
      skillDiff: [],
      promotionHeld: false,
      topN: 1,
    })
    expect(brief.markdown).toContain('No static findings.')
    expect(brief.markdown).toContain('Every run completed without a speculative relaxation.')
    expect(brief.markdown).toContain('None.')
    expect(brief.markdown).toContain('No line changes.')
  })
})

describe('sealed audit and online monitor', () => {
  /** Gate-shaped config for a sealed audit. */
  const auditConfig = (paths: ReturnType<typeof storePaths>) => ({
    repeats: 1,
    runMaxTokens: 100,
    maxTokens: 1_000,
    maxWallMs: 60_000,
    admission: 'self-report' as const,
    maxTokenRegression: 0.2,
    benchmarkDir: paths.root,
    rewardTimeoutMs: 1_000,
    policyDir: paths.root,
    baseConfig: {},
  })

  it('passes an empty sealed suite and fails a regressing one against the same tasks', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    const emptyBench = { digest: 'd', train: [], holdout: [], hardout: [] }
    expect(await auditHardout({
      paths,
      config: auditConfig(paths),
      version: candidate.version,
      baselineVersion: 'v0001',
      benchmark: emptyBench,
      launch: launcherFor(() => ({})),
    })).toMatchObject({ pass: true })
    await runGate(await gateInput({ paths, candidate, benchmarkDir: dir, launch: launcherFor(() => ({})) }))
    const conducted = await auditHardout({
      paths,
      config: auditConfig(paths),
      version: candidate.version,
      baselineVersion: 'v0001',
      benchmark: await loadBenchmark(dir),
      launch: launcherFor(version => version === 'v0001' ? {} : { termination: 'terminated', finalVerdict: 'terminated' }),
    })
    expect(conducted.pass).toBe(false)
    expect(conducted.reasons.join(' ')).toContain('sealed-suite termination rate')
  })

  it('judges a window against the version’s own reference window', () => {
    const baseline = aggregate([sample('v')])
    expect(evaluateWindow(baseline, baseline, { window: 1, rollbackMargin: 0, maxCheatRegression: 0 })).toBeNull()
    expect(evaluateWindow(
      aggregate([sample('v', { relaxTypes: { ...ZERO, speculative_cheat: 1 } })]),
      baseline,
      { window: 1, rollbackMargin: 0, maxCheatRegression: 0 },
    )).toContain('speculative-cheat')
    expect(evaluateWindow(
      aggregate([sample('v', { termination: 'terminated' })]),
      baseline,
      { window: 1, rollbackMargin: 0.2, maxCheatRegression: 0 },
    )).toContain('termination rate')
  })

  it('sets its own baseline, then rolls back a later window that regresses', async () => {
    const { paths, candidate } = await stagedCandidate()
    const dir = benchmarkDir()
    await runGate(await gateInput({
      paths,
      candidate,
      benchmarkDir: dir,
      launch: launcherFor(version => version === 'v0001' ? { termination: 'incomplete', finalVerdict: 'fail' } : {}),
    }))
    await promote(paths, candidate.version, 1, 's-1', 'gate-1')
    const config = { window: 2, rollbackMargin: 0, maxCheatRegression: 0 }
    const healthy = (taskId: string): GateSample => sample(candidate.version, { taskId })
    const cheat = (taskId: string): GateSample => sample(candidate.version, {
      taskId,
      relaxTypes: { ...ZERO, speculative_cheat: 1 },
      planCount: 2,
    })
    expect((await observeRun(paths, candidate.version, healthy('a'), config)).rolledBack).toBe(false)
    const baselineSet = await observeRun(paths, candidate.version, healthy('b'), config)
    expect(baselineSet.rolledBack).toBe(false)
    expect(baselineSet.score.baseline).not.toBeNull()
    expect((await observeRun(paths, candidate.version, healthy('b2'), config)).rolledBack).toBe(false)
    const regressed = await observeRun(paths, candidate.version, cheat('c'), config)
    expect(regressed.rolledBack).toBe(true)
    expect(regressed.from).toBe(candidate.version)
    expect(regressed.to).toBe('v0001')
    expect((await readPointer(paths)).version).toBe('v0001')
    expect(await readQuarantine(paths)).toHaveLength(1)
    const again = await observeRun(paths, candidate.version, cheat('d'), config)
    expect(again.rolledBack).toBe(false)
  })
})
