/**
 * Learning mode and the protocol gates over the real composition: entry at the
 * failure threshold, the learn phase, self-evaluation, re-solve, termination,
 * and the notices each transition delivers.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { HarnessError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as lcrd from '@deepseek-ai/dsh-experimental-lcrd'
import {
  FlowRecorder,
} from '@deepseek-ai/dsh-experimental-lcrd'
// Pulls the package entry so its MessageSourceMap augmentation is in scope for createUserMessage sources below.
import '@deepseek-ai/dsh-experimental-lcrd'

/** Contexts created by setup helpers; disposed after each test so process-exit listeners do not accumulate. */
const openContexts: Context[] = []

interface CompositionEvent {
  type: string
  name?: string
  tool?: string
  callId?: string
  resultKind?: string
  errorMessage?: string
  errorCode?: string
  verifierKind?: string
  exceptionKind?: string
  goal?: string
  stop?: string
  feasibility?: boolean
  verifierSpec?: unknown
  kind?: string
  detail?: string
  context?: { failures: number; phase: string; lastPass: boolean | null; lastReason: string | null; invalidChecks: number }
  pass?: boolean
  count?: number
  predictionMissed?: boolean
  relaxation?: string[]
  strictness?: { mode?: string; discrimination?: string }
}

/** Read the recorded events of the single run folder under a flow-log directory. */
function readCompositionStream(logDir: string): CompositionEvent[] {
  const folders = readdirSync(logDir)
  expect(folders).toHaveLength(1)
  return readFileSync(join(logDir, folders[0] as string, 'lcrd-flow.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as CompositionEvent)
}

/** Read the dumped snapshot of the single run folder under a flow-log directory. */
function readCompositionSnapshot(logDir: string): { prediction_misses: number; plan_count: number; lcrd_retry_consumed: number } {
  const folders = readdirSync(logDir)
  expect(folders).toHaveLength(1)
  return JSON.parse(readFileSync(join(logDir, folders[0] as string, 'lcrd-flow.json'), 'utf8')) as { prediction_misses: number; plan_count: number; lcrd_retry_consumed: number }
}

describe('learning mode and protocol gates (real composition)', () => {
  const agentSession = { header: {}, events: [] }
  const agent = { id: 'agent-learning', session: agentSession, options: {} } as never
  /** Loose emit helper: test fixtures are not full Session/SessionEvent instances. */
  const fireEvent = (ctx: Context, name: string, ...args: unknown[]): void => {
    const emit: unknown = Reflect.get(ctx, 'emit')
    if (typeof emit !== 'function') throw new Error('test context has no emit')
    Reflect.apply(emit, ctx, [name, ...args])
  }
  const dirs: string[] = []

  /** Mount the plugin with learning enabled at a low threshold plus the file and learning fixture tools. */
  async function setupLearning(options?: { maxLearningAttempts?: number; interaction?: 'auto' | 'auth' | 'manual'; learningEnabled?: boolean; maxRetries?: number; failedCheckConsumesRetry?: boolean; datasetExport?: 'off' | 'run'; datasetDir?: string; attributionModule?: string; hooksModule?: string; rejectPresenceOnly?: boolean; declarationMaxHoldRate?: number }) {
    const base = mkdtempSync(join(tmpdir(), 'lcrd-learn-'))
    const workDir = join(base, 'work')
    const logDir = join(base, 'log')
    mkdirSync(workDir)
    mkdirSync(logDir)
    const flowRoot = join(base, 'task-flow')
    dirs.push(base)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    await ctx.plugin(lcrd, {
      fileFlowEnabled: true,
      logDir,
      maxRetries: options?.maxRetries ?? 3,
      learningEnabled: options?.learningEnabled ?? true,
      learningThreshold: 2,
      maxLearningAttempts: options?.maxLearningAttempts ?? 2,
      interaction: options?.interaction ?? 'auto',
      ...(options?.failedCheckConsumesRetry === undefined ? {} : { failedCheckConsumesRetry: options.failedCheckConsumesRetry }),
      ...(options?.datasetExport === undefined ? {} : { datasetExport: options.datasetExport }),
      ...(options?.datasetDir === undefined ? {} : { datasetDir: options.datasetDir }),
      ...(options?.attributionModule === undefined ? {} : { attributionModule: options.attributionModule }),
      ...(options?.hooksModule === undefined ? {} : { hooksModule: options.hooksModule }),
      ...(options?.rejectPresenceOnly === undefined ? {} : { rejectPresenceOnly: options.rejectPresenceOnly }),
      ...(options?.declarationMaxHoldRate === undefined ? {} : { declarationMaxHoldRate: options.declarationMaxHoldRate }),
    })
    openContexts.push(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'str_replace_editor',
      description: 'editor fixture',
      parameters: { path: { type: 'string', required: true } },
      async execute() {
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    for (const name of ['read', 'glob', 'ask_user_question']) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: `${name} fixture`,
        parameters: { path: { type: 'string' } },
        async execute() {
          return [{ type: 'text', text: `${name} ok` }]
        },
      }))
    }
    return { ctx, workDir, logDir, flowRoot }
  }

  afterEach(async () => {
    for (const ctx of openContexts.splice(0)) await ctx.fiber.dispose()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function runTool(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: ToolCallId(`learn-${Math.random().toString(36).slice(2, 8)}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent,
    })
    return {
      isError: result.isError,
      text: result.content.map(block => block.type === 'text' ? block.text : '').join('\n'),
    }
  }

  /**
   * Declare a plan whose assert can never pass, driving one verifier failure.
   * Distinct attempts keep each redeclaration a new method for L4.
   */
  async function declareFailingPlan(ctx: Context, attempt = 0): Promise<void> {
    const failValue = 999 - attempt
    await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败',
      stop_condition: `结果等于 ${failValue}`,
      feasibility: true,
      verifier: { kind: 'assert', conditions: [`result === ${failValue}`] },
    })
  }

  async function declarePassingPlan(ctx: Context): Promise<void> {
    const outcome = await runTool(ctx, 'lcrd_plan', {
      goal: '必然成功',
      stop_condition: '结果非空',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(outcome.isError).toBe(false)
  }

  /** Write one policy-hook module and return its path. */
  function writeHooksModule(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-hooks-'))
    dirs.push(dir)
    const modulePath = join(dir, 'hooks.mjs')
    writeFileSync(modulePath, source, 'utf8')
    return modulePath
  }

  /** Declare one passing plan against the fixture read tool and run it. */
  async function planAndRead(ctx: Context, workDir: string): Promise<{ isError: boolean; text: string }> {
    await declarePassingPlan(ctx)
    return await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
  }

  it('drives verifier failures into learning mode and through a full round', async () => {
    const { ctx, workDir } = await setupLearning({ maxLearningAttempts: 3 })
    const product = join(workDir, 'f.py')
    await declareFailingPlan(ctx, 0)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx, 1)
    const entered = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(entered.isError).toBe(true)
    expect(entered.text).toContain('学习模式')
    // Declare a learning round.
    const learn = await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '条件写错',
      knowledge_needed: '校验器语义',
      learning_method: '读文件',
      eval_criteria: '能写出合法条件',
    })
    expect(learn.isError).toBe(false)
    // Learn phase: task tools and lcrd_plan are blocked.
    const taskTool = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(taskTool.isError).toBe(true)
    expect(taskTool.text).toContain('学习阶段仅允许学习工具')
    const planBlocked = await runTool(ctx, 'lcrd_plan', {
      goal: '重解',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(planBlocked.isError).toBe(true)
    expect(planBlocked.text).toContain('学习阶段禁止声明任务计划')
    // Self-evaluation: without evidence refused (before any learning tool ran), failed consumes an attempt.
    const noEvidence = await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: '凭感觉' })
    expect(noEvidence.isError).toBe(false)
    expect(noEvidence.text).toContain('自评不能通过')
    const failed = await runTool(ctx, 'lcrd_learn_verify', { learned: false, evidence: '还没学会' })
    expect(failed.isError).toBe(false)
    expect(failed.text).toContain('自评未通过(第 1/3 轮)')
    // A learning tool now supplies evidence.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'doc.md') })).isError).toBe(false)
    // A self-evaluation that cites no recorded knowledge is refused without consuming a round.
    const uncited = await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: '凭感觉' })
    expect(uncited.isError).toBe(false)
    expect(uncited.text).toContain('未引用本轮登记的任何知识')
    expect(uncited.text).toContain('e1')
    // New round with evidence passes and returns to resolve phase.
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '再学一轮',
      knowledge_needed: '写法',
      learning_method: '读文件',
      eval_criteria: '写出正确条件',
    })
    await runTool(ctx, 'glob', { path: join(workDir, '**') })
    const passed = await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: 'e1 已会' })
    expect(passed.isError).toBe(false)
    expect(passed.text).toContain('自评通过')
    // Re-solve failure consumes one learning round, resets the phase, and returns to learn mode.
    await declareFailingPlan(ctx, 2)
    const roundFail = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(roundFail.isError).toBe(true)
    expect(roundFail.text).toContain('学习后重解仍失败(第 2/3 轮)')
    // A second re-solve failure exhausts the budget into termination.
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '耗尽',
      knowledge_needed: '无',
      learning_method: '反思',
      eval_criteria: '无',
    })
    await runTool(ctx, 'read', { path: join(workDir, 'doc.md') })
    await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: 'e1 学会了' })
    await declareFailingPlan(ctx, 3)
    const exhausted = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(exhausted.isError).toBe(true)
    expect(exhausted.text).toContain('学习次数已用尽')
    expect(exhausted.text).toContain('任务已终止转人工')
    // Terminated: later tool calls are blocked outright.
    const blocked = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('任务已终止')
  })

  it('terminates when two failed self-evaluations exhaust the budget, and resets on a user command', async () => {
    const { ctx, workDir } = await setupLearning({ maxLearningAttempts: 2 })
    const product = join(workDir, 'f.py')
    await declareFailingPlan(ctx, 0)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx, 1)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
    })
    const first = await runTool(ctx, 'lcrd_learn_verify', { learned: false, evidence: '第一次' })
    expect(first.text).toContain('自评未通过(第 1/2 轮)')
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
    })
    const exhausted = await runTool(ctx, 'lcrd_learn_verify', { learned: false, evidence: '第二次' })
    // The execute handler terminated the agent; the post-execute gate then blocks
    // this very call with the terminated feedback.
    expect(exhausted.isError).toBe(true)
    expect(exhausted.text).toContain('任务已终止')
    // A new user command resets the termination and re-fires the launch gate.
    void ctx.waterfall(agent, 'agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'user' as const } })], turn: 1, step: 0, signal: new AbortController().signal }, () => ({ kind: 'allow' } as never))
    const gated = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(gated.text).toContain('任务目录已自动创建')
  })

  it('marks verifier exceptions on evaluation failures', async () => {
    const { ctx, workDir } = await setupLearning({ learningEnabled: false })
    const product = join(workDir, 'f.py')
    await runTool(ctx, 'lcrd_plan', {
      goal: '求值失败',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result.foo.bar'] },
    })
    const outcome = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('断言求值失败')
  })

  it('supports agents whose id carries the session- prefix', async () => {
    const { ctx, workDir } = await setupLearning({ learningEnabled: false })
    const sessionAgent = { id: 'session-xyz-1234', session: { header: {}, events: [] }, options: {} } as never
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: ToolCallId('session-agent'),
      name: 'str_replace_editor',
      arguments: { path: join(workDir, 'f.py'), command: 'create' },
      signal: new AbortController().signal,
      agent: sessionAgent,
    })
    expect(result.isError).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('\n')).toContain('任务目录已自动创建')
  })

  it('completes a task through a post-learning re-solve and resets the learning budget', async () => {
    const { ctx, workDir } = await setupLearning()
    const product = join(workDir, 'f.py')
    await declareFailingPlan(ctx, 0)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx, 1)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '写法',
      knowledge_needed: '语义',
      learning_method: '读文件',
      eval_criteria: '写出合法条件',
    })
    await runTool(ctx, 'read', { path: join(workDir, 'doc.md') })
    await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: 'e1 已会' })
    await declarePassingPlan(ctx)
    const passed = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(passed.isError).toBe(false)
  })

  it('rejects learning tools outside learning mode, and does not register them when learning is off', async () => {
    const { ctx } = await setupLearning()
    const learn = await runTool(ctx, 'lcrd_learn', {
      problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
    })
    expect(learn.isError).toBe(true)
    expect(learn.text).toContain('只能在学习模式')
    const verify = await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: 'e' })
    expect(verify.isError).toBe(true)
    expect(verify.text).toContain('只能在学习模式')
    const { ctx: off } = await setupLearning({ learningEnabled: false })
    const unknown = await runTool(off, 'lcrd_learn', {
      problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
    })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('unknown tool')
  })

  it('blocks tools without a plan, blocks infeasible plans, and auto-answers questions in auto mode', async () => {
    const { ctx, workDir } = await setupLearning({ learningEnabled: false })
    const product = join(workDir, 'f.py')
    // First call creates and pins the task directory (guidance denial); the
    // second call reaches the missing-plan gate.
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    const missing = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('未声明子任务计划')
    // An empty path skips the file-flow guard entirely.
    const emptyPath = await runTool(ctx, 'str_replace_editor', { path: '', command: 'create' })
    expect(emptyPath.isError).toBe(true)
    expect(emptyPath.text).toContain('未声明子任务计划')
    const infeasible = await runTool(ctx, 'lcrd_plan', {
      goal: '不可行', stop_condition: 'x', feasibility: false, verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(infeasible.isError).toBe(false)
    const blocked = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('feasibility=false')
    // Auto-answer intercepts a model question.
    await declarePassingPlan(ctx)
    const asked = await runTool(ctx, 'ask_user_question', { question: '需要确认吗' })
    expect(asked.isError).toBe(true)
    expect(asked.text).toContain('自动模式无法人工应答')
  })

  it('rejects malformed lcrd_plan arguments at the tool schema boundary', async () => {
    const { ctx } = await setupLearning({ learningEnabled: false })
    const badGoal = await runTool(ctx, 'lcrd_plan', { goal: 123, stop_condition: 'x', feasibility: true, verifier: { kind: 'assert', conditions: ['true'] } })
    expect(badGoal.isError).toBe(true)
    expect(badGoal.text).toContain('must be a string')
    const badFeasibility = await runTool(ctx, 'lcrd_plan', { goal: 'g', stop_condition: 'x', feasibility: 'yes', verifier: { kind: 'assert', conditions: ['true'] } })
    expect(badFeasibility.isError).toBe(true)
    expect(badFeasibility.text).toContain('must be a boolean')
    const badVerifier = await runTool(ctx, 'lcrd_plan', { goal: 'g', stop_condition: 'x', feasibility: true, verifier: 'nope' })
    expect(badVerifier.isError).toBe(true)
    expect(badVerifier.text).toContain('must be an object')
    const badKind = await runTool(ctx, 'lcrd_plan', { goal: 'g', stop_condition: 'x', feasibility: true, verifier: { kind: 'wat' } })
    expect(badKind.isError).toBe(true)
    expect(badKind.text).toContain('must be one of')
    const badConditions = await runTool(ctx, 'lcrd_plan', { goal: 'g', stop_condition: 'x', feasibility: true, verifier: { kind: 'assert', conditions: 'nope' } })
    expect(badConditions.isError).toBe(true)
    expect(badConditions.text).toContain('must be an array')
    const badChecks = await runTool(ctx, 'lcrd_plan', { goal: 'g', stop_condition: 'x', feasibility: true, verifier: { kind: 'python', checks: 1 } })
    expect(badChecks.isError).toBe(true)
    expect(badChecks.text).toContain('must be an array')
  })

  it('flushes on turn end and disposal, and resets on a new user command', async () => {
    const { ctx, workDir, logDir, flowRoot } = await setupLearning({ learningEnabled: false })
    await declarePassingPlan(ctx)
    const pinned = readdirSync(flowRoot)[0]
    expect(await runTool(ctx, 'str_replace_editor', { path: join(flowRoot, pinned!, 'task.md'), command: 'create' })).toMatchObject({ isError: false })
    // turn/end flushes the recorder artifacts into the log directory.
    fireEvent(ctx, 'session/event', agentSession, { type: 'turn/end' })
    expect(readdirSync(logDir).length).toBeGreaterThan(0)
    // Non-turn-end events, unknown sessions, and disposals of agents without a recorder pass through.
    fireEvent(ctx, 'session/event', agentSession, { type: 'other' })
    fireEvent(ctx, 'session/event', { header: {}, events: [] }, { type: 'turn/end' })
    fireEvent(ctx, 'agent/disposed', { agent: { id: 'no-recorder' } })
    // agent/disposed flushes.
    fireEvent(ctx, 'agent/disposed', { agent })
    // A new user command resets the task boundary: the launch gate re-fires.
    void ctx.waterfall(agent, 'agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'user' as const } })], turn: 1, step: 0, signal: new AbortController().signal }, () => ({ kind: 'allow' } as never))
    const gated = await runTool(ctx, 'str_replace_editor', { path: join(workDir, 'f.py'), command: 'create' })
    expect(gated.isError).toBe(true)
    expect(gated.text).toContain('任务目录已自动创建')
  })

  it('flushes remaining recorders on process exit and removes the listener on fiber dispose', async () => {
    const baseline = new Set(process.listeners('exit'))
    const { ctx, logDir } = await setupLearning({ learningEnabled: false })
    await declarePassingPlan(ctx)
    const onExit = process.listeners('exit').find(candidate => !baseline.has(candidate))
    expect(onExit).toBeTypeOf('function')
    const live = vi.spyOn(FlowRecorder.prototype, 'dump').mockClear()
    onExit?.(0)
    expect(live).toHaveBeenCalledTimes(1)
    live.mockRestore()
    // agent/disposed dumps once, then the recorder leaves the exit-flush set.
    const afterDispose = vi.spyOn(FlowRecorder.prototype, 'dump').mockClear()
    fireEvent(ctx, 'agent/disposed', { agent })
    expect(afterDispose).toHaveBeenCalledTimes(1)
    onExit?.(0)
    expect(afterDispose).toHaveBeenCalledTimes(1)
    afterDispose.mockRestore()
    expect(readdirSync(logDir).length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
    expect(process.listeners('exit')).not.toContain(onExit)
  })

  it('rejects invalid plugin configuration at load', async () => {
    const bad = async (config: Record<string, unknown>): Promise<string> => {
      const workDir = mkdtempSync(join(tmpdir(), 'lcrd-learn-'))
      dirs.push(workDir)
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: workDir })
      openContexts.push(ctx)
      try {
        await ctx.plugin(lcrd, config)
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error)
      }
      return '(no error)'
    }
    expect(await bad({ maxRetries: 0 })).toContain('maxRetries')
    expect(await bad({ maxRetries: 1.5 })).toContain('maxRetries')
    expect(await bad({ pythonTimeoutMs: 500 })).toContain('pythonTimeoutMs')
    expect(await bad({ learningThreshold: 0 })).toContain('learningThreshold')
    expect(await bad({ maxLearningAttempts: 0 })).toContain('maxLearningAttempts')
    expect(await bad({ fileFlowPathViolationsMax: 0 })).toContain('fileFlowPathViolationsMax')
    expect(await bad({ declarationMaxHoldRate: 0 })).toContain('declarationMaxHoldRate')
    expect(await bad({ declarationMaxHoldRate: 1.5 })).toContain('declarationMaxHoldRate')
    expect(await bad({ declarationMaxHoldRate: -1 })).toContain('declarationMaxHoldRate')
  })

  it('rejects protocol tools executed without an agent scope, and accepts llm and python verifier plans', async () => {
    const { ctx } = await setupLearning()
    const textOf = (result: ToolExecutionResult): string =>
      result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    const plan = await ctx.tools.execute({
      callId: ToolCallId('no-agent'), name: 'lcrd_plan', arguments: {
        goal: 'g', stop_condition: 's', feasibility: true, verifier: { kind: 'llm' },
      }, signal: new AbortController().signal,
    })
    expect(plan.isError).toBe(true)
    expect(textOf(plan)).toContain('requires an agent-scoped execution')
    const learn = await ctx.tools.execute({
      callId: ToolCallId('no-agent-2'), name: 'lcrd_learn', arguments: {
        problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
      }, signal: new AbortController().signal,
    })
    expect(learn.isError).toBe(true)
    expect(textOf(learn)).toContain('requires an agent-scoped execution')
    const verify = await ctx.tools.execute({
      callId: ToolCallId('no-agent-3'), name: 'lcrd_learn_verify', arguments: { learned: true, evidence: 'e' },
      signal: new AbortController().signal,
    })
    expect(verify.isError).toBe(true)
    expect(textOf(verify)).toContain('requires an agent-scoped execution')
    // llm and python verifier plans parse through the tool boundary.
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: 'llm 校验', stop_condition: 's', feasibility: true, verifier: { kind: 'llm' },
    })).isError).toBe(false)
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: 'python 校验', stop_condition: 's', feasibility: true, verifier: { kind: 'python', checks: ['content == "x"'] },
    })).isError).toBe(false)
  })

  it('terminates at the plain retry budget when learning is off, and ignores non-user pre-steps', async () => {
    const { ctx, workDir } = await setupLearning({ learningEnabled: false, maxRetries: 1 })
    const product = join(workDir, 'f.py')
    await declareFailingPlan(ctx)
    const outcome = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('连续 1 次校验失败,任务已终止转人工')
    // A plugin-source pre-step does NOT reset the terminated boundary.
    void ctx.waterfall(agent, 'agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'lcrd-hard-isolation' as const } })], turn: 1, step: 0, signal: new AbortController().signal }, () => ({ kind: 'allow' } as never))
    const stillBlocked = await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    expect(stillBlocked.isError).toBe(true)
    expect(stillBlocked.text).toContain('任务已终止')
  })

  it('records the call referent, the verifier kind, and the anchor digest of a run', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    await ctx.waterfall(agent, 'agent/pre-step', {
      agent,
      turn: 1,
      step: 0,
      signal: new AbortController().signal,
      messages: [createUserMessage({
        content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '把 a.py 建好' }],
        source: { kind: 'user' },
      })],
    }, () => ({ kind: 'allow' } as never))
    const declared = await runTool(ctx, 'lcrd_plan', {
      goal: '建文件',
      stop_condition: '文件存在',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(declared.isError).toBe(false)
    await runTool(ctx, 'str_replace_editor', { path: join(workDir, 'a.py') })
    fireEvent(ctx, 'session/event', agentSession, { type: 'turn/end' })
    const folders = readdirSync(logDir)
    expect(folders).toHaveLength(1)
    const snapshot = JSON.parse(readFileSync(join(logDir, folders[0] as string, 'lcrd-flow.json'), 'utf8')) as {
      anchor_digest: string | null
      schema_version: number
      relaxation_count: number
      events: {
        type: string
        callId?: string
        resultKind?: string
        verifierKind?: string
        strictness?: { kind: string; presenceOnly: boolean }
        relaxation?: string[]
      }[]
    }
    // The digest covers the whole anchoring message, non-text blocks included.
    expect(snapshot.schema_version).toBe(4)
    expect(snapshot.anchor_digest).toMatch(/^[0-9a-f]{16}$/)
    const planEvent = snapshot.events.find(event => event.type === 'plan')
    expect(planEvent?.strictness).toMatchObject({ kind: 'assert', presenceOnly: true })
    expect(planEvent?.relaxation).toEqual([])
    expect(snapshot.relaxation_count).toBe(0)
    const toolEvent = snapshot.events.filter(event => event.type === 'tool').at(-1)
    expect(toolEvent?.callId).toMatch(/^learn-/)
    expect(toolEvent?.resultKind).toBeDefined()
    expect(snapshot.events.find(event => event.type === 'verdict')?.verifierKind).toBe('assert')
  })

  it('records the declaration context and the verdict referent across a failing run', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    ctx.tools.register(defineContentToolFixture({
      name: 'failing_fixture',
      description: 'fails on purpose',
      parameters: { path: { type: 'string' } },
      async execute() {
        throw new HarnessError('boom from tool', 'SANDBOX_UNAVAILABLE')
      },
    }))
    // A check the engine rejects is labeled apart from a task failure.
    await runTool(ctx, 'lcrd_plan', {
      goal: '无效断言',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    })
    await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    await runTool(ctx, 'lcrd_plan', {
      goal: '第二次',
      stop_condition: '读到了',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    const failing = await runTool(ctx, 'failing_fixture', { path: join(workDir, 'b.txt') })
    expect(failing.isError).toBe(true)
    const events = readCompositionStream(logDir)
    const plans = events.filter(event => event.type === 'plan')
    expect(plans[0]?.context).toMatchObject({ failures: 0, phase: 'normal', lastPass: null, lastReason: null, invalidChecks: 0 })
    expect(plans[1]?.context).toMatchObject({ failures: 1, phase: 'normal', lastPass: false, invalidChecks: 1 })
    expect(plans[1]?.context?.lastReason).toContain('必须引用')
    const verdicts = events.filter(event => event.type === 'verdict')
    expect(verdicts[0]).toMatchObject({ verifierKind: 'python', tool: 'read', exceptionKind: 'invalid-condition' })
    expect(verdicts[0]?.callId).toMatch(/^learn-/)
    // The failed call carries its own error detail, and its verdict names the referent.
    const failedCall = events.filter(event => event.type === 'tool').at(-1)
    expect(failedCall).toMatchObject({ name: 'failing_fixture', resultKind: 'error' })
    expect(failedCall?.callId).toMatch(/^learn-/)
    expect(failedCall?.errorMessage).toContain('boom from tool')
    expect(failedCall?.errorCode).toBe('SANDBOX_UNAVAILABLE')
    expect(verdicts.at(-1)).toMatchObject({ pass: false, tool: 'failing_fixture', verifierKind: 'assert' })
  })

  it('leaves the task budget intact when failed checks are counted separately', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false, maxRetries: 2, failedCheckConsumesRetry: false })
    const invalidPlan = {
      goal: '无效断言',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    }
    await runTool(ctx, 'lcrd_plan', invalidPlan)
    const first = await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    expect(first.isError).toBe(true)
    expect(first.text).toContain('不消耗任务重试预算')
    // The task budget is untouched, so the next declaration still starts clean.
    await runTool(ctx, 'lcrd_plan', { ...invalidPlan, goal: '第二次无效断言' })
    const plans = readCompositionStream(logDir).filter(event => event.type === 'plan')
    expect(plans[1]?.context).toMatchObject({ failures: 0, invalidChecks: 1 })
    const second = await runTool(ctx, 'read', { path: join(workDir, 'b.txt') })
    // Invalid checks are bounded by their own budget instead.
    expect(second.isError).toBe(true)
    expect(second.text).toContain('连续 2 次断言被引擎判为无效')
  })

  it('admits a probe declaration that pins nothing and still rejects an unbound one', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    const tautology = await runTool(ctx, 'lcrd_plan', {
      goal: '预测', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', mode: 'probe', conditions: ['result === result'] },
    })
    expect(tautology.isError).toBe(false)
    // The probe plan governs the next step: a tautological prediction holds, so
    // the result is accepted.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).isError).toBe(false)
    const unbound = await runTool(ctx, 'lcrd_plan', {
      goal: '无引用', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', mode: 'probe', conditions: ['true'] },
    })
    expect(unbound.isError).toBe(true)
    expect(unbound.text).toContain('必须引用')
    const plans = readCompositionStream(logDir).filter(event => event.type === 'plan')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ strictness: { mode: 'probe', discrimination: 'unchecked' } })
    expect(plans[0]?.relaxation).toEqual([])
    // A rejected declaration clears the earlier plan, as it does on the oracle path.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
  })

  it('accepts a probe miss without consuming the retry budget', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    const declared = await runTool(ctx, 'lcrd_plan', {
      goal: '探索读取', stop_condition: '内容与预期一致', feasibility: true,
      verifier: { kind: 'assert', mode: 'probe', conditions: ['content.includes("不会出现的字符串")'] },
    })
    expect(declared.isError).toBe(false)
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).isError).toBe(false)
    const missed = readCompositionStream(logDir).find(event => event.type === 'verdict')
    expect(missed).toMatchObject({ pass: true, predictionMissed: true, verifierKind: 'assert' })
    expect(missed?.count).toBeUndefined()
    const snapshot = readCompositionSnapshot(logDir)
    expect(snapshot.prediction_misses).toBe(1)
    expect(snapshot.lcrd_retry_consumed).toBe(0)
    // The engine baseline still binds a probe step: a failed call fails outright,
    // because a prediction grants no pass for a broken execution to hide behind.
    ctx.tools.register(defineContentToolFixture({
      name: 'failing',
      description: 'failing fixture',
      parameters: { path: { type: 'string' } },
      async execute() {
        throw new Error('boom')
      },
    }))
    const failed = await runTool(ctx, 'failing', { path: 'x' })
    expect(failed.isError).toBe(true)
    const verdicts = readCompositionStream(logDir).filter(event => event.type === 'verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[1]).toMatchObject({ pass: false, count: 1 })
  })

  it('counts an identical redeclaration when the failed check never consumed the task budget', async () => {
    const { ctx, workDir } = await setupLearning({ learningEnabled: false, failedCheckConsumesRetry: false })
    const invalidPlan = {
      goal: '无效断言', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    }
    await runTool(ctx, 'lcrd_plan', invalidPlan)
    await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    const repeat = await runTool(ctx, 'lcrd_plan', invalidPlan)
    expect(repeat.isError).toBe(true)
    expect(repeat.text).toContain('原样相同')
    expect(repeat.text).toContain('(第 1/')
  })

  it('rejects unbound, non-compiling, and tautological assert conditions at the declaration', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    const unbound = await runTool(ctx, 'lcrd_plan', {
      goal: '恒真', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['true'] },
    })
    expect(unbound.isError).toBe(true)
    expect(unbound.text).toContain('lcrd_plan: 断言必须引用')
    const invalid = await runTool(ctx, 'lcrd_plan', {
      goal: '语法错', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result ==='] },
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.text).toContain('断言无法编译')
    const tautology = await runTool(ctx, 'lcrd_plan', {
      goal: '恒等', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === result'] },
    })
    expect(tautology.isError).toBe(true)
    expect(tautology.text).toContain('缺少区分度')
    const negation = await runTool(ctx, 'lcrd_plan', {
      goal: '否定', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['typeof content !== "undefined" || typeof content === "undefined"'] },
    })
    expect(negation.isError).toBe(true)
    expect(negation.text).toContain('否定式条件')
    // Rejected declarations leave no plan: the next tool call has nothing to verify against.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
    expect(readCompositionStream(logDir).filter(event => event.type === 'plan')).toHaveLength(0)
    // A rejected declaration also clears an earlier effective plan.
    await declarePassingPlan(ctx)
    expect(readCompositionStream(logDir).filter(event => event.type === 'plan')).toHaveLength(1)
    const cleared = await runTool(ctx, 'lcrd_plan', {
      goal: '再拒', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === result'] },
    })
    expect(cleared.isError).toBe(true)
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
    expect(readCompositionStream(logDir).filter(event => event.type === 'plan')).toHaveLength(1)
    // python and llm verifiers skip the JS condition probe.
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: 'py', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    })).isError).toBe(false)
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: 'llm', stop_condition: 'x', feasibility: true, verifier: { kind: 'llm' },
    })).isError).toBe(false)
  })

  it('rejects presence-only assert declarations only when rejectPresenceOnly is on', async () => {
    const { ctx: off } = await setupLearning({ learningEnabled: false })
    expect((await runTool(off, 'lcrd_plan', {
      goal: '存在即可', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })).isError).toBe(false)
    const { ctx: on } = await setupLearning({ learningEnabled: false, rejectPresenceOnly: true })
    const rejected = await runTool(on, 'lcrd_plan', {
      goal: '存在即可', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('presence-only')
    // A literal-pinned condition passes the form gate.
    expect((await runTool(on, 'lcrd_plan', {
      goal: '钉住字面量', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })).isError).toBe(false)
    // python has no JS condition list to probe.
    expect((await runTool(on, 'lcrd_plan', {
      goal: 'py', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    })).isError).toBe(false)
  })

  it('rejects declarations whose probe hold rate meets the configured ceiling', async () => {
    const { ctx } = await setupLearning({ learningEnabled: false, declarationMaxHoldRate: 0.9 })
    const weak = await runTool(ctx, 'lcrd_plan', {
      goal: '弱约束', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(weak.isError).toBe(true)
    expect(weak.text).toContain('约束过弱')
    expect(weak.text).toContain('探测通过率')
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: '强约束', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })).isError).toBe(false)
    expect((await runTool(ctx, 'lcrd_plan', {
      goal: 'py', stop_condition: 'x', feasibility: true,
      verifier: { kind: 'python', checks: ['1 == 1'] },
    })).isError).toBe(false)
  })

  it('rejects an identical redeclaration of the failed plan and clears on a new user command or a pass', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false, maxRetries: 3 })
    const product = join(workDir, 'f.py')
    await declareFailingPlan(ctx, 0)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    const repeat = await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败', stop_condition: '结果等于 999', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })
    expect(repeat.isError).toBe(true)
    expect(repeat.text).toContain('原样相同')
    expect(repeat.text).toContain('禁止原样重试')
    expect(repeat.text).not.toContain('已终止转人工')
    // The rejection left no plan: the next tool call has nothing to verify against.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
    // A different plan still declares.
    await declareFailingPlan(ctx, 1)
    // A new user command clears the fingerprint so the old method may return.
    void ctx.waterfall(agent, 'agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text' as const, text: '换个方法' }], source: { kind: 'user' as const } })], turn: 1, step: 0, signal: new AbortController().signal }, () => ({ kind: 'allow' } as never))
    const afterReset = await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败', stop_condition: '结果等于 999', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })
    expect(afterReset.isError).toBe(false)
    // A later pass also clears the fingerprint: declare, fail, then pass a different plan.
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declarePassingPlan(ctx)
    await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    const afterPass = await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败', stop_condition: '结果等于 999', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })
    expect(afterPass.isError).toBe(false)
    expect(readCompositionStream(logDir).filter(event => event.type === 'plan').length).toBeGreaterThan(0)
  })

  it('terminates when identical failed redeclarations reach maxRetries', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false, maxRetries: 2 })
    await declareFailingPlan(ctx, 0)
    await runTool(ctx, 'str_replace_editor', { path: join(workDir, 'f.py'), command: 'create' })
    const terminal = await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败', stop_condition: '结果等于 999', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
    })
    expect(terminal.isError).toBe(true)
    expect(terminal.text).toContain('原样重复')
    expect(terminal.text).toContain('已终止转人工')
    expect(readCompositionStream(logDir).some(event => event.type === 'intercept' && event.kind === 'terminated' && (event.detail ?? '').includes('原样重复'))).toBe(true)
    // Later tools get the generic terminated notice.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('任务已终止')
  })

  it('rejects a replacement plan the declaration gates refuse', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({
    kind: 'modify',
    plan: {
      goal: '生效目标',
      stop_condition: '生效停止条件',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === result'] },
    },
  }),
}
`),
    })
    const rejected = await runTool(ctx, 'lcrd_plan', {
      goal: '声明目标', stop_condition: '声明停止条件', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('engine rejects')
    expect(rejected.text).toContain('缺少区分度')
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
  })

  it('rejects an empty verifier list at the declaration, before any plan is recorded', async () => {
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false })
    const emptyAssert = await runTool(ctx, 'lcrd_plan', {
      goal: '空断言',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'assert', conditions: [] },
    })
    expect(emptyAssert.isError).toBe(true)
    expect(emptyAssert.text).toContain('不能为空')
    const emptyPython = await runTool(ctx, 'lcrd_plan', {
      goal: '空检查',
      stop_condition: 'x',
      feasibility: true,
      verifier: { kind: 'python', checks: [] },
    })
    expect(emptyPython.isError).toBe(true)
    expect(emptyPython.text).toContain('不能为空')
    // No plan was recorded, so the next tool call is still blocked as missing-plan.
    const blocked = await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('未声明子任务计划')
    // The rejected declarations never reached the event stream.
    expect(readCompositionStream(logDir).filter(event => event.type === 'plan')).toHaveLength(0)
  })

  it('records a clipped anchor excerpt for offline judgement', async () => {
    const { ctx, logDir } = await setupLearning({ learningEnabled: false })
    await ctx.waterfall(agent, 'agent/pre-step', {
      agent,
      turn: 1,
      step: 0,
      signal: new AbortController().signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(600) }], source: { kind: 'user' } })],
    }, () => ({ kind: 'allow' } as never))
    await runTool(ctx, 'lcrd_plan', {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    fireEvent(ctx, 'session/event', agentSession, { type: 'turn/end' })
    const folders = readdirSync(logDir)
    const run = JSON.parse(readFileSync(join(logDir, folders[0] as string, 'run.json'), 'utf8')) as {
      anchor_excerpt: string | null
      anchor_digest: string | null
    }
    expect(run.anchor_digest).toMatch(/^[0-9a-f]{16}$/)
    expect(run.anchor_excerpt).toHaveLength(501)
    expect(run.anchor_excerpt?.endsWith('…')).toBe(true)
  })

  it('exports a finished run into the dataset files when the switch is on', async () => {
    const datasetDir = mkdtempSync(join(tmpdir(), 'lcrd-dataset-export-'))
    dirs.push(datasetDir)
    const { ctx, workDir, logDir } = await setupLearning({ learningEnabled: false, datasetExport: 'run', datasetDir })
    const userMessage = createUserMessage({ content: [{ type: 'text', text: '把 a.py 建好' }], source: { kind: 'user' } })
    await ctx.waterfall(agent, 'agent/pre-step', {
      agent, turn: 1, step: 0, signal: new AbortController().signal, messages: [userMessage],
    }, () => ({ kind: 'allow' } as never))
    // Transcript events in both shapes: a flat payload and a wrapped one.
    fireEvent(ctx, 'session/event', agentSession, { type: 'user/message', message: { content: [{ type: 'text', text: '把 a.py 建好' }], source: { kind: 'user' } } })
    fireEvent(ctx, 'session/event', agentSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } })
    fireEvent(ctx, 'session/event', agentSession, { type: 'unknown/kind' })
    // A plain-text message body and a non-plan call exercise the remaining branches.
    fireEvent(ctx, 'session/event', agentSession, { type: 'user/message', message: { content: 'plain text' } })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/call', callId: 'call-other', name: 'read', arguments: '{"path":"a.txt"}' })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/call' })
    fireEvent(ctx, 'session/event', agentSession, { type: 'user/message', message: { content: [{ type: 'image' }, { type: 'text', text: 'with image' }] } })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/result', message: { toolCallId: 'call-other', content: 'boom' } })
    await runTool(ctx, 'lcrd_plan', {
      goal: '读文件', stop_condition: '读到内容', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined && result.length > 100'] },
    })
    const firstPlan = readCompositionStream(logDir).find(event => event.type === 'plan')
    /** The declaration's arguments as the model produced them, from the recorded plan. */
    const argsOf = (plan: CompositionEvent | undefined): string => JSON.stringify({
      goal: plan?.goal,
      stop_condition: plan?.stop,
      feasibility: plan?.feasibility,
      verifier: plan?.verifierSpec,
    })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/call', callId: firstPlan?.callId, name: 'lcrd_plan', arguments: argsOf(firstPlan) })
    await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/result' })
    // The next declaration is looser than the failed one.
    await runTool(ctx, 'lcrd_plan', {
      goal: '读文件', stop_condition: '读到内容', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    const plans = readCompositionStream(logDir).filter(event => event.type === 'plan')
    const relaxed = plans[1]
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/call', callId: relaxed?.callId, name: 'lcrd_plan', arguments: argsOf(relaxed) })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/result', message: { toolCallId: relaxed?.callId, content: [{ type: 'text', text: 'ok' }] } })
    // Disposal exports once; the second disposal and a recorder-less agent are no-ops.
    fireEvent(ctx, 'agent/disposed', { agent })
    fireEvent(ctx, 'agent/disposed', { agent })
    fireEvent(ctx, 'agent/disposed', { agent: { id: 'agent-without-recorder', session: { header: {} }, options: {} } })
    const read = (file: string): Record<string, unknown>[] =>
      readFileSync(join(datasetDir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    const runs = read('runs.jsonl')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ session_id: 'agent-learning', has_run_meta: true, interaction: 'auto' })
    expect(String(runs[0]?.['task_group'])).toMatch(/^[0-9a-f]{16}$/)
    const relaxations = read('relaxations.jsonl')
    expect(relaxations).toHaveLength(1)
    expect(relaxations[0]).toMatchObject({ run_id: 'agent-learning', afterFailure: 1, failureClass: 'honest-mismatch', precedingResultKind: 'array' })
    const dataset = read('dataset.jsonl')
    expect(dataset.filter(row => row['type'] === 'plan')).toHaveLength(2)
    expect(dataset.filter(row => row['type'] === 'verdict')).toHaveLength(1)
    const pairs = read('dpo.jsonl')
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.['meta']).toMatchObject({ run_id: 'agent-learning', synthetic: true })
    expect(String(pairs[0]?.['prompt'])).toContain('把 a.py 建好')
  })

  it('uses a configured attribution module for the exported rows', async () => {
    const attributionDir = mkdtempSync(join(tmpdir(), 'lcrd-attribution-'))
    dirs.push(attributionDir)
    const modulePath = join(attributionDir, 'domain.mjs')
    writeFileSync(modulePath, [
      'export default {',
      "  classifyFailure: () => 'tool-isError',",
      "  classifyRelaxationCause: () => 'type-adaptation',",
      "  classifyTrainability: () => 'discard',",
      '}',
      '',
    ].join('\n'), 'utf8')
    const datasetDir = mkdtempSync(join(tmpdir(), 'lcrd-attribution-dataset-'))
    dirs.push(datasetDir)
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      datasetExport: 'run',
      datasetDir,
      attributionModule: modulePath,
    })
    fireEvent(ctx, 'agent/pre-step', {
      agent, turn: 1, step: 0, signal: new AbortController().signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: '把 a.py 建好' }], source: { kind: 'user' } })],
    }, () => ({ kind: 'allow' } as never))
    await runTool(ctx, 'lcrd_plan', {
      goal: '读文件', stop_condition: '读到内容', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 12345'] },
    })
    fireEvent(ctx, 'session/event', agentSession, { type: 'tool/result', message: { content: 'ok' } })
    await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    fireEvent(ctx, 'agent/disposed', { agent })
    const read = (file: string): Record<string, unknown>[] =>
      readFileSync(join(datasetDir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    const dataset = read('dataset.jsonl')
    const verdict = dataset.find(row => row['type'] === 'verdict')
    expect(verdict).toMatchObject({ failureClass: 'tool-isError' })
    // The custom bundle discards every row, so the training subset stays empty.
    expect(read('trainable.jsonl')).toEqual([])
  })

  it('lets the plan hook allow a declaration unchanged', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({ kind: 'allow' }),
}
`),
    })
    expect((await planAndRead(ctx, workDir)).isError).toBe(false)
    const plan = readCompositionStream(logDir).find(event => event.type === 'plan')
    expect(plan).toMatchObject({ goal: '必然成功', verifier: 'assert' })
  })

  it('replaces the effective plan silently while the declaration text and flow record diverge', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({
    kind: 'modify',
    plan: {
      goal: '生效目标',
      stop_condition: '生效停止条件',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    },
  }),
}
`),
    })
    // The declared llm verifier would need a provider; the hook replaces it with
    // an assert, so a passing tool result proves the effective plan governed.
    const declared = await runTool(ctx, 'lcrd_plan', {
      goal: '声明目标',
      stop_condition: '声明停止条件',
      feasibility: true,
      verifier: { kind: 'llm' },
    })
    expect(declared.isError).toBe(false)
    // Silent to the model: the result still echoes the declaration.
    expect(declared.text).toContain('声明目标')
    expect(declared.text).toContain('将由 llm 校验器')
    const plan = readCompositionStream(logDir).find(event => event.type === 'plan')
    expect(plan).toMatchObject({ goal: '生效目标', stop: '生效停止条件', verifier: 'assert' })
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).isError).toBe(false)
  })

  it('rejects a malformed replacement plan and clears any earlier plan', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({ kind: 'modify', plan: { goal: '', stop_condition: 's', feasibility: true, verifier: { kind: 'llm' } } }),
}
`),
    })
    const rejected = await runTool(ctx, 'lcrd_plan', {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('malformed plan')
    const blocked = await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('未声明子任务计划')
  })

  it('denies a declaration without consuming the task budget and clears the plan', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({ kind: 'deny', reason: 'policy says no' }),
}
`),
    })
    const denied = await runTool(ctx, 'lcrd_plan', {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('policy says no')
    // The denial invalidated the plan: the next tool call has nothing to verify against.
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('未声明子任务计划')
    const intercepts = readCompositionStream(logDir).filter(event => event.type === 'intercept')
    expect(intercepts[0]).toMatchObject({ kind: 'hook-denied', detail: 'policy says no' })
    expect(readCompositionStream(logDir).some(event => event.type === 'plan')).toBe(false)
  })

  it('terminates once plan denials reach maxRetries', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      maxRetries: 2,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({ kind: 'deny', reason: 'always' }),
}
`),
    })
    const plan = {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }
    await runTool(ctx, 'lcrd_plan', plan)
    const second = await runTool(ctx, 'lcrd_plan', plan)
    expect(second.text).toContain('子任务声明连续被外部策略拒绝 2 次')
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('任务已终止')
  })

  it('resets the hook interception count on a new user command', async () => {
    const { ctx } = await setupLearning({
      learningEnabled: false,
      maxRetries: 2,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => ({ kind: 'deny', reason: 'always' }),
}
`),
    })
    const plan = {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }
    await runTool(ctx, 'lcrd_plan', plan)
    fireEvent(ctx, 'agent/pre-step', {
      agent, turn: 2, step: 0, signal: new AbortController().signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: '新任务' }], source: { kind: 'user' } })],
    }, () => ({ kind: 'allow' } as never))
    // Without the reset the second denial would exhaust the budget and terminate.
    const denied = await runTool(ctx, 'lcrd_plan', plan)
    expect(denied.text).not.toContain('已终止转人工')
  })

  it('treats a throwing plan hook as an interception and propagates below the cap', async () => {
    const { ctx, logDir } = await setupLearning({
      learningEnabled: false,
      maxRetries: 3,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => { throw 'plan hook exploded' },
}
`),
    })
    const failed = await runTool(ctx, 'lcrd_plan', {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('plan hook exploded')
    expect(readCompositionStream(logDir).some(event => event.type === 'intercept' && event.kind === 'hook-error')).toBe(true)
  })

  it('terminates once plan-hook errors reach maxRetries', async () => {
    const { ctx } = await setupLearning({
      learningEnabled: false,
      maxRetries: 1,
      hooksModule: writeHooksModule(`
export default {
  checkPlan: () => { throw new Error('plan hook exploded') },
}
`),
    })
    const failed = await runTool(ctx, 'lcrd_plan', {
      goal: 'g', stop_condition: 's', feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    })
    expect(failed.text).toContain('策略检查连续异常 1 次')
    expect(failed.text).toContain('已终止转人工')
  })

  it('lets the result hook allow a verified result unchanged', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkResult: () => ({ kind: 'allow' }),
}
`),
    })
    expect((await planAndRead(ctx, workDir)).isError).toBe(false)
  })

  it('blocks a verified result without consuming the task budget', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkResult: ({ verdict }) => ({ kind: 'block', reason: 'unsafe result pass=' + String(verdict.pass) }),
}
`),
    })
    const blocked = await planAndRead(ctx, workDir)
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('unsafe result pass=true')
    expect(blocked.text).toContain('第 1/3 次')
    expect(readCompositionStream(logDir).some(event => event.type === 'intercept' && event.kind === 'hook-blocked')).toBe(true)
  })

  it('terminates once result blocks reach maxRetries', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      maxRetries: 1,
      hooksModule: writeHooksModule(`
