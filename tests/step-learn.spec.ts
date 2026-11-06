import { describe, expect, it, vi } from 'vitest'
import {
  citedEvidence,
  gateLearnPhaseTool,
  learnEvidence,
  learnPhasePlanBlocked,
  onVerifyPassLearning,
  onVerifyFailLearning,
} from '../src/step-learn.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { LearnGateDeps } from '../src/step-learn.ts'
import type { LearnEvidence, LcrdState } from '../src/state.ts'

/** One executed learning-tool result carrying citable text. */
const toolResult = (text = 'learned facts'): ToolExecutionResult =>
  ({ isError: false, value: text, content: [{ type: 'text', text }] })

function createLearningState(overrides: { phase?: 'learn' | 'resolve'; attempts?: number; evidence?: LearnEvidence[] } = {}) {
  return {
    attempts: overrides.attempts ?? 0,
    phase: overrides.phase ?? 'learn',
    evidence: overrides.evidence ?? [],
  }
}

function createDeps(overrides: {
  learningState?: ReturnType<typeof createLearningState> | null
  learningEnabled?: boolean
  learningThreshold?: number
  maxLearningAttempts?: number
  learningToolSet?: Set<string>
  recordTool?: ReturnType<typeof vi.fn>
  ensureFlow?: ReturnType<typeof vi.fn>
  flush?: ReturnType<typeof vi.fn>
} = {}): LearnGateDeps & { _agent: Agent } {
  const recordTool = (overrides.recordTool ?? vi.fn()) as never
  const ensureFlow = (overrides.ensureFlow ?? vi.fn(() => ({
    log: vi.fn(),
    push: vi.fn(),
    markLearningSuccess: vi.fn(),
  }))) as never
  const flush = (overrides.flush ?? vi.fn()) as never
  const learning: LcrdState['learning'] = new WeakMap()
  const terminated: LcrdState['terminated'] = new WeakSet()
  const agent = { id: 'agent-learn' } as never
  if (overrides.learningState !== null) {
    learning.set(agent, overrides.learningState ?? createLearningState())
  }
  return {
    state: { learning, terminated },
    bridge: { ensureFlow, flush, recordTool },
    learningEnabled: overrides.learningEnabled ?? true,
    learningThreshold: overrides.learningThreshold ?? 2,
    maxLearningAttempts: overrides.maxLearningAttempts ?? 3,
    learningToolSet: overrides.learningToolSet ?? new Set(['web_search', 'read']),
    _agent: agent,
  }
}

describe('learnPhasePlanBlocked', () => {
  it('returns a block decision with learning phase message', () => {
    const result = learnPhasePlanBlocked()
    expect(result.kind).toBe('block')
    if (result.kind !== 'block') throw new Error('expected block decision')
    expect(JSON.stringify(result.feedback)).toContain('学习阶段')
  })
})

describe('gateLearnPhaseTool', () => {
  it('returns undefined when no learning round is open', () => {
    const deps = createDeps({ learningState: null })
    const result = gateLearnPhaseTool(
      { id: 'agent' } as never,
      { name: 'read', callId: 'c1', arguments: {} },
      toolResult(),
      deps,
    )
    expect(result).toBeUndefined()
  })

  it('returns "pass" for a configured learning tool', () => {
    const deps = createDeps()
    const result = gateLearnPhaseTool(
      deps._agent,
      { name: 'read', callId: 'c1', arguments: {} },
      toolResult(),
      deps,
    )
    expect(result).toBe('pass')
  })

  it('blocks non-learning tools during the learn phase', () => {
    const deps = createDeps()
    const result = gateLearnPhaseTool(
      deps._agent,
      { name: 'str_replace_editor', callId: 'c1', arguments: {} },
      toolResult(),
      deps,
    )
    expect(result).not.toBe('pass')
    expect(result).not.toBeUndefined()
    expect((result as PostToolDecision).kind).toBe('block')
  })

  it('marks evidence when a learning tool runs', () => {
    const deps = createDeps()
    gateLearnPhaseTool(deps._agent, { name: 'read', callId: 'c1', arguments: {} }, toolResult(), deps)
    const evidence = deps.state.learning.get(deps._agent)?.evidence ?? []
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ id: 'e1', kind: 'call', label: 'read#c1' })
  })
  it('passes a learning tool that produced no citable text', () => {
    const deps = createDeps()
    expect(gateLearnPhaseTool(deps._agent, { name: 'read', callId: 'c1', arguments: {} }, toolResult('   '), deps)).toBe('pass')
    expect(deps.state.learning.get(deps._agent)?.evidence).toHaveLength(0)
  })

  it('stops citing once a round holds the maximum number of entries', () => {
    const full = Array.from({ length: 20 }, (_, index) => ({
      id: `e${String(index + 1)}`,
      kind: 'call' as const,
      label: `read#c${String(index)}`,
      digest: 'd',
      excerpt: 'x',
    }))
    const deps = createDeps({ learningState: createLearningState({ evidence: full }) })
    expect(gateLearnPhaseTool(deps._agent, { name: 'read', callId: 'c99', arguments: {} }, toolResult('facts'), deps)).toBe('pass')
    expect(deps.state.learning.get(deps._agent)?.evidence).toHaveLength(20)
  })
})

