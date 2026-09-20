import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as lcrd from '@deepseek-ai/dsh-lcrd'
import {
  Config,
  FlowRecorder,
  classifyFlowPath,
  fileFlowSectionText,
  resultPayload,
  shortAgentId,
  verifyAssert,
  type VerifyPayload,
} from '@deepseek-ai/dsh-lcrd'
import { runVerifier } from '@deepseek-ai/dsh-lcrd/src/verifiers.ts'

/** Unit tests never write into the plugin package default log directory. */
const unitOutDir = mkdtempSync(join(tmpdir(), 'lcrd-unit-'))

/** Typed view of the dumped `lcrd-flow.json` fields these tests read. */
interface DumpJson {
  events: unknown[]
  md_file: string
  final_verdict: string
  task_id: string
}

const okResult: ToolExecutionResult = {
  isError: false,
  value: 5,
  content: [{ type: 'text', text: 'ok' }],
}
const errResult: ToolExecutionResult = {
  isError: true,
  error: { message: 'boom' },
  content: [{ type: 'text', text: 'boom' }],
}

const payload = (overrides: Partial<VerifyPayload>): VerifyPayload => ({
  isError: false,
  value: 1,
  content: 'x',
  ...overrides,
})

describe('Config', () => {
  it('defaults interaction to manual', () => {
    expect(Config({})).toMatchObject({ interaction: 'manual' })
  })

  it('accepts auto, auth, and manual interaction modes', () => {
    expect(Config({ interaction: 'auto' })).toMatchObject({ interaction: 'auto' })
    expect(Config({ interaction: 'auth' })).toMatchObject({ interaction: 'auth' })
    expect(Config({ interaction: 'manual' })).toMatchObject({ interaction: 'manual' })
  })

  it('defaults learning off with the documented threshold, attempts, and tool set', () => {
    const config = Config({})
    expect(config.learningEnabled).toBe(false)
    expect(config.learningThreshold).toBe(5)
    expect(config.maxLearningAttempts).toBe(3)
    expect(config.learningTools).toEqual([
      'web_search', 'read', 'glob', 'grep', 'skill', 'subagent', 'web_fetch',
    ])
  })

  it('defaults file-backed task flow off', () => {
    expect(Config({}).fileFlowEnabled).toBe(false)
  })

  it('defaults the path-violation cap to three', () => {
    expect(Config({}).fileFlowPathViolationsMax).toBe(3)
  })

  it('accepts explicit learning configuration', () => {
    const config = Config({
      learningEnabled: true,
      learningThreshold: 2,
      maxLearningAttempts: 4,
      learningTools: ['web_search', 'read'],
    })
    expect(config.learningEnabled).toBe(true)
    expect(config.learningThreshold).toBe(2)
    expect(config.maxLearningAttempts).toBe(4)
    expect(config.learningTools).toEqual(['web_search', 'read'])
  })

  it('accepts an explicit file-flow switch', () => {
    expect(Config({ fileFlowEnabled: true }).fileFlowEnabled).toBe(true)
  })

  it('accepts an explicit path-violation cap', () => {
    expect(Config({ fileFlowPathViolationsMax: 5 }).fileFlowPathViolationsMax).toBe(5)
  })

  it('accepts an explicit workspace root', () => {
    expect(Config({ workspaceRoot: 'D:/workspace' }).workspaceRoot).toBe('D:/workspace')
  })

  it('accepts an explicit attribution module', () => {
    expect(Config({ attributionModule: './domain-attribution.mjs' }).attributionModule).toBe('./domain-attribution.mjs')
  })

  it('defaults the policy hook off and accepts an explicit module', () => {
    expect(Config({}).hooksModule).toBeUndefined()
    expect(Config({ hooksModule: './policy-hooks.mjs' }).hooksModule).toBe('./policy-hooks.mjs')
  })
})

describe('resultPayload', () => {
  it('maps success to the value and error to undefined', () => {
    expect(resultPayload(okResult)).toEqual({ isError: false, value: 5, content: 'ok' })
    expect(resultPayload(errResult)).toEqual({ isError: true, value: undefined, content: 'boom' })
  })

  it('flattens non-text blocks to their kind', () => {
    const result: ToolExecutionResult = {
      isError: false,
      value: 1,
      content: [{ type: 'reasoning', text: 'x' }],
    }
    expect(resultPayload(result).content).toBe('[reasoning content]')
  })
})

