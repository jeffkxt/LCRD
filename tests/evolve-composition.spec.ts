/**
 * In-process composition coverage: token accounting across the recorder's
 * lifetime and the candidate run-budget termination. Child processes are not
 * instrumented, so these paths need a real in-process plugin.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as lcrd from '@deepseek-ai/dsh-experimental-lcrd'
import { ensureStore, promote, readPointer, setGateOutcome, stageVersion, storePaths } from '../src/evolve/store.ts'

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** One fake agent with a session object usable as a WeakMap key. */
function fakeAgent(id: string) {
  return { id, session: { header: {}, events: [] }, options: {} }
}

/** Mount the plugin over real services. */
async function mount(config: Record<string, unknown>, workDir: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: workDir })
  await ctx.plugin(lcrd, config)
  return ctx
}

/** Emit one session event through the plugin listener. */
function emit(ctx: Context, session: unknown, event: unknown): void {
  Reflect.apply(Reflect.get(ctx, 'emit') as (...args: unknown[]) => void, ctx, ['session/event', session, event])
}

/** Execute one tool with the fake agent. */
async function runTool(ctx: Context, name: string, args: Record<string, unknown>, agent: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`cov-${Math.random().toString(36).slice(2, 8)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: agent as never,
  })
}

/** The newest run.json under one log root. */
function readRunMeta(logDir: string): Record<string, unknown> {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'run.json') found.push(path)
    }
  }
  walk(logDir)
  const newest = found.sort().at(-1)
  if (newest === undefined) throw new Error(`no run.json under ${logDir}`)
  return JSON.parse(readFileSync(newest, 'utf8')) as Record<string, unknown>
}

const usageEvent = (usage: Record<string, unknown>) => ({
  type: 'assistant/message',
  data: { message: { content: [] }, usage },
})

describe('in-process evolution paths', () => {
  it('folds pending and live token usage into run.json', async () => {
    const base = scratch('lcrd-cov-usage-')
    const logDir = join(base, 'log')
    mkdirSync(logDir)
    mkdirSync(join(base, 'work'))
    const ctx = await mount({ logDir, interaction: 'auto' }, join(base, 'work'))
    const agent = fakeAgent('agent-usage')
    // Usage before any recorder exists is held as pending.
    emit(ctx, agent.session, usageEvent({ totalTokens: 7 }))
    emit(ctx, agent.session, usageEvent({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1 }))
    emit(ctx, agent.session, usageEvent({ inputTokens: 'ignored', outputTokens: -1 }))
    // A protocol step creates the recorder, folding the pending total (14).
    await runTool(ctx, 'lcrd_plan', {
      goal: 'usage',
      stop_condition: 'done',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }, agent)
    // Usage after creation goes straight to the recorder.
    emit(ctx, agent.session, usageEvent({ totalTokens: 5 }))
    emit(ctx, agent.session, { type: 'turn/end', data: {} })
    const run = readRunMeta(logDir)
    expect(run['tokens']).toBe(19)
  })

  it('terminates a candidate-mounted run when its token budget is spent', async () => {
    const base = scratch('lcrd-cov-budget-')
    const logDir = join(base, 'log')
    mkdirSync(logDir)
    mkdirSync(join(base, 'work'))
    const paths = storePaths(join(base, 'policy'))
    await ensureStore(paths)
    const manifest = await stageVersion(paths, {
      parent: 'v0001',
      authorSession: 'cov',
      rationale: 'cov',
      benchmarkDigest: 'cov',
      skills: [{ name: 'cov-skill', description: 'cov', content: '# cov\n' }],
    })
    const ctx = await mount({
      logDir,
      interaction: 'auto',
      evolvePolicyDir: paths.root,
      evolveCandidateVersion: manifest.version,
      evolveRunMaxTokens: 1,
    }, join(base, 'work'))
    const agent = fakeAgent('agent-budget')
    emit(ctx, agent.session, usageEvent({ totalTokens: 9 }))
    const result = await runTool(ctx, 'lcrd_plan', {
      goal: 'budget',
      stop_condition: 'done',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }, agent)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('token 预算已用尽')
    const run = readRunMeta(logDir)
    expect(run['policy_version']).toBe(manifest.version)
    expect(run['termination']).toBe('terminated')
  })

  it('keeps a candidate run alive while it stays under its token budget', async () => {
    const base = scratch('lcrd-cov-budget-ok-')
    const logDir = join(base, 'log')
    mkdirSync(logDir)
    mkdirSync(join(base, 'work'))
    const paths = storePaths(join(base, 'policy'))
    await ensureStore(paths)
    const manifest = await stageVersion(paths, {
      parent: 'v0001',
      authorSession: 'cov',
      rationale: 'cov',
      benchmarkDigest: 'cov',
      skills: [{ name: 'cov-skill', description: 'cov', content: '# cov\n' }],
    })
    const ctx = await mount({
      logDir,
      interaction: 'auto',
      evolvePolicyDir: paths.root,
      evolveCandidateVersion: manifest.version,
      evolveRunMaxTokens: 1_000,
    }, join(base, 'work'))
    const agent = fakeAgent('agent-budget-ok')
    emit(ctx, agent.session, usageEvent({ totalTokens: 9 }))
    const result = await runTool(ctx, 'lcrd_plan', {
      goal: 'budget-ok',
      stop_condition: 'done',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }, agent)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).not.toContain('token 预算已用尽')
  })

  it('freezes the current policy version into each new run', async () => {
    const base = scratch('lcrd-cov-policy-version-')
    const work = join(base, 'work')
    mkdirSync(work)
    const paths = storePaths(join(base, 'policy'))
    await ensureStore(paths)
    const bench = join(base, 'benchmark')
    mkdirSync(join(bench, 'holdout'), { recursive: true })
    mkdirSync(join(bench, 'hardout'), { recursive: true })
    writeFileSync(join(bench, 'train.jsonl'), '')
    writeFileSync(join(bench, 'holdout', 'pool.jsonl'), `${JSON.stringify({ id: 'h-1', anchor: 'a' })}\n`)

    /** Stage, gate, and promote the next policy version. */
    const promoteNext = async (parent: string, skill: string): Promise<string> => {
      const manifest = await stageVersion(paths, {
        parent,
        authorSession: 'cov',
        rationale: 'cov',
        benchmarkDigest: 'd',
        skills: [{ name: skill, description: 'd', content: `# ${skill}\n` }],
      })
      await setGateOutcome(paths, manifest.version, 'gate-cov', 'd', 'gated-passed')
      await promote(paths, manifest.version, (await readPointer(paths)).revision, 'cov', 'gate-cov')
      return manifest.version
    }
    const runPlan = async (logDir: string, agent: ReturnType<typeof fakeAgent>): Promise<Record<string, unknown>> => {
      mkdirSync(logDir, { recursive: true })
      const ctx = await mount({
        logDir,
        interaction: 'auto',
        evolveEnabled: true,
        evolvePolicyDir: paths.root,
        evolveBenchmarkDir: bench,
      }, work)
      await runTool(ctx, 'lcrd_plan', {
        goal: 'policy version',
        stop_condition: 'done',
        feasibility: true,
        verifier: { kind: 'assert', conditions: ['result !== undefined'] },
      }, agent)
      emit(ctx, agent.session, { type: 'turn/end', data: {} })
      return readRunMeta(logDir)
    }

    const two = await promoteNext('v0001', 'skill-two')
    const first = await runPlan(join(base, 'log-a'), fakeAgent('agent-policy-a'))
    expect(first['policy_version']).toBe(two)

    const three = await promoteNext(two, 'skill-three')
    const second = await runPlan(join(base, 'log-b'), fakeAgent('agent-policy-b'))
    expect(second['policy_version']).toBe(three)
  })
})
