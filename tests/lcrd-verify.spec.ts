/**
 * Assertion verifier and file-flow path classification: the probe matrix,
 * failure localization, and the task-directory path classes.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyFlowPath, verifyAssert, type VerifyPayload } from '@deepseek-ai/dsh-experimental-lcrd'

const payload = (overrides: Partial<VerifyPayload>): VerifyPayload => ({
  isError: false,
  value: 1,
  content: 'x',
  ...overrides,
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

  it('carries the rewrite hint of a rejected condition and of a refused runtime access', () => {
    // A grammar rejection that names the rewrite.
    const loose = verifyAssert(['result == 5'], payload({ value: 5 }))
    expect(loose.pass).toBe(false)
    expect(loose.reason).toContain(';请使用 === 或 !==')
    // A runtime rejection with its own hint (the prototype route), and one with none.
    const forbidden = verifyAssert(["result[{}.nope ?? 'constructor']"], payload({ value: {} }))
    expect(forbidden.pass).toBe(false)
    expect(forbidden.reason).toContain('原型链')
    const missing = verifyAssert(['result.get("a")'], payload({ value: [] }))
    expect(missing.pass).toBe(false)
    expect(missing.reason).toContain('is not a function')
    // A native throw out of a whitelisted method is not an ExpressionError.
    const native = verifyAssert(['result.map("x")'], payload({ value: [1] }))
    expect(native.pass).toBe(false)
    expect(native.reason).toContain('求值失败')
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

