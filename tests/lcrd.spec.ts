import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Config,
  FlowRecorder,
  resultPayload,
  shortAgentId,
  verifyAssert,
  type VerifyPayload,
} from '@deepseek-ai/dsh-lcrd'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

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

  it('treats an error result as undefined for the payload value', () => {
    const verdict = verifyAssert(['result === undefined'], {
      isError: true,
      value: undefined,
      content: 'boom',
    })
    expect(verdict.pass).toBe(true)
  })
})

describe('FlowRecorder', () => {
  const agent = { id: 'session-test' } as never
  const goalDir = (goal: string): string => `${goal}-${shortAgentId('session-test')}`
  const push = (recorder: FlowRecorder): void => {
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'tool', name: 'read' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
  }

  it('renders a mermaid flowchart of plan, tool, verdict, and end', () => {
    const recorder = new FlowRecorder(agent, 3)
    push(recorder)
    const mermaid = recorder.renderMermaid()
    expect(mermaid).toContain('lcrd_plan')
    expect(mermaid).toContain('tool: read')
    expect(mermaid).toContain('verify PASS')
    expect(mermaid).toContain('P1 --> T2')
    expect(mermaid).toContain('会话结束')
  })

  it('renders a FAIL verdict with the retry count', () => {
    const recorder = new FlowRecorder(agent, 3)
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'verdict', pass: false, reason: 'nope', count: 1 })
    expect(recorder.renderMarkdown()).toContain('FAIL (1/3)')
  })

  it('renders the markdown report with an event timeline', () => {
    const recorder = new FlowRecorder(agent, 3)
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
        'lcrd-flow.md',
        'lcrd-flow.mmd',
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
      const first = new FlowRecorder({ id: 'session-a' } as never, 3, { outDir: dir })
      const second = new FlowRecorder({ id: 'session-b' } as never, 3, { outDir: dir })
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

  it('falls back to the agent id for the subfolder when no goal is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-flow-'))
    try {
      const recorder = new FlowRecorder(agent, 3, { outDir: dir })
      recorder.push({ type: 'tool', name: 'read' })
      recorder.dump()
      expect(readdirSync(join(dir, 'session-test')).sort()).toEqual([
        'lcrd-flow.json',
        'lcrd-flow.md',
        'lcrd-flow.mmd',
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
    const recorder = new FlowRecorder(agent, 3)
    recorder.push({ type: 'intercept', kind: 'terminated', detail: '3 次失败' })
    expect(recorder.renderMarkdown()).toContain('任务终止转人工')
    expect(recorder.renderMermaid()).toContain('任务终止转人工')
  })
})

describe('FlowRecorder meta summary', () => {
  const agent = { id: 'session-abc' } as never

  it('counts goal, stop, and verifier contract changes across plans', () => {
    const recorder = new FlowRecorder(agent, 10, { interaction: 'auto' })
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
    const recorder = new FlowRecorder(agent, 3)
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
    const recorder = new FlowRecorder(agent, 5)
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'intercept', kind: 'terminated', detail: '3 次失败' })
    const meta = recorder.computeMeta()
    expect(meta.final_verdict).toBe('terminated')
    expect(meta.lcrd_retry_consumed).toBe(5)
  })

  it('carries the external reward and root-cause hint when supplied', () => {
    const recorder = new FlowRecorder(agent, 3, { tbFinalReward: 1.0, rootCauseHint: 'verifier_code_generation_bug' })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok' })
    const meta = recorder.computeMeta()
    expect(meta.tb_final_reward).toBe(1.0)
    expect(meta.root_cause_hint).toBe('verifier_code_generation_bug')
    expect(meta.final_verdict).toBe('pass')
  })
})
