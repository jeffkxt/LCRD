import { describe, expect, it } from 'vitest'
import {
  textBlock,
  blockFeedback,
  blockNotice,
  denyDecision,
  PLUGIN_SOURCE,
} from '../src/notice.ts'

describe('textBlock', () => {
  it('returns a typed text content block', () => {
    expect(textBlock('hello')).toEqual({ type: 'text', text: 'hello' })
  })
})

describe('blockFeedback', () => {
  it('returns a block decision with feedback only', () => {
    const result = blockFeedback('fix this')
    expect(result.kind).toBe('block')
    if (result.kind !== 'block') throw new Error('expected block decision')
    expect(result.feedback).toEqual([{ type: 'text', text: 'fix this' }])
    expect(result.additionalContexts).toBeUndefined()
  })
})

describe('blockNotice', () => {
  it('returns a block decision with feedback and a durable notice', () => {
    const result = blockNotice('try again', 'please retry', 'summary')
    expect(result.kind).toBe('block')
    if (result.kind !== 'block') throw new Error('expected block decision')
    expect(result.feedback).toEqual([{ type: 'text', text: 'try again' }])
    const contexts = result.additionalContexts ?? []
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.source).toEqual({ kind: 'lcrd-hard-isolation', form: 'notice', summary: 'summary' })
  })
})

describe('denyDecision', () => {
  it('returns a deny decision with the reason', () => {
    const result = denyDecision('out of scope')
    expect(result.kind).toBe('deny')
    if (result.kind !== 'deny') throw new Error('expected deny decision')
    expect(result.reason).toBe('out of scope')
  })
})

describe('PLUGIN_SOURCE', () => {
  it('has the correct kind', () => {
    expect(PLUGIN_SOURCE).toEqual({ kind: 'lcrd-hard-isolation' })
  })
})
