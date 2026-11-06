import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { verifyAssert, type VerifyPayload } from '@deepseek-ai/dsh-experimental-lcrd'
// Pulls the package entry so its MessageSourceMap augmentation is in scope for createUserMessage sources below.
import '@deepseek-ai/dsh-experimental-lcrd'
import { runVerifier } from '../src/verifiers.ts'

const payload = (overrides: Partial<VerifyPayload>): VerifyPayload => ({
  isError: false,
  value: 1,
  content: 'x',
  ...overrides,
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
  }) as never

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

  it('scrubs credential-shaped and DSH_* env vars from the python verifier child', async () => {
    process.env.FAKE_API_KEY = 'leaked-secret'
    process.env.DSH_FAKE = 'leaked-dsh'
    try {
      const verdict = await runVerifier(llmCtx(''), agent, {
        kind: 'python',
        checks: ['content == "x" and __import__("os").environ.get("FAKE_API_KEY") is None and __import__("os").environ.get("DSH_FAKE") is None and bool(__import__("os").environ.get("PATH"))'],
      }, result(1, 'x'), opts, planStub(), signal)
      expect(verdict.pass).toBe(true)
    } finally {
      delete process.env.FAKE_API_KEY
      delete process.env.DSH_FAKE
    }
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
    const mixedStream = await runVerifier({ llm: { async *stream() { yield { type: 'reasoning', text: 'x' }; yield { type: 'text-delta', text: '{"verdict": "PASS", "reason": "ok"}' } } } } as never,
      agent, plan, result(1, 'x'), opts, planStub(), signal)
    expect(mixedStream).toEqual({ pass: true, reason: 'ok' })
  })
})

/** Minimal declared plan fixture for verifier tests. */
type StepPlanFixture = { kind: 'assert'; conditions: string[] } | { kind: 'python'; checks: string[] } | { kind: 'llm' }
function planStub(): never {
  return { goal: 'g', stop_condition: 's', feasibility: true, verifier: { kind: 'assert', conditions: ['true'] } } as never
}