describe('verifyAssert', () => {
  it('rejects a condition that never mentions result', () => {
    const verdict = verifyAssert(['true'], payload({}))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('必须引用 result')
  })

  it('rejects a condition true on every probe input', () => {
    const verdict = verifyAssert(['result === result'], payload({}))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('缺少区分度')
  })

  it('rejects a condition that fails on the payload value', () => {
    const verdict = verifyAssert(['result > 10'], payload({ value: 5 }))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('断言不成立')
  })

  it('rejects a condition that throws', () => {
    const verdict = verifyAssert(['result.foo.bar'], payload({ value: 5 }))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('断言求值失败')
  })

  it('passes a discriminating condition that holds on the value', () => {
    const verdict = verifyAssert(['result === 5'], payload({ value: 5 }))
    expect(verdict).toEqual({ pass: true, reason: '全部断言通过' })
  })

  it('fails error results outright, closing the self-pass-on-error hole', () => {
    const verdict = verifyAssert(['result === undefined'], {
      isError: true,
      value: undefined,
      content: 'boom',
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('工具执行失败')
  })

  it('binds content and isError alongside result', () => {
    expect(verifyAssert(['content.includes("x")'], payload({ value: 5, content: 'abcx' }))).toEqual({ pass: true, reason: '全部断言通过' })
    expect(verifyAssert(['isError === false'], payload({ value: 5, content: 'x' }))).toEqual({ pass: true, reason: '全部断言通过' })
  })

  it('rejects a tautology over content', () => {
    const verdict = verifyAssert(['content === content'], payload({}))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('缺少区分度')
  })

  it('hints when a negative condition is rejected for missing discrimination', () => {
    const verdict = verifyAssert([
      'typeof content !== "undefined" || typeof content === "undefined"',
    ], payload({ value: 5, content: 'ok' }))
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('缺少区分度')
    expect(verdict.reason).toContain('否定式条件')
  })

  it('localizes shape mismatches with the actual types and the in-operator hint', () => {
    const includes = verifyAssert(['result.includes("x")'], payload({ value: 42, content: 'x' }))
    expect(includes.pass).toBe(false)
    expect(includes.reason).toContain('求值失败')
    expect(includes.reason).toContain('result 类型: number')
    const inOperator = verifyAssert(['"x" in content'], payload({ value: 42, content: 'x' }))
    expect(inOperator.pass).toBe(false)
    expect(inOperator.reason).toContain('in 运算符')
  })

  it('rejects a syntax-error condition at construction and clips long error content', () => {
    const syntax = verifyAssert(['result ==='], payload({ value: 1, content: 'x' }))
    expect(syntax.pass).toBe(false)
    expect(syntax.reason).toContain('求值失败')
    expect(syntax.exception).toBe(true)
    const longContent = 'x'.repeat(500)
    const clipped = verifyAssert(['content === "y"'], { isError: true, value: undefined, content: longContent })
    expect(clipped.pass).toBe(false)
    expect(clipped.reason.length).toBeLessThan(200)
    // A tautology without negation gets no negation hint.
    const tautology = verifyAssert(['content === content'], payload({ value: 1, content: 'x' }))
    expect(tautology.reason).toContain('缺少区分度')
    expect(tautology.reason).not.toContain('否定式条件')
  })
})

describe('classifyFlowPath', () => {
  const root = join('D:', 'tasks', 'task-flow')
  const taskDir = join(root, 'repair-login')
  const other = join(root, 'other-task')

  it('passes paths outside the task-flow root through unguarded', () => {
    expect(classifyFlowPath(root, undefined, join('D:', 'tasks', 'app.py'))).toEqual({ kind: 'outside' })
    expect(classifyFlowPath(root, taskDir, join('D:', 'tasks'))).toEqual({ kind: 'outside' })
    expect(classifyFlowPath(root, taskDir, join('D:', 'elsewhere', 'x.txt'))).toEqual({ kind: 'outside' })
  })

  it('denies the bare task-flow root before the task directory is pinned', () => {
    expect(classifyFlowPath(root, undefined, root)).toEqual({ kind: 'flowRoot' })
    expect(classifyFlowPath(root, taskDir, root)).toEqual({ kind: 'foreign' })
  })

  it('pins the first task-context access to its slug subdirectory', () => {
    expect(classifyFlowPath(root, undefined, join(taskDir, 'task.md'))).toEqual({ kind: 'bootstrap', taskDir })
    expect(classifyFlowPath(root, undefined, join(taskDir, 'subtasks', '01.md'))).toEqual({ kind: 'bootstrap', taskDir })
  })

  it('allows any path inside the pinned task directory', () => {
    expect(classifyFlowPath(root, taskDir, taskDir)).toEqual({ kind: 'own' })
    expect(classifyFlowPath(root, taskDir, join(taskDir, 'progress.md'))).toEqual({ kind: 'own' })
    expect(classifyFlowPath(root, taskDir, join(taskDir, 'subtasks', '01.md'))).toEqual({ kind: 'own' })
  })

  it('denies task-context paths outside the pinned task directory', () => {
    expect(classifyFlowPath(root, taskDir, other)).toEqual({ kind: 'foreign' })
    expect(classifyFlowPath(root, taskDir, join(other, 'progress.md'))).toEqual({ kind: 'foreign' })
    expect(classifyFlowPath(root, taskDir, join(root, 'shared.md'))).toEqual({ kind: 'foreign' })
  })

  it('treats a sibling slug with a common prefix as foreign, not own', () => {
    const sibling = join(root, 'repair-login-v2')
    expect(classifyFlowPath(root, taskDir, join(sibling, 'task.md'))).toEqual({ kind: 'foreign' })
  })
})

describe('fileFlowSectionText', () => {
  it('embeds the absolute flow root and workspace root', () => {
    const text = fileFlowSectionText('D:/x/task-flow', 'D:/workspace')
    expect(text).toContain('D:/x/task-flow/taskflow-<uuid>')
    expect(text).toContain('当前工作目录绝对路径为 D:/workspace')
    expect(text).toContain('cd /d D:/workspace')
  })

  it('omits the workspace line when the root is unresolvable', () => {
    const text = fileFlowSectionText('D:/x/task-flow', '')
    expect(text).not.toContain('当前工作目录绝对路径')
    expect(text).toContain('D:/x/task-flow/taskflow-<uuid>')
  })
})

describe('runVerifier (python and llm)', () => {
  const agent = { id: 'verifier-agent', session: { header: {} }, options: { provider: 'p', model: 'm' } } as never
  const opts = { pythonCommand: 'python', pythonTimeoutMs: 30000, verifierModel: undefined, anchorText: 'anchor' }
  const signal = new AbortController().signal
  const result = (value: unknown, content: string): ToolExecutionResult => ({
    isError: false,
    value: value as never,
    content: [{ type: 'text', text: content }],
  })

  /** A stub llm service whose stream yields one pre-rendered verdict text. */
  const llmCtx = (text: string): Context => ({
    llm: {
      async *stream() {
        if (text !== '') yield { type: 'text-delta', text }
      },
    },
  }) as unknown as Context

  it('runs the python verifier end to end: pass, fail, discrimination, error-fail, and reference check', async () => {
    const plan = (checks: string[]): StepPlanFixture => ({ kind: 'python', checks })
    expect((await runVerifier(llmCtx(''), agent, plan(['content.startswith("OUT:")']), result({ stdout: 'x' }, 'OUT: ok'), opts, planStub(), signal)).pass).toBe(true)
    expect((await runVerifier(llmCtx(''), agent, plan(['content.startswith("NOPE")']), result(1, 'OUT: ok'), opts, planStub(), signal)).pass).toBe(false)
    const discrimination = await runVerifier(llmCtx(''), agent, plan(['True and not isinstance(content, dict)']), result(1, 'x'), opts, planStub(), signal)
    expect(discrimination.pass).toBe(false)
    expect(discrimination.reason).toContain('缺少区分度')
    expect(discrimination.reason).toContain('否定式条件')
    expect(discrimination.exceptionKind).toBe('invalid-condition')
    const errorFail = await runVerifier(llmCtx(''), agent, plan(['content == ""']), {
      isError: true,
      error: { message: 'boom' },
      content: [{ type: 'text', text: 'boom' }],
    }, opts, planStub(), signal)
    expect(errorFail.pass).toBe(false)
    expect(errorFail.reason).toContain('工具执行失败')
    const reference = await runVerifier(llmCtx(''), agent, plan(['1 + 1']), result(1, 'x'), opts, planStub(), signal)
    expect(reference.pass).toBe(false)
    expect(reference.reason).toContain('必须引用 result')
    const evalError = await runVerifier(llmCtx(''), agent, plan(['result / 0']), result(1, 'x'), opts, planStub(), signal)
    expect(evalError.pass).toBe(false)
    expect(evalError.exceptionKind).toBe('eval-error')
  })

  it('rejects an empty expression list instead of passing everything', async () => {
    const emptyAssert = verifyAssert([], payload({ isError: false, value: 5, content: 'ok' }))
    expect(emptyAssert.pass).toBe(false)
    expect(emptyAssert.exceptionKind).toBe('invalid-condition')
    expect(emptyAssert.reason).toContain('列表为空')
    // A failed tool result still fails, and the empty list is reported first.
    expect(verifyAssert([], payload({ isError: true, content: 'boom' })).reason).toContain('列表为空')
    const emptyPython = await runVerifier(llmCtx(''), agent, { kind: 'python', checks: [] }, result(1, 'ok'), opts, planStub(), signal)
    expect(emptyPython.pass).toBe(false)
    expect(emptyPython.exceptionKind).toBe('invalid-condition')
    expect(emptyPython.reason).toContain('列表为空')
  })

  it('kills a hanging python verifier at the timeout', async () => {
    const hanging = await runVerifier(llmCtx(''), agent, { kind: 'python', checks: ['content == "x" and exec("import time;time.sleep(5)") or True'] },
      result(1, 'x'), { ...opts, pythonTimeoutMs: 300 }, planStub(), signal)
    expect(hanging.pass).toBe(false)
    expect(hanging.reason).toContain('超时')
    expect(hanging.exception).toBe(true)
    expect(hanging.exceptionKind).toBe('timeout')
  })

  it('reports an unspawnable python command', async () => {
    const verdict = await runVerifier(llmCtx(''), agent, { kind: 'python', checks: ['content == "x"'] },
      result(1, 'x'), { ...opts, pythonCommand: 'lcrd-no-such-command' }, planStub(), signal)
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain('无法启动校验脚本')
    expect(verdict.exceptionKind).toBe('unspawnable')
  })

  it('runs the llm verifier: pass, fail, non-JSON, empty, missing provider, and edge payloads', async () => {
    const plan = { kind: 'llm' } as const
    const passed = await runVerifier(llmCtx('{"verdict": "PASS", "reason": "ok"}'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(passed).toEqual({ pass: true, reason: 'ok' })
    const failed = await runVerifier(llmCtx('{"verdict": "FAIL", "reason": "no"}'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(failed.pass).toBe(false)
    expect(failed.reason).toContain('no')
    const nonJson = await runVerifier(llmCtx('plain text'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(nonJson.pass).toBe(false)
    expect(nonJson.reason).toContain('未返回 JSON')
    expect(nonJson.exception).toBe(true)
    expect(nonJson.exceptionKind).toBe('bad-output')
    const empty = await runVerifier(llmCtx(''), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(empty.pass).toBe(false)
    expect(empty.reason).toContain('未返回 JSON')
    const noProvider = await runVerifier(llmCtx('{"verdict": "PASS", "reason": "ok"}'), { session: { header: {} }, options: {} } as never,
      plan, result(1, 'x'), opts, planStub(), signal)
    expect(noProvider.pass).toBe(false)
    expect(noProvider.reason).toContain('无法运行')
    expect(noProvider.exceptionKind).toBe('no-provider')
    // Non-string verdict and reason fall back to the defaults.
    const numericVerdict = await runVerifier(llmCtx('{"verdict": 123, "reason": "x"}'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(numericVerdict.pass).toBe(false)
    expect(numericVerdict.reason).toContain('x')
    const missingReason = await runVerifier(llmCtx('{"verdict": "FAIL"}'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(missingReason.pass).toBe(false)
    expect(missingReason.reason).toContain('(无理由)')
    const emptyReason = await runVerifier(llmCtx('{"verdict": "FAIL", "reason": ""}'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(emptyReason.pass).toBe(false)
    expect(emptyReason.reason).toContain('LLM 校验器判定 FAIL')
    const brokenJson = await runVerifier(llmCtx('{"verdict": "PASS", broken: }'), agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(brokenJson.pass).toBe(false)
    expect(brokenJson.reason).toContain('JSON 解析失败')
    expect(brokenJson.exception).toBe(true)
    expect(brokenJson.exceptionKind).toBe('bad-output')
    // A non-text-delta chunk is skipped.
    const mixedStream = await runVerifier({ llm: { async *stream() { yield { type: 'reasoning', text: 'x' }; yield { type: 'text-delta', text: '{"verdict": "PASS", "reason": "ok"}' } } } } as unknown as Context,
      agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(mixedStream).toEqual({ pass: true, reason: 'ok' })
  })
})

/** Minimal declared plan fixture for verifier tests. */
type StepPlanFixture = { kind: 'assert'; conditions: string[] } | { kind: 'python'; checks: string[] } | { kind: 'llm' }
function planStub(): never {
  return { goal: 'g', stop_condition: 's', feasibility: true, verifier: { kind: 'assert', conditions: ['true'] } } as never
}

describe('FlowRecorder', () => {
  const agent = { id: 'session-test', session: { header: {} }, options: {} } as never
  const goalDir = (goal: string): string => `${goal}-${shortAgentId('session-test')}`
  const push = (recorder: FlowRecorder): void => {
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'tool', name: 'read' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
  }

  it('renders a mermaid flowchart of plan, tool, verdict, and end', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    push(recorder)
    const mermaid = recorder.renderMermaid()
    expect(mermaid).toContain('lcrd_plan')
    expect(mermaid).toContain('tool: read')
    expect(mermaid).toContain('verify PASS')
    expect(mermaid).toContain('P1 --> T2')
    expect(mermaid).toContain('会话结束')
  })

  it('renders a FAIL verdict with the retry count', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'verdict', pass: false, reason: 'nope', count: 1 })
    expect(recorder.renderMarkdown()).toContain('FAIL (1/3)')
  })

  it('renders the markdown report with an event timeline', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    push(recorder)
    const markdown = recorder.renderMarkdown()
    expect(markdown).toContain('# LCRD 执行流程')
    expect(markdown).toContain('| 1 | `plan` |')
    expect(markdown).toContain('| 3 | `verdict` | PASS: ok')
  })

  it('dumps md, mmd, and json artifacts into a goal-named subfolder with a unique agent suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      push(recorder)
      recorder.dump()
      recorder.dump()
      const folder = goalDir('g')
      const files = readdirSync(join(dir, folder)).sort()
      expect(files).toEqual([
        'lcrd-flow.json',
        'lcrd-flow.jsonl',
        'lcrd-flow.md',
        'lcrd-flow.mmd',
        'run.json',
      ])
      const json = JSON.parse(readFileSync(join(dir, folder, 'lcrd-flow.json'), 'utf8')) as DumpJson
      expect(json.events).toHaveLength(3)
      expect(json.md_file).toBe('lcrd-flow.md')
      expect(json.final_verdict).toBe('pass')
      expect(json.task_id).toBe('g')
      expect(readFileSync(join(dir, folder, 'lcrd-flow.md'), 'utf8')).toContain('```mermaid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites the artifacts with later events on every dump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
      recorder.dump()
      recorder.push({ type: 'tool', name: 'read' })
      recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
      recorder.dump()
      const json = JSON.parse(readFileSync(join(dir, goalDir('g'), 'lcrd-flow.json'), 'utf8')) as DumpJson
      expect(json.events).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps distinct folders for two agents sharing the same goal, never overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const first = new FlowRecorder({ id: 'session-a', session: { header: {} }, options: {} } as never, 3, { outDir: dir })
      const second = new FlowRecorder({ id: 'session-b', session: { header: {} }, options: {} } as never, 3, { outDir: dir })
      const plan = { type: 'plan', goal: '同一个 goal', stop: 's', feasibility: true, verifier: 'assert' } as const
      first.push(plan)
      first.push({ type: 'tool', name: 'read' })
      first.dump()
      second.push(plan)
      second.push({ type: 'tool', name: 'write' })
      second.dump()
      const firstFolder = `同一个 goal-${shortAgentId('session-a')}`
      const secondFolder = `同一个 goal-${shortAgentId('session-b')}`
      expect(firstFolder).not.toBe(secondFolder)
      expect(readFileSync(join(dir, firstFolder, 'lcrd-flow.mmd'), 'utf8')).toContain('tool: read')
      expect(readFileSync(join(dir, secondFolder, 'lcrd-flow.mmd'), 'utf8')).toContain('tool: write')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the agent id (session-uuid) subfolder when no goal is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      recorder.push({ type: 'tool', name: 'read' })
      recorder.dump()
      expect(readdirSync(join(dir, 'session-test')).sort()).toEqual([
        'lcrd-flow.json',
        'lcrd-flow.jsonl',
        'lcrd-flow.md',
        'lcrd-flow.mmd',
        'run.json',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes each logged line to the goal-named .log file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      recorder.push({ type: 'plan', goal: '任务甲', stop: 's', feasibility: true, verifier: 'assert' })
      recorder.log('[LCRD] plan: 任务甲')
      recorder.log('[LCRD] verify PASS')
      const content = readFileSync(join(dir, goalDir('任务甲'), 'lcrd-flow.log'), 'utf8')
      expect(content).toContain('[LCRD] plan: 任务甲')
      expect(content).toContain('[LCRD] verify PASS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records intercepted tool calls and marks the session terminated', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.push({ type: 'intercept', kind: 'terminated', detail: '3 次失败' })
    expect(recorder.renderMarkdown()).toContain('任务终止转人工')
    expect(recorder.renderMermaid()).toContain('任务终止转人工')
  })

  it('renders learning declarations and self-evaluations in the flow', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.push({ type: 'learn', analysis: 'a', knowledge: 'k', method: 'web_search', criteria: 'c' })
    recorder.push({ type: 'learn-verify', learned: false, evidence: 'not yet', count: 1 })
    recorder.push({ type: 'learn-verify', learned: true, evidence: 'got it' })
    expect(recorder.renderMermaid()).toContain('lcrd_learn')
    expect(recorder.renderMermaid()).toContain('learn FAIL 1/3')
    expect(recorder.renderMermaid()).toContain('learn PASS')
    expect(recorder.renderMarkdown()).toContain('analysis=a / knowledge=k / method=web_search / criteria=c')
    expect(recorder.renderMarkdown()).toContain('FAIL (1/3): not yet')
    expect(recorder.renderMarkdown()).toContain('PASS: got it')
  })

  it('tracks learning meta fields from configuration and events', () => {
    const recorder = new FlowRecorder(agent, 3, {
      outDir: unitOutDir,
      learningEnabled: true,
      learningThreshold: 5,
      maxLearningAttempts: 2,
    })
    recorder.push({ type: 'learn', analysis: 'a', knowledge: 'k', method: 'read', criteria: 'c' })
    recorder.push({ type: 'learn-verify', learned: false, evidence: 'no', count: 1 })
    const meta = recorder.computeMeta()
    expect(meta.learning_enabled).toBe(true)
    expect(meta.learning_threshold).toBe(5)
    expect(meta.learning_attempts_max).toBe(2)
    expect(meta.learning_attempts_consumed).toBe(1)
    expect(meta.learning_success).toBe(false)
  })

  it('resets consumed learning attempts when the re-solve succeeds', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir, learningEnabled: true })
    recorder.push({ type: 'learn-verify', learned: false, evidence: 'no', count: 2 })
    recorder.markLearningSuccess()
    const meta = recorder.computeMeta()
    expect(meta.learning_attempts_consumed).toBe(0)
    expect(meta.learning_success).toBe(true)
  })
})

describe('FlowRecorder meta summary', () => {
  const agent = { id: 'session-abc', session: { header: {} }, options: {} } as never

  it('counts goal, stop, and verifier contract changes across plans', () => {
    const recorder = new FlowRecorder(agent, 10, { outDir: unitOutDir, interaction: 'auto' })
    recorder.push({ type: 'plan', goal: 'g1', stop: 's1', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['a'] } })
    recorder.push({ type: 'plan', goal: 'g2', stop: 's1', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['a'] } }) // goal changed
    recorder.push({ type: 'plan', goal: 'g2', stop: 's2', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['a'] } }) // stop changed
    recorder.push({ type: 'plan', goal: 'g2', stop: 's2', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['b'] } }) // verifier changed
    const meta = recorder.computeMeta()
    expect(meta.goal_changed_times).toBe(1)
    expect(meta.stop_changed_times).toBe(1)
    expect(meta.verifier_changed_times).toBe(1)
    expect(meta.human_interaction_mode).toBe('auto')
    expect(meta.session_id).toBe('session-abc')
    expect(meta.lcrd_retry_max).toBe(10)
  })

  it('tracks ask interception, verifier exceptions, retry consumption, and verdict', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.markAskIntercepted()
    recorder.markVerifierException()
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'verdict', pass: false, reason: 'nope', count: 2 })
    const meta = recorder.computeMeta()
    expect(meta.hit_ask_intercepted).toBe(true)
    expect(meta.has_verifier_exception).toBe(true)
    expect(meta.lcrd_retry_consumed).toBe(2)
    expect(meta.final_verdict).toBe('fail')
  })

  it('derives a terminated verdict and full retry budget on termination', () => {
    const recorder = new FlowRecorder(agent, 5, { outDir: unitOutDir })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'intercept', kind: 'terminated', detail: '3 次失败' })
    const meta = recorder.computeMeta()
    expect(meta.final_verdict).toBe('terminated')
    expect(meta.lcrd_retry_consumed).toBe(5)
  })

  it('carries the external reward and root-cause hint when supplied', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir, tbFinalReward: 1.0, rootCauseHint: 'verifier_code_generation_bug' })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
    const meta = recorder.computeMeta()
    expect(meta.tb_final_reward).toBe(1.0)
    expect(meta.root_cause_hint).toBe('verifier_code_generation_bug')
    expect(meta.final_verdict).toBe('pass')
  })
})

