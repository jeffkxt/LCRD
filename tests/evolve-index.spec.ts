/**
 * Policy-evolution wiring: inert mode, load-time refusals, candidate mounting,
 * the registered proposal tool, activation plus sealed audit, and the online
 * rollback. The gate launcher is mocked so no child process is spawned.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FlowRecorder } from '../src/flow.ts'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { registerEvolve, type EvolveSettings } from '../src/evolve/index.ts'
import {
  ensureStore,
  promote,
  readManifest,
  readPointer,
  readPolicyTrace,
  setGateOutcome,
  setStatus,
  stageVersion,
  storePaths,
} from '../src/evolve/store.ts'
import type { GateSample } from '../src/evolve/types.ts'

const hardoutState = vi.hoisted(() => ({ failing: true }))

vi.mock('../src/evolve/launch.ts', () => ({
  createGateLauncher: () => async (request: {
    task: { id: string; suite: string }
    repeat: number
    version: string
  }): Promise<GateSample> => {
    const hardout = request.task.suite === 'hardout'
    const baseline = request.version === 'v0001'
    return {
      taskId: request.task.id,
      repeat: request.repeat,
      version: request.version,
      recorded: true,
      reward: null,
      termination: hardout ? (baseline || !hardoutState.failing ? 'completed' : 'terminated') : baseline ? 'incomplete' : 'completed',
      finalVerdict: hardout ? (baseline || !hardoutState.failing ? 'pass' : 'terminated') : baseline ? 'fail' : 'pass',
      relaxTypes: { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 },
      planCount: 1,
      tokens: 5,
      hookInterceptions: 0,
      pathViolations: 0,
    }
  },
}))

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A benchmark root with one holdout task and one sealed task. */
function benchmarkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-evolve-bench-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'holdout'))
  mkdirSync(join(dir, 'hardout'))
  writeFileSync(join(dir, 'train.jsonl'), `${JSON.stringify({ id: 't', anchor: 'train' })}\n`)
  writeFileSync(join(dir, 'holdout', 'pool.jsonl'), [
    JSON.stringify({ id: 'h-1', anchor: 'one' }),
    JSON.stringify({ id: 'h-2', anchor: 'two' }),
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'hardout', 'sealed.jsonl'), `${JSON.stringify({ id: 's-1', anchor: 'sealed' })}\n`)
  return dir
}

/** One policy root with an optional staged candidate. */
async function storeRoot(): Promise<{ paths: ReturnType<typeof storePaths>; version: string | null }> {
  const root = mkdtempSync(join(tmpdir(), 'lcrd-evolve-store-'))
  dirs.push(root)
  const paths = storePaths(join(root, 'policy'))
  await ensureStore(paths)
  return { paths, version: null }
}

/** Stage a candidate on top of v0001. */
async function stage(paths: ReturnType<typeof storePaths>): Promise<string> {
  const manifest = await stageVersion(paths, {
    parent: 'v0001',
    authorSession: 's',
    rationale: 'r',
    benchmarkDigest: 'd',
    skills: [{ name: 'policy-skill', description: 'd', content: '# body\n' }],
  })
  await setGateOutcome(paths, manifest.version, 'gate-1', 'd', 'gated-passed')
  mkdirSync(join(paths.versions, manifest.version, 'gate', 'gate-1'), { recursive: true })
  writeFileSync(join(paths.versions, manifest.version, 'gate', 'gate-1', 'report.json'), JSON.stringify({ pass: true, benchmarkDigest: 'd', candidate: { passRate: 1, terminatedRate: 0, cheatRate: 0, hookInterceptions: 0, pathViolations: 0, tokens: 5, runs: 1 } }))
  return manifest.version
}