export default {
  checkResult: () => ({ kind: 'block', reason: 'always unsafe' }),
}
`),
    })
    const blocked = await planAndRead(ctx, workDir)
    expect(blocked.text).toContain('工具结果连续被外部策略拒绝 1 次')
  })

  it('terminates the task when the result hook decides so', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      hooksModule: writeHooksModule(`
export default {
  checkResult: () => ({ kind: 'terminate', reason: 'forbidden content' }),
}
`),
    })
    const terminated = await planAndRead(ctx, workDir)
    expect(terminated.isError).toBe(true)
    expect(terminated.text).toContain('forbidden content')
    expect(readCompositionStream(logDir).some(event => event.type === 'intercept' && event.kind === 'hook-terminated')).toBe(true)
    expect((await runTool(ctx, 'read', { path: join(workDir, 'a.txt') })).text).toContain('任务已终止')
  })

  it('treats a throwing result hook as an interception and propagates below the cap', async () => {
    const { ctx, workDir, logDir } = await setupLearning({
      learningEnabled: false,
      maxRetries: 3,
      hooksModule: writeHooksModule(`
export default {
  checkResult: () => { throw 'result hook exploded' },
}
`),
    })
    const failed = await planAndRead(ctx, workDir)
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('result hook exploded')
    expect(readCompositionStream(logDir).some(event => event.type === 'intercept' && event.kind === 'hook-error')).toBe(true)
  })

  it('terminates once result-hook errors reach maxRetries', async () => {
    const { ctx, workDir } = await setupLearning({
      learningEnabled: false,
      maxRetries: 1,
      hooksModule: writeHooksModule(`
export default {
  checkResult: () => { throw new Error('result hook exploded') },
}
`),
    })
    const failed = await planAndRead(ctx, workDir)
    expect(failed.text).toContain('策略检查连续异常 1 次')
  })
})

