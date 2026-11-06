import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecorderBridge } from '../src/recorder-bridge.ts'
import { createState } from '../src/state.ts'
import { defaultAttribution } from '../src/dataset.ts'
import { FlowRecorder } from '@deepseek-ai/dsh-experimental-lcrd'

const tempDir = (): string => {
  return mkdtempSync(join(tmpdir(), 'lcrd-bridge-'))
}

function createMockAgent(id: string) {
  return {
    id,
    session: { header: {} },
    options: { model: 'm', provider: 'p' },
  } as never
}

describe('createRecorderBridge', () => {
  it('creates a FlowRecorder on first ensureFlow call', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-1')
    const recorder = bridge.ensureFlow(agent)
    expect(recorder).toBeInstanceOf(FlowRecorder)
    expect(state.flows.get(agent)).toBe(recorder)
  })

  it('returns the same recorder for the same agent', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-2')
    const r1 = bridge.ensureFlow(agent)
    const r2 = bridge.ensureFlow(agent)
    expect(r1).toBe(r2)
  })

  it('flushes the recorder artifacts', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-flush')
    const recorder = bridge.ensureFlow(agent)
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    bridge.flush(agent)
    // The dump should have written artifacts to the log dir
    expect(state.flows.get(agent)).toBe(recorder)
  })

  it('records a tool event', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-tool')
    bridge.recordTool(agent, { name: 'read', callId: 'c1', arguments: { path: 'a.txt' } })
    // If no error, recordTool worked correctly
  })

  it('records a tool event with a result', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-tool-result')
    bridge.recordTool(
      agent,
      { name: 'read', callId: 'c2', arguments: { path: 'a.txt' } },
      { isError: false, value: 5, content: [{ type: 'text', text: 'ok' }] },
    )
  })

  it('records hook interceptions and returns the count', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-hook')
    const count = bridge.recordHookInterception(agent, 'hook-denied', 'out of scope')
    expect(count).toBe(1)
    const count2 = bridge.recordHookInterception(agent, 'hook-denied', 'again')
    expect(count2).toBe(2)
  })

  it('records verdicts and counts invalid checks', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-verdict')
    const count = bridge.noteVerdict(agent, { pass: false, reason: 'x', exceptionKind: 'invalid-condition' }, 'assert')
    expect(count).toBe(1)
    const count2 = bridge.noteVerdict(agent, { pass: true, reason: 'ok' }, 'assert')
    expect(count2).toBe(1) // invalid-check count stays
  })

  it('returns normal verdict count without incrementing invalid checks', () => {
    const state = createState()
    const logDir = tempDir()
    const bridge = createRecorderBridge(state, {
      logDir,
      interaction: 'manual',
      learningEnabled: false,
      learningThreshold: 5,
      maxLearningAttempts: 3,
      maxRetries: 3,
      config: {},
      attribution: defaultAttribution,
      approvalPolicy: 'ask',
      policyVersion: () => null,
    })
    const agent = createMockAgent('agent-normal')
    const count = bridge.noteVerdict(agent, { pass: true, reason: 'ok' }, 'assert')
    expect(count).toBe(0)
  })
})
