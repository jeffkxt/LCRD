/**
 * Recorder surface: event stamping, the dumped snapshot and its stream, the
 * meta summary, and the edge branches of the record path.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FlowRecorder, shortAgentId } from '@deepseek-ai/dsh-experimental-lcrd'

const unitOutDir = mkdtempSync(join(tmpdir(), 'lcrd-unit-'))

interface DumpJson {
  events: unknown[]
  md_file: string
  final_verdict: string
  task_id: string
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