describe('learnEvidence', () => {
  const exec = (args: Record<string, unknown>) => ({ name: 'read', callId: 'c9', arguments: args })

  it('labels a file read with its path and digests the acquired text', () => {
    const entry = learnEvidence(exec({ path: '/notes/a.md' }), toolResult('facts'), 0)
    expect(entry).toMatchObject({ id: 'e1', kind: 'path', label: '/notes/a.md', excerpt: 'facts' })
    expect(entry?.digest).toMatch(/^[0-9a-f]{12}$/)
  })

  it('labels a URL fetch, falls back to the call identity, and clips a long excerpt', () => {
    expect(learnEvidence(exec({ url: 'https://example.test/x' }), toolResult('facts'), 1))
      .toMatchObject({ id: 'e2', kind: 'url', label: 'https://example.test/x' })
    expect(learnEvidence(exec({}), toolResult('facts'), 2)).toMatchObject({ kind: 'call', label: 'read#c9' })
    expect(learnEvidence(exec({}), toolResult('x'.repeat(400)), 3)?.excerpt).toHaveLength(161)
  })

  it('records nothing when the call produced no text to cite', () => {
    expect(learnEvidence(exec({}), toolResult('   '), 4)).toBeNull()
  })

  it('tolerates a call without arguments', () => {
    expect(learnEvidence({ name: 'read', callId: 'c1', arguments: null }, toolResult('facts'), 5))
      .toMatchObject({ id: 'e6', kind: 'call', label: 'read#c1' })
    expect(learnEvidence({ name: 'read', callId: 'c1', arguments: undefined }, toolResult('facts'), 6))
      .toMatchObject({ id: 'e7', kind: 'call' })
  })

  it('ignores non-text blocks when digesting the acquired text', () => {
    const reasoning: ToolExecutionResult = { isError: false, value: null, content: [{ type: 'reasoning', text: 'thinking' }] }
    expect(learnEvidence(exec({ path: '/a' }), reasoning, 0)).toBeNull()
  })

  it('cites recorded knowledge by id or by source', () => {
    const entry = learnEvidence(exec({ path: '/notes/a.md' }), toolResult('facts'), 0)
    const entries = entry === null ? [] : [entry]
    expect(citedEvidence('看了 e1 之后', entries)).toBe(entry)
    expect(citedEvidence('读了 /notes/a.md', entries)).toBe(entry)
    expect(citedEvidence('凭感觉', entries)).toBeUndefined()
  })
})

describe('onVerifyPassLearning', () => {
  it('completes an open learning round and resets the budget', () => {
    const deps = createDeps({ learningState: createLearningState({ attempts: 2, phase: 'learn' }) })
    const agent = deps._agent
    const verdict = { pass: true, reason: 'ok' } as never
    onVerifyPassLearning(agent, verdict, deps)
    expect(deps.state.learning.has(agent)).toBe(false)
    expect(deps.bridge.ensureFlow).toHaveBeenCalled()
  })

  it('is a no-op when no learning round is open', () => {
    const deps = createDeps({ learningState: null })
    const agent = deps._agent
    const verdict = { pass: true, reason: 'ok' } as never
    onVerifyPassLearning(agent, verdict, deps)
    expect(deps.bridge.ensureFlow).not.toHaveBeenCalled()
  })
})

describe('onVerifyFailLearning', () => {
  it('returns undefined when learning is off', () => {
    const deps = createDeps({ learningEnabled: false, learningState: null })
    const result = onVerifyFailLearning(deps._agent, 1, { pass: false, reason: 'x' }, deps)
    expect(result).toBeUndefined()
  })

  it('returns undefined when below threshold with no open round', () => {
    const deps = createDeps({ learningThreshold: 5, learningState: null })
    const result = onVerifyFailLearning(deps._agent, 1, { pass: false, reason: 'x' }, deps)
    expect(result).toBeUndefined()
  })

  it('enters learning mode when threshold is reached', () => {
    const deps = createDeps({ learningThreshold: 2, learningState: null })
    const result = onVerifyFailLearning(deps._agent, 2, { pass: false, reason: 'x' }, deps)
    expect(result).not.toBeUndefined()
    expect((result as PostToolDecision).kind).toBe('block')
    expect(deps.state.learning.get(deps._agent)?.phase).toBe('learn')
  })

  it('consumes one learning round when a round is already open', () => {
    const deps = createDeps({ learningState: createLearningState({ attempts: 1, phase: 'learn' }) })
    const result = onVerifyFailLearning(deps._agent, 2, { pass: false, reason: 'x' }, deps)
    expect(deps.state.learning.get(deps._agent)?.attempts).toBe(2)
    expect(result).not.toBeUndefined()
  })

  it('terminates when learning rounds are exhausted', () => {
    const deps = createDeps({ learningState: createLearningState({ attempts: 2, phase: 'learn' }), maxLearningAttempts: 3 })
    const result = onVerifyFailLearning(deps._agent, 3, { pass: false, reason: 'x' }, deps)
    // 2 attempts was the state, now +1 = 3, which is >= maxLearningAttempts (3)
    expect(result).not.toBeUndefined()
    expect((result as PostToolDecision).kind).toBe('block')
  })

  it('returns undefined when no learning round is open and below threshold', () => {
    const deps = createDeps({ learningThreshold: 5, learningEnabled: true, learningState: null })
    const result = onVerifyFailLearning(deps._agent, 1, { pass: false, reason: 'x' }, deps)
    expect(result).toBeUndefined()
  })
})
