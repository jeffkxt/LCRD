import { describe, expect, it } from 'vitest'
import {
  terminatedToolBlocked,
  terminateWith,
  hookErrorExhausted,
  hookBlockedExhausted,
  invalidChecksExhausted,
  learningExhausted,
  maxRetriesTerminated,
} from '../src/step-terminate.ts'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

/** Serialized feedback carried by a block decision; throws for any other kind. */
function blockFeedbackText(decision: PostToolDecision): string {
  if (decision.kind !== 'block') throw new Error('expected block decision')
  return JSON.stringify(decision.feedback)
}

describe('terminatedToolBlocked', () => {
  it('returns a block feedback decision', () => {
    const result = terminatedToolBlocked()
    expect(result.kind).toBe('block')
    expect(blockFeedbackText(result)).toContain('任务已终止')
  })
})

describe('terminateWith', () => {
  it('marks the agent terminated and returns the decision', () => {
    const terminated = new WeakSet()
    const agent = { id: 'agent-1' } as never
    const decision = terminatedToolBlocked()
    const result = terminateWith(terminated, agent, decision)
    expect(terminated.has(agent)).toBe(true)
    expect(result).toBe(decision)
  })
})

describe('hookErrorExhausted', () => {
  it('returns undefined when count is below maxRetries', () => {
    expect(hookErrorExhausted(1, 3, 'error')).toBeUndefined()
  })

  it('returns a terminal notice when count reaches maxRetries', () => {
    const result = hookErrorExhausted(3, 3, 'boom')
    expect(result).not.toBeUndefined()
    expect((result as PostToolDecision).kind).toBe('block')
    expect(blockFeedbackText(result as PostToolDecision)).toContain('3 次')
  })
})

describe('hookBlockedExhausted', () => {
  it('returns undefined when count is below maxRetries', () => {
    expect(hookBlockedExhausted(2, 3, 'blocked')).toBeUndefined()
  })

  it('returns a terminal notice when count reaches maxRetries', () => {
    const result = hookBlockedExhausted(3, 3, 'denied')
    expect(result).not.toBeUndefined()
    expect((result as PostToolDecision).kind).toBe('block')
  })
})

describe('invalidChecksExhausted', () => {
  it('returns a terminal notice with the reason', () => {
    const result = invalidChecksExhausted(3, 'bad check')
    expect(result.kind).toBe('block')
    expect(blockFeedbackText(result)).toContain('3 次断言')
  })
})

describe('learningExhausted', () => {
  it('returns a terminal notice with the learning attempts', () => {
    const result = learningExhausted(3, 'still fails')
    expect(result.kind).toBe('block')
    expect(blockFeedbackText(result)).toContain('3 次')
  })
})

describe('maxRetriesTerminated', () => {
  it('returns a terminal notice with the retry count', () => {
    const result = maxRetriesTerminated(5, 'all fail')
    expect(result.kind).toBe('block')
    expect(blockFeedbackText(result)).toContain('5 次')
  })
})
