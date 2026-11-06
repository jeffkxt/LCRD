/**
 * File-flow guard over the real composition: the task-directory bootstrap,
 * the path fence, the product-containment rule, and the sandbox interaction.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as lcrd from '@deepseek-ai/dsh-experimental-lcrd'
// Pulls the package entry so its MessageSourceMap augmentation is in scope for createUserMessage sources below.
import '@deepseek-ai/dsh-experimental-lcrd'

/** Contexts created by setup helpers; disposed after each test so process-exit listeners do not accumulate. */
const openContexts: Context[] = []

describe('file-flow guard (real composition)', () => {
  const agent = { id: 'agent-guard', session: { header: {}, events: [] }, options: {} } as never
  const dirs: string[] = []

  /** Mount the real system-prompt, tools, llm, and local-filesystem services plus the lcrd plugin. */
  async function setup(options?: { fileFlowTools?: string[]; fileFlowEnabled?: boolean }) {
    const base = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const workDir = join(base, 'work')
    const logDir = join(base, 'log')
    mkdirSync(workDir)
    mkdirSync(logDir)
    const flowRoot = join(base, 'task-flow')
    dirs.push(base)
    const toolName = options?.fileFlowTools?.[0] ?? 'str_replace_editor'
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    await ctx.plugin(lcrd, { fileFlowEnabled: options?.fileFlowEnabled ?? true, logDir, ...options })
    openContexts.push(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: toolName,
      description: 'editor fixture',
      parameters: {
        path: { type: 'string', required: true },
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
      },
      async execute() {
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    // The task-flow root is a sibling of the flow-log directory, not the execution cwd.
    return { ctx, workDir, flowRoot, toolName }
  }

  afterEach(async () => {
    for (const ctx of openContexts.splice(0)) await ctx.fiber.dispose()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Run the editor fixture against one path and flatten the result text. */
  async function runPath(
    ctx: Context,
    path: string,
    toolName = 'str_replace_editor',
    command: 'view' | 'create' | 'str_replace' | 'insert' = 'create',
  ): Promise<{ isError: boolean; text: string }> {
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: ToolCallId(`guard-${Math.random().toString(36).slice(2, 8)}`),
      name: toolName,
      arguments: { path, command },
      signal: new AbortController().signal,
      agent,
    })
    return {
      isError: result.isError,
      text: result.content.map(block => block.type === 'text' ? block.text : '').join('\n'),
    }
  }

  /** Declare a passing subtask plan so editor results reach the exogenous verifier; pins the auto-created task dir. */
  async function declarePlan(ctx: Context): Promise<void> {
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: ToolCallId(`plan-${Math.random().toString(36).slice(2, 8)}`),
      name: 'lcrd_plan',
      arguments: {
        goal: '编辑任务上下文',
        stop_condition: '编辑器执行成功',
        feasibility: true,
        verifier: { kind: 'assert', conditions: ['result !== undefined'] },
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
  }

  /** The single auto-created task directory under the flow root. */
  function pinnedDir(flowRoot: string): string {
    const entries = readdirSync(flowRoot)
    expect(entries).toHaveLength(1)
    return join(flowRoot, entries[0] ?? '')
  }

  it('auto-creates and pins the task directory at plan declaration', async () => {
    const { ctx, workDir, flowRoot } = await setup()
    await declarePlan(ctx)
    const pinned = pinnedDir(flowRoot)
    expect(await runPath(ctx, join(pinned, 'task.md'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(pinned, 'progress.md'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(pinned, 'subtasks', 'plan.md'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(workDir, 'app.py'))).toMatchObject({ isError: false })
    const foreign = await runPath(ctx, join(flowRoot, 'other-task', 'progress.md'))
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toContain('任务上下文越界(第 1/3 次)')
    const root = await runPath(ctx, flowRoot)
    expect(root.isError).toBe(true)
    expect(root.text).toContain('任务上下文越界(第 2/3 次)')
  })

  it('denies task products inside the task directory, keeping it to flow files only', async () => {
    const { ctx, workDir, flowRoot } = await setup()
    await declarePlan(ctx)
    const pinned = pinnedDir(flowRoot)
    const product = await runPath(ctx, join(pinned, 'calc.sh'))
    expect(product.isError).toBe(true)
    expect(product.text).toContain('任务目录只存放流程文件')
    // Flow files and directory views stay allowed.
    expect(await runPath(ctx, join(pinned, 'task.md'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, pinned)).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(pinned, 'subtasks'))).toMatchObject({ isError: false })
    // The product belongs in the workspace.
    expect(await runPath(ctx, join(workDir, 'calc.sh'))).toMatchObject({ isError: false })
  })

  it('contains task products to the workspace, while reads stay free', async () => {
    const { ctx, workDir, flowRoot } = await setup()
    await declarePlan(ctx)
    const pinned = pinnedDir(flowRoot)
    expect(await runPath(ctx, join(pinned, 'task.md'))).toMatchObject({ isError: false })
    // Products inside the workspace pass.
    expect(await runPath(ctx, join(workDir, 'calc.sh'))).toMatchObject({ isError: false })
    // Products outside the workspace are denied with guidance.
    const outside = join(dirname(workDir), 'stray-calc.sh')
    const denied = await runPath(ctx, outside)
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('任务产物必须写入工作区')
    // Reads anywhere stay free.
    expect(await runPath(ctx, outside, 'str_replace_editor', 'view')).toMatchObject({ isError: false })
  })

  it('creates the task directory on the first guarded operation when no plan preceded', async () => {
    const { ctx, workDir, flowRoot } = await setup()
    const gated = await runPath(ctx, join(workDir, 'app.py'))
    expect(gated.isError).toBe(true)
    expect(gated.text).toContain('任务目录已自动创建')
    const pinned = pinnedDir(flowRoot)
    await declarePlan(ctx)
    expect(await runPath(ctx, join(pinned, 'task.md'))).toMatchObject({ isError: false })
  })

  it('disambiguates a task-directory name collision so tasks never overwrite', async () => {
    const { ctx, flowRoot } = await setup()
    const expected = 'taskflow-agent-guard'
    mkdirSync(join(flowRoot, expected), { recursive: true })
    await declarePlan(ctx)
    const entries = readdirSync(flowRoot)
    expect(entries).toHaveLength(2)
    const pinnedName = entries.find(name => name !== expected)
    expect(pinnedName).toBeDefined()
    expect(await runPath(ctx, join(flowRoot, pinnedName ?? '', 'task.md'))).toMatchObject({ isError: false })
  })

  it('polices the configured file tools, including write', async () => {
    const { ctx, workDir, flowRoot } = await setup({ fileFlowTools: ['write'] })
    const gated = await runPath(ctx, join(workDir, 'app.py'), 'write')
    expect(gated.isError).toBe(true)
    expect(gated.text).toContain('任务目录已自动创建')
    expect(readdirSync(flowRoot)).toHaveLength(1)
  })

  it('leaves tools unguarded when fileFlowEnabled is off (standard mode)', async () => {
    const { ctx, workDir, flowRoot } = await setup({ fileFlowEnabled: false })
    await declarePlan(ctx)
    expect(await runPath(ctx, join(workDir, 'app.py'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(flowRoot, 'calc.sh'))).toMatchObject({ isError: false })
    expect(await runPath(ctx, join(flowRoot, 'task.md'))).toMatchObject({ isError: false })
    expect(existsSync(flowRoot)).toBe(false)
  })

  it('injects the session workspace root into the file-flow section per agent', async () => {
    const { ctx, flowRoot } = await setup()
    const agentWithCwd = { id: 'agent-cwd', session: { header: { cwd: 'D:/chosen-workspace' } }, options: {} } as never
    const assembly = await ctx.get('systemPrompt')!.assemble({ agent: agentWithCwd, scope: agentWithCwd })
    const section = assembly.sections.find(entry => entry.name === 'lcrd-file-flow')
    expect(section?.text).toContain('D:/chosen-workspace')
    expect(section?.text).toContain(flowRoot)
    expect(section?.text).toContain('taskflow-<uuid>')
  })

  it('falls back to the sandbox workspace root when the session has no cwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const workDir = join(base, 'work')
    const logDir = join(base, 'log')
    mkdirSync(workDir)
    mkdirSync(logDir)
    dirs.push(base)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    // SandboxPolicyService injects sessionProjections; without the registry the
    // service never registers and the workspace-root fallback has nothing to read.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: 'D:/sandbox-workspace' })
    await ctx.plugin(lcrd, { fileFlowEnabled: true, logDir })
    openContexts.push(ctx)
    // A real Session (no cwd): SandboxPolicyService's system-prompt context
    // folds session projections and rejects the plain object stubs used elsewhere.
    const sessionId = SessionId('sess-no-cwd')
    const session = Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 0,
      isSeeded: false,
    })
    const noCwdAgent = { id: 'agent-guard', session, options: {} } as never
    const assembly = await ctx.get('systemPrompt')!.assemble({ agent: noCwdAgent, scope: noCwdAgent })
    const section = assembly.sections.find(entry => entry.name === 'lcrd-file-flow')
    expect(section?.text).toContain('sandbox-workspace')
  })

  it('terminates the task as severe hallucination at the path-violation cap', async () => {
    const { ctx, flowRoot } = await setup()
    await declarePlan(ctx)
    const pinned = pinnedDir(flowRoot)
    expect(await runPath(ctx, join(pinned, 'task.md'))).toMatchObject({ isError: false })
    const first = await runPath(ctx, join(flowRoot, 'other-task', 'progress.md'))
    expect(first.text).toContain('第 1/3 次')
    const second = await runPath(ctx, join(flowRoot, 'other-task', 'progress.md'))
    expect(second.text).toContain('第 2/3 次')
    const terminal = await runPath(ctx, join(flowRoot, 'other-task', 'progress.md'))
    expect(terminal.text).toContain('连续越界 3 次,幻觉严重,任务已终止转人工')
  })

  it('registers the file-flow section without a workspace provider when none is supplied', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const workDir = join(base, 'work')
    const logDir = join(base, 'log')
    mkdirSync(workDir)
    mkdirSync(logDir)
    dirs.push(base)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    const { registerFileFlowSection } = await import('../src/file-flow.ts')
    registerFileFlowSection(ctx, join(dirname(logDir), 'task-flow'))
    openContexts.push(ctx)
    const assembly = await ctx.get('systemPrompt')!.assemble({ agent, scope: agent })
    const section = assembly.sections.find(entry => entry.name === 'lcrd-file-flow')
    expect(section?.text).toContain('taskflow-<uuid>')
    expect(section?.text).not.toContain('当前工作目录绝对路径')
  })
})

/** One recorded event as read back from the append-only stream of a composition run. */