describe('file-flow guard (real composition)', () => {
  const agent = { id: 'agent-guard', session: { header: {}, events: [] }, options: {} } as never
  const dirs: string[] = []

  /** Mount the real system-prompt, tools, llm, and local-filesystem services plus the lcrd plugin. */
  async function setup(options?: { fileFlowTools?: string[]; fileFlowEnabled?: boolean }) {
    const workDir = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const logDir = mkdtempSync(join(tmpdir(), 'lcrd-flow-log-'))
    const flowRoot = join(dirname(logDir), 'task-flow')
    dirs.push(workDir, logDir, flowRoot)
    const toolName = options?.fileFlowTools?.[0] ?? 'str_replace_editor'
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    await ctx.plugin(lcrd, { fileFlowEnabled: options?.fileFlowEnabled ?? true, logDir, ...options })
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

  afterEach(() => {
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
      callId: CallId(`guard-${Math.random().toString(36).slice(2, 8)}`),
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
      callId: CallId(`plan-${Math.random().toString(36).slice(2, 8)}`),
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
    const workDir = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const logDir = mkdtempSync(join(tmpdir(), 'lcrd-flow-log-'))
    dirs.push(workDir, logDir)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: 'D:/sandbox-workspace' })
    await ctx.plugin(lcrd, { fileFlowEnabled: true, logDir })
    const assembly = await ctx.get('systemPrompt')!.assemble({ agent, scope: agent })
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
    const workDir = mkdtempSync(join(tmpdir(), 'lcrd-guard-'))
    const logDir = mkdtempSync(join(tmpdir(), 'lcrd-flow-log-'))
    dirs.push(workDir, logDir)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: workDir })
    const { registerFileFlowSection } = await import('@deepseek-ai/dsh-lcrd/src/file-flow.ts')
    registerFileFlowSection(ctx, join(dirname(logDir), 'task-flow'))
    const assembly = await ctx.get('systemPrompt')!.assemble({ agent, scope: agent })
    const section = assembly.sections.find(entry => entry.name === 'lcrd-file-flow')
    expect(section?.text).toContain('taskflow-<uuid>')
    expect(section?.text).not.toContain('当前工作目录绝对路径')
  })
})