/** Full settings for one test. */
function settings(paths: ReturnType<typeof storePaths>, overrides: Partial<EvolveSettings> = {}): EvolveSettings {
  return {
    enabled: false,
    policyDir: paths.root,
    benchmarkDir: undefined,
    gateCommand: 'dsh',
    gateArgs: [],
    gateProfile: 'headless',
    gateRunTimeoutMs: 1000,
    repeats: 1,
    holdoutSize: 1,
    holdoutCooldown: 0,
    hardoutAuditEvery: 1,
    minGain: 0.1,
    maxSafetyRegression: 0,
    maxCheatRegression: 0,
    gateMaxTokens: 10_000,
    gateMaxWallMs: 60_000,
    runMaxTokens: 1_000,
    promote: 'auto',
    admission: 'self-report',
    significance: 'off',
    significanceAlpha: 0.05,
    maxTokenRegression: 0.2,
    maxProposals: 1,
    maxSkills: 8,
    skillMaxBytes: 512,
    rationaleMax: 2_000,
    staticScan: 'rules',
    scanModel: undefined,
    briefTopN: 2,
    rollbackWindow: 1,
    rollbackMargin: 0.9,
    candidateVersion: undefined,
    baseConfig: {},
    ...overrides,
  }
}

/** Mount tools and skills, then run the wiring inside an injected plugin scope. */
async function mount(
  _paths: ReturnType<typeof storePaths>,
  config: EvolveSettings,
  logs: string[] = [],
): Promise<{ ctx: Context; runtime: Awaited<ReturnType<typeof registerEvolve>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const recorder = {
    log: (line: string) => { logs.push(line) },
    computeRunMeta: () => ({
      task_id: 'task-1',
      termination: 'completed',
      final_verdict: 'pass',
      relax_types: { spec_adjust: 0, environment_fault: 0, speculative_cheat: 1 },
      plan_count: 2,
      tokens: 3,
      hook_interceptions: 0,
      path_violations: 0,
    }),
  } as never
  let runtime: Awaited<ReturnType<typeof registerEvolve>> | undefined
  await ctx.plugin({
    inject: ['tools', 'skills'],
    async apply(scope: Context) {
      runtime = await registerEvolve({
        ctx: scope,
        settings: config,
        cwd: dirs[0] ?? process.cwd(),
        ensureFlow: () => recorder,
      })
    },
  })
  if (runtime === undefined) throw new Error('wiring did not run')
  return { ctx, runtime }
}

/** One stable agent, so the per-agent proposal budget accumulates across calls. */
const AGENT = { id: 'agent-1', session: { header: {}, events: [] }, options: {} } as never

/** One recorder whose run metadata carries the given cheat count. */
function makeRecorder(cheats: number, logs: string[] = []): FlowRecorder {
  return {
    log: (line: string) => { logs.push(line) },
    computeRunMeta: () => ({
      task_id: 'task-1',
      termination: 'completed',
      final_verdict: 'pass',
      relax_types: { spec_adjust: 0, environment_fault: 0, speculative_cheat: cheats },
      plan_count: 2,
      tokens: 3,
      hook_interceptions: 0,
      path_violations: 0,
    }),
  } as never
}

/** One proposal call. */
async function propose(
  ctx: Context,
  input: { parent?: string; skill?: string } = {},
): Promise<{ isError: boolean; text: string }> {
  const result = await ctx.tools.execute({
    callId: ToolCallId(`propose-${Math.random().toString(36).slice(2, 8)}`),
    name: 'lcrd_propose',
    arguments: {
      rationale: 'better',
      parent_version: input.parent ?? 'v0001',
      skills: [{ name: input.skill ?? 'better-checks', description: 'desc', content: '# better\n' }],
    },
    signal: new AbortController().signal,
    agent: AGENT,
  })
  return { isError: result.isError, text: result.content.map(block => block.type === 'text' ? block.text : '').join('\n') }
}

