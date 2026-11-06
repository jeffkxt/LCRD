/**
 * Plugin unit surface: configuration defaults, the result projection the
 * verifiers evaluate, and the file-flow prompt section text.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config, fileFlowSectionText, resultPayload } from '@deepseek-ai/dsh-experimental-lcrd'

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

  it('defaults the declaration gates off and accepts explicit values', () => {
    const config = Config({})
    expect(config.rejectPresenceOnly).toBe(false)
    expect(config.declarationMaxHoldRate).toBeUndefined()
    expect(Config({ rejectPresenceOnly: true }).rejectPresenceOnly).toBe(true)
    expect(Config({ declarationMaxHoldRate: 0.5 }).declarationMaxHoldRate).toBe(0.5)
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