/** One recorded event as read back from the append-only stream of a composition run. */
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

describe('learning mode and protocol gates (real composition)', () => {
  const agentSession = { header: {}, events: [] }
  const agent = { id: 'agent-learning', session: agentSession, options: {} } as never
  /** Loose emit helper: test fixtures are not full Session/SessionEvent instances. */
  const fireEvent = (ctx: Context, name: string, ...args: unknown[]): void => {
    const emit = (ctx as unknown as { emit: (...a: unknown[]) => void }).emit
    emit(name, ...args)
  }
  const dirs: string[] = []

  /** Mount the plugin with learning enabled at a low threshold plus the file and learning fixture tools. */
  async function setupLearning(options?: { maxLearningAttempts?: number; interaction?: 'auto' | 'auth' | 'manual'; learningEnabled?: boolean; maxRetries?: number; failedCheckConsumesRetry?: boolean; datasetExport?: 'off' | 'run'; datasetDir?: string; attributionModule?: string; hooksModule?: string }) {
    const workDir = mkdtempSync(join(tmpdir(), 'lcrd-learn-'))
    const logDir = mkdtempSync(join(tmpdir(), 'lcrd-flow-log-'))
    const flowRoot = join(dirname(logDir), 'task-flow')
    dirs.push(workDir, logDir, flowRoot)
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
    })
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

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function runTool(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    const result: ToolExecutionResult = await ctx.tools.execute({
      callId: CallId(`learn-${Math.random().toString(36).slice(2, 8)}`),
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

  /** Declare a plan whose assert can never pass, driving one verifier failure. */
  async function declareFailingPlan(ctx: Context): Promise<void> {
    await runTool(ctx, 'lcrd_plan', {
      goal: '必然失败',
      stop_condition: '结果等于 999',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 999'] },
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
    await declareFailingPlan(ctx)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx)
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
    // New round with evidence passes and returns to resolve phase.
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '再学一轮',
      knowledge_needed: '写法',
      learning_method: '读文件',
      eval_criteria: '写出正确条件',
    })
    await runTool(ctx, 'glob', { path: join(workDir, '**') })
    const passed = await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: '已会' })
    expect(passed.isError).toBe(false)
    expect(passed.text).toContain('自评通过')
    // Re-solve failure consumes one learning round, resets the phase, and returns to learn mode.
    await declareFailingPlan(ctx)
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
    await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: '学会了' })
    await declareFailingPlan(ctx)
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
    await declareFailingPlan(ctx)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx)
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
      callId: CallId('session-agent'),
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
    await declareFailingPlan(ctx)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await declareFailingPlan(ctx)
    await runTool(ctx, 'str_replace_editor', { path: product, command: 'create' })
    await runTool(ctx, 'lcrd_learn', {
      problem_analysis: '写法',
      knowledge_needed: '语义',
      learning_method: '读文件',
      eval_criteria: '写出合法条件',
    })
    await runTool(ctx, 'read', { path: join(workDir, 'doc.md') })
    await runTool(ctx, 'lcrd_learn_verify', { learned: true, evidence: '已会' })
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

  it('rejects invalid plugin configuration at load', async () => {
    const bad = async (config: Record<string, unknown>): Promise<string> => {
      const workDir = mkdtempSync(join(tmpdir(), 'lcrd-learn-'))
      dirs.push(workDir)
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: workDir })
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
  })

  it('rejects protocol tools executed without an agent scope, and accepts llm and python verifier plans', async () => {
    const { ctx } = await setupLearning()
    const textOf = (result: ToolExecutionResult): string =>
      result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    const plan = await ctx.tools.execute({
      callId: CallId('no-agent'), name: 'lcrd_plan', arguments: {
        goal: 'g', stop_condition: 's', feasibility: true, verifier: { kind: 'llm' },
      }, signal: new AbortController().signal,
    })
    expect(plan.isError).toBe(true)
    expect(textOf(plan)).toContain('requires an agent-scoped execution')
    const learn = await ctx.tools.execute({
      callId: CallId('no-agent-2'), name: 'lcrd_learn', arguments: {
        problem_analysis: 'a', knowledge_needed: 'b', learning_method: 'c', eval_criteria: 'd',
      }, signal: new AbortController().signal,
    })
    expect(learn.isError).toBe(true)
    expect(textOf(learn)).toContain('requires an agent-scoped execution')
    const verify = await ctx.tools.execute({
      callId: CallId('no-agent-3'), name: 'lcrd_learn_verify', arguments: { learned: true, evidence: 'e' },
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
    void ctx.waterfall(agent, 'agent/pre-step', { agent, messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'plugin' as const, plugin: 'lcrd-hard-isolation' } })], turn: 1, step: 0, signal: new AbortController().signal }, () => ({ kind: 'allow' } as never))
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
    expect(snapshot.schema_version).toBe(2)
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
      verifier: { kind: 'assert', conditions: ['true'] },
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
    expect(verdicts[0]).toMatchObject({ verifierKind: 'assert', tool: 'read', exceptionKind: 'invalid-condition' })
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
      verifier: { kind: 'assert', conditions: ['true'] },
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