describe('policy evolution wiring', () => {
  it('is inert when disabled and no candidate is mounted', async () => {
    const { paths } = await storeRoot()
    const runtime = await registerEvolve({
      ctx: new Context(),
      settings: settings(paths),
      cwd: process.cwd(),
      ensureFlow: () => ({}) as never,
    })
    expect(runtime.policyVersion).toBeNull()
    await runtime.observeRun({} as never, {} as never)
    runtime.resetProposals({} as never)
  })

  it('refuses an incoherent configuration and a quarantined candidate', async () => {
    const { paths } = await storeRoot()
    await expect(registerEvolve({
      ctx: new Context(),
      settings: settings(paths, { enabled: true }),
      cwd: process.cwd(),
      ensureFlow: () => ({}) as never,
    })).rejects.toThrow('evolveBenchmarkDir')
    await expect(registerEvolve({
      ctx: new Context(),
      settings: settings(paths, { enabled: true, benchmarkDir: benchmarkDir(), runMaxTokens: 20_000 }),
      cwd: process.cwd(),
      ensureFlow: () => ({}) as never,
    })).rejects.toThrow('must not exceed')
    const version = await stage(paths)
    await setStatus(paths, version, 'quarantined')
    await expect(registerEvolve({
      ctx: new Context(),
      settings: settings(paths, { candidateVersion: version }),
      cwd: process.cwd(),
      ensureFlow: () => ({}) as never,
    })).rejects.toThrow('is quarantined')
  })

  it('mounts a candidate without registering the proposal tool', async () => {
    const { paths } = await storeRoot()
    const version = await stage(paths)
    const { ctx, runtime } = await mount(paths, settings(paths, { candidateVersion: version }))
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toContain('policy-skill')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('lcrd_propose')
    await runtime.observeRun({} as never, {} as never)
  })

  it('registers the proposal tool, promotes, audits, and holds', async () => {
    const { paths } = await storeRoot()
    const logs: string[] = []
    const { ctx, runtime } = await mount(paths, settings(paths, { enabled: true, benchmarkDir: benchmarkDir() }), logs)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('lcrd_propose')
    const first = await propose(ctx)
    expect(first.isError).toBe(false)
    expect(first.text).toContain('promote')
    expect((await readPointer(paths)).version).toBe('v0002')
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toContain('better-checks')
    // The sealed audit ran on promotion and found a terminated hard-out run.
    expect((await readPointer(paths)).promotionHeld).toBe(true)
    expect(logs.some(line => line.includes('policy promoted'))).toBe(true)
    expect(logs).toContain('[SYSTEM NOTICE] LCRD Policy Promoted: v0001 -> v0002 (Reason: gate_passed). Active policy switched.')
    expect(runtime.policyVersion).toBe('v0002')
    const trace = await readPolicyTrace(paths)
    expect(trace.some(entry => entry['action'] === 'promoted' && entry['version'] === 'v0002'
      && String(entry['detail']).includes('v0001 -> v0002'))).toBe(true)
  })

  it('resets the proposal budget at a task boundary', async () => {
    const { paths } = await storeRoot()
    const { ctx, runtime } = await mount(paths, settings(paths, { enabled: true, benchmarkDir: benchmarkDir() }))
    expect((await propose(ctx)).isError).toBe(false)
    expect((await propose(ctx)).text).toContain('上限 1')
    runtime.resetProposals({} as never)
  })

  it('folds a finished run, rolls back a regressing version, and delivers the notice', async () => {
    const { paths } = await storeRoot()
    const version = await stage(paths)
    await promote(paths, version, 1, 's', 'gate-1')
    const logs: string[] = []
    const { ctx, runtime } = await mount(paths, settings(paths, {
      enabled: true,
      benchmarkDir: benchmarkDir(),
      rollbackWindow: 1,
      maxCheatRegression: 0,
    }), logs)
    const agent = { id: 'agent-rollback', session: { header: {} }, options: {} } as never
    await runtime.observeRun(agent, makeRecorder(0, logs))
    await runtime.observeRun(agent, makeRecorder(1, logs))
    expect((await readPointer(paths)).version).toBe('v0001')
    expect(runtime.policyVersion).toBe('v0001')
    const notice = logs.find(line => line.startsWith('[SYSTEM NOTICE] LCRD Policy Rolled Back:'))
    expect(notice).toContain('v0002 -> v0001')
    const trace = await readPolicyTrace(paths)
    expect(trace.some(entry => entry['action'] === 'rolled-back' && entry['version'] === 'v0001'
      && String(entry['detail']).includes('v0002 -> v0001'))).toBe(true)
    // The queued notice rides the next tool decision, then clears.
    const decision = await ctx.waterfall('tools/post-execute', { name: 'probe', agent } as never, { value: 1, isError: false, content: [] }, async () => ({ kind: 'accept' as const, value: 1 }))
    expect(JSON.stringify(decision)).toContain('[SYSTEM NOTICE] LCRD Policy Rolled Back: v0002 -> v0001')
    const next = await ctx.waterfall('tools/post-execute', { name: 'probe', agent } as never, { value: 1, isError: false, content: [] }, async () => ({ kind: 'accept' as const, value: 1 }))
    expect(JSON.stringify(next)).not.toContain('[SYSTEM NOTICE]')
    const noAgent = await ctx.waterfall('tools/post-execute', { name: 'probe' } as never, { value: 1, isError: false, content: [] }, async () => ({ kind: 'accept' as const, value: 1 }))
    expect(JSON.stringify(noAgent)).not.toContain('[SYSTEM NOTICE]')
  })

  it('records a passing sealed audit without holding promotions', async () => {
    hardoutState.failing = false
    try {
      const { paths } = await storeRoot()
      const { ctx } = await mount(paths, settings(paths, {
        enabled: true,
        benchmarkDir: benchmarkDir(),
        hardoutAuditEvery: 1,
      }))
      expect((await propose(ctx)).isError).toBe(false)
      expect((await readPointer(paths)).promotionHeld).toBe(false)
      const events = readFileSync(join(paths.root, 'policy-events.jsonl'), 'utf8')
      expect(events).toContain('"action":"audit"')
    } finally {
      hardoutState.failing = true
    }
  })

  it('skips the sealed audit off cadence', async () => {
    const { paths } = await storeRoot()
    const { ctx } = await mount(paths, settings(paths, {
      enabled: true,
      benchmarkDir: benchmarkDir(),
      hardoutAuditEvery: 2,
    }))
    expect((await propose(ctx)).isError).toBe(false)
    expect((await readPointer(paths)).promotionHeld).toBe(false)
    const events = readFileSync(join(paths.root, 'policy-events.jsonl'), 'utf8')
    expect(events).not.toContain('"action":"audit"')
  })

  it('ignores a store failure while folding an online run', async () => {
    const { paths } = await storeRoot()
    const version = await stage(paths)
    await promote(paths, version, 1, 's', 'gate-1')
    const { runtime } = await mount(paths, settings(paths, { enabled: true, benchmarkDir: benchmarkDir() }))
    await runtime.observeRun({} as never, makeRecorder(0))
    rmSync(paths.current)
    await expect(runtime.observeRun({} as never, makeRecorder(1))).resolves.toBeUndefined()
  })

  it('keeps the reverted pointer when parent skills cannot be restored', async () => {
    const { paths } = await storeRoot()
    const version = await stage(paths)
    await promote(paths, version, 1, 's', 'gate-1')
    const parent = await readManifest(paths, 'v0001')
    writeFileSync(join(paths.versions, 'v0001', 'manifest.json'), JSON.stringify({
      ...parent,
      skills: [{ name: 'missing-skill', description: 'd', digest: 'x', bytes: 1 }],
    }))
    const logs: string[] = []
    const { runtime } = await mount(paths, settings(paths, {
      enabled: true,
      benchmarkDir: benchmarkDir(),
      rollbackWindow: 1,
      maxCheatRegression: 0,
    }), logs)
    await runtime.observeRun({} as never, makeRecorder(0, logs))
    await runtime.observeRun({} as never, makeRecorder(1, logs))
    expect((await readPointer(paths)).version).toBe('v0001')
  })
})