describe('FlowRecorder edge branches', () => {
  const agent = { id: 'session-edge', session: { header: {} }, options: {} } as never

  it('keeps the agent id when the plan goal slugifies empty, and tolerates a plan as the first event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      recorder.push({ type: 'plan', goal: '   ', stop: 's', feasibility: true, verifier: 'assert' })
      recorder.dump()
      expect(readdirSync(dir)).toContain('session-edge')
      expect(recorder.computeMeta().task_id).toBe('session-edge')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts verifier changes across plan declarations with and without verifier specs', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['a'] } })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'python', verifierSpec: { kind: 'python', checks: ['b'] } })
    expect(recorder.computeMeta().verifier_changed_times).toBe(1)
    const bare = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    bare.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    bare.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'python' })
    expect(bare.computeMeta().verifier_changed_times).toBe(1)
  })

  it('renders every intercept kind and count-bearing verdicts and learn-verifies in mermaid', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir, learningEnabled: true, maxLearningAttempts: 2 })
    recorder.push({ type: 'intercept', kind: 'missing-plan', detail: 'm' })
    recorder.push({ type: 'intercept', kind: 'infeasible', detail: 'i' })
    recorder.push({ type: 'verdict', pass: false, reason: 'r', count: 1 })
    recorder.push({ type: 'learn-verify', learned: false, evidence: 'e', count: 1 })
    const mermaid = recorder.renderMermaid()
    expect(mermaid).toContain('拦截: 未声明计划')
    expect(mermaid).toContain('拦截: 计划不可行')
    expect(mermaid).toContain('verify FAIL 1/3')
    expect(mermaid).toContain('learn FAIL 1/2')
    const markdown = recorder.renderMarkdown()
    expect(markdown).toContain('FAIL (1/3): r')
    expect(markdown).toContain('FAIL (1/2): e')
    expect(markdown).toContain('missing-plan: m')
    // Count-less verdicts and learn-verifies render without the counter.
    const bare = new FlowRecorder(agent, 3, { outDir: unitOutDir, learningEnabled: true })
    bare.push({ type: 'verdict', pass: false, reason: 'r' })
    bare.push({ type: 'learn-verify', learned: false, evidence: 'e' })
    const bareMermaid = bare.renderMermaid()
    expect(bareMermaid).toContain('verify FAIL')
    expect(bareMermaid).not.toContain('FAIL 1/3')
    expect(bareMermaid).toContain('learn FAIL')
    expect(bareMermaid).not.toContain('FAIL 1/3')
  })

  it('derives a pass verdict when no terminal intercept is recorded and the last verdict passed', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: unitOutDir })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
    expect(recorder.computeMeta().final_verdict).toBe('pass')
  })
})
