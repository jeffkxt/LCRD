/**
 * The restricted expression language model-authored conditions are written in:
 * the grammar it accepts, the limits that bound one evaluation, and the
 * isolation property that keeps a condition out of the host process.
 */
import { describe, expect, it } from 'vitest'
import { compileExpression, ExpressionError } from '../src/expr.ts'

/** Evaluate one condition against a projection. */
const evaluate = (source: string, result: unknown, content = '', isError = false): unknown =>
  compileExpression(source)(result, content, isError)

/** The rejection message for one condition that must not compile. */
const rejection = (source: string): string => {
  try {
    compileExpression(source)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected ${source} to be rejected`)
}

describe('isolation', () => {
  it('rejects every route from a condition back to the host process', () => {
    const payloads = [
      'this.constructor.constructor("return process")().env.LCRD_SENTINEL',
      'process.env.LCRD_SENTINEL',
      'globalThis["process"]',
      'Function("return process")()',
      'import("node:fs")',
      'result.constructor.constructor("return process")()',
      'result["constructor"]',
      'result.__proto__.constructor',
      'isError.call(null)',
      'content.apply(null)',
      'result.bind(null)',
    ]
    for (const payload of payloads) {
      expect(rejection(payload)).not.toBe('')
    }
  })

  it('cannot express a loop, so a condition can never hang the event loop', () => {
    expect(rejection('(() => { for(;;){} })()')).toContain('箭头函数体只支持单个表达式')
    expect(rejection('(function(){ while(true){} })()')).toContain('不支持的变量名')
    expect(rejection('(() => { let i = 0 })()')).toContain('箭头函数体只支持单个表达式')
  })

  it('leaves the host environment untouched while rejecting a payload', () => {
    process.env.LCRD_SENTINEL = 'unchanged'
    rejection('this.constructor.constructor("return process")().env.LCRD_SENTINEL')
    expect(process.env.LCRD_SENTINEL).toBe('unchanged')
    delete process.env.LCRD_SENTINEL
  })

  it('refuses a property that resolves to a forbidden name at runtime', () => {
    expect(() => evaluate("result[{}.missing ?? 'constructor']", { a: 1 })).toThrow('不允许访问属性 constructor')
    expect(() => evaluate("result[{}.missing ?? 'prototype']", { a: 1 })).toThrow('不允许访问属性 prototype')
  })

  it('refuses a forbidden property name in an object literal', () => {
    expect(rejection('({ constructor: 1 })')).toContain('不允许使用属性名 constructor')
  })

  it('refuses a call on a function value', () => {
    const fn = (): number => 1
    expect(() => evaluate('result.toString()', fn)).toThrow('不允许在函数值上调用方法')
  })
})

describe('grammar', () => {
  it('reads the three bindings', () => {
    expect(evaluate('result', 5)).toBe(5)
    expect(evaluate('content', undefined, 'text')).toBe('text')
    expect(evaluate('isError', undefined, '', true)).toBe(true)
  })

  it('reads literals and constants', () => {
    expect(evaluate('result === undefined', undefined)).toBe(true)
    expect(evaluate('result === null', null)).toBe(true)
    expect(evaluate('result === true', true)).toBe(true)
    expect(evaluate('result === false', false)).toBe(true)
    expect(evaluate('Number.isNaN(result)', Number.NaN)).toBe(true)
    expect(evaluate('result === Infinity', Number.POSITIVE_INFINITY)).toBe(true)
    expect(evaluate('result === 1.5', 1.5)).toBe(true)
    expect(evaluate('result === 1e3', 1000)).toBe(true)
  })

  it('reads single, double, and backtick strings, with escapes', () => {
    expect(evaluate("result === 'x'", 'x')).toBe(true)
    expect(evaluate('result === "x"', 'x')).toBe(true)
    expect(evaluate('result === `x`', 'x')).toBe(true)
    expect(evaluate('result === "a\\nb"', 'a\nb')).toBe(true)
    expect(evaluate('result === "a\\qb"', 'aqb')).toBe(true)
  })

  it('refuses an interpolated or unterminated template string', () => {
    expect(rejection('result === `a${result}b`')).toContain('不支持模板字符串插值')
    expect(rejection('result === `abc')).toContain('模板字符串未闭合')
  })

  it('refuses an unterminated string', () => {
    expect(rejection('result === "abc')).toContain('字符串未闭合')
  })

  it('reads comparison, arithmetic, and logical operators', () => {
    expect(evaluate('result === 5', 5)).toBe(true)
    expect(evaluate('result !== 5', 5)).toBe(false)
    expect(evaluate('result < 10', 5)).toBe(true)
    expect(evaluate('result > 10', 5)).toBe(false)
    expect(evaluate('result <= 5', 5)).toBe(true)
    expect(evaluate('result >= 5', 5)).toBe(true)
    expect(evaluate('result + 1', 5)).toBe(6)
    expect(evaluate('result - 1', 5)).toBe(4)
    expect(evaluate('result * 2', 5)).toBe(10)
    expect(evaluate('result / 2', 5)).toBe(2.5)
    expect(evaluate('result % 2', 5)).toBe(1)
    expect(evaluate('!result', false)).toBe(true)
    expect(evaluate('-result', 5)).toBe(-5)
    expect(evaluate('+result', 5)).toBe(5)
    expect(evaluate('typeof result', 5)).toBe('number')
  })

  it('short-circuits && || ?? and reads the ternary', () => {
    expect(evaluate('result === 5 && result > 1', 5)).toBe(true)
    expect(evaluate('result === 6 && result > 1', 5)).toBe(false)
    expect(evaluate('result || "fallback"', 0)).toBe('fallback')
    expect(evaluate('result || "fallback"', 5)).toBe(5)
    expect(evaluate('result ?? "fallback"', null)).toBe('fallback')
    expect(evaluate('result ?? "fallback"', 0)).toBe(0)
    expect(evaluate('result > 1 ? "big" : "small"', 5)).toBe('big')
    expect(evaluate('result > 1 ? "big" : "small"', 0)).toBe('small')
  })

  it('reads the in operator and refuses it on a non-object', () => {
    expect(evaluate("'a' in result", { a: 1 })).toBe(true)
    expect(evaluate("'b' in result", { a: 1 })).toBe(false)
    expect(() => evaluate("'x' in content", undefined, 'abc')).toThrow("Cannot use 'in' operator")
    expect(() => evaluate("'x' in result", 5)).toThrow("Cannot use 'in' operator")
  })

  it('reads property access, computed access, and optional chaining', () => {
    expect(evaluate('result.a.b', { a: { b: 2 } })).toBe(2)
    expect(evaluate('result[0]', ['x'])).toBe('x')
    expect(evaluate('content.length', undefined, 'abc')).toBe(3)
    expect(evaluate('result?.length', null)).toBe(undefined)
    expect(evaluate('result?.length', undefined)).toBe(undefined)
    expect(evaluate('result?.[0]', null)).toBe(undefined)
    expect(evaluate('result?.includes("x")', null)).toBe(undefined)
    expect(evaluate('result?.includes("x")', undefined)).toBe(undefined)
  })

  it('refuses a property read on null or undefined', () => {
    expect(() => evaluate('result.a', null)).toThrow('Cannot read properties of null')
    expect(() => evaluate('result.a', undefined)).toThrow('Cannot read properties of undefined')
  })

  it('reads array and object literals', () => {
    expect(evaluate('[].length', 0)).toBe(0)
    expect(evaluate('result[0]', [])).toBe(undefined)
    expect(evaluate('["a", "b"].length', 0)).toBe(2)
    expect(evaluate('({ a: 1 }).a', 0)).toBe(1)
    expect(evaluate('result.length', [1, 2, 3])).toBe(3)
  })

  it('calls whitelisted inspection methods', () => {
    expect(evaluate('content.includes("x")', undefined, 'axb')).toBe(true)
    expect(evaluate('content.startsWith("a")', undefined, 'abc')).toBe(true)
    expect(evaluate('content.endsWith("c")', undefined, 'abc')).toBe(true)
    expect(evaluate('content.indexOf("b")', undefined, 'abc')).toBe(1)
    expect(evaluate('content.lastIndexOf("b")', undefined, 'abc')).toBe(1)
    expect(evaluate('content.slice(0, 2)', undefined, 'abc')).toBe('ab')
    expect(evaluate('content.substring(1)', undefined, 'abc')).toBe('bc')
    expect(evaluate('content.toUpperCase()', undefined, 'abc')).toBe('ABC')
    expect(evaluate('content.toLowerCase()', undefined, 'ABC')).toBe('abc')
    expect(evaluate('content.trim()', undefined, ' a ')).toBe('a')
    expect(evaluate('content.trimStart()', undefined, ' a ')).toBe('a ')
    expect(evaluate('content.trimEnd()', undefined, ' a ')).toBe(' a')
    expect(evaluate('content.charAt(1)', undefined, 'abc')).toBe('b')
    expect(evaluate('content.at(1)', undefined, 'abc')).toBe('b')
    expect(evaluate('content.repeat(2)', undefined, 'ab')).toBe('abab')
    expect(evaluate('content.replace("a", "z")', undefined, 'abc')).toBe('zbc')
    expect(evaluate('content.split(",")', undefined, 'a,b')).toEqual(['a', 'b'])
    expect(evaluate('result.concat([2])', [1])).toEqual([1, 2])
    expect(evaluate('result.join("-")', ['a', 'b'])).toBe('a-b')
    expect(Number(evaluate('result.get("a")', new Map([['a', 1]])))).toBe(1)
    expect(evaluate('result.has("a")', new Map([['a', 1]]))).toBe(true)
    expect(evaluate('result.toFixed(2)', 1.005)).toBe('1.00')
    expect(evaluate('result.toString()', 5)).toBe('5')
  })

  it('calls array callbacks, including a block body', () => {
    expect(evaluate('result.some(x => x > 1)', [1, 2])).toBe(true)
    expect(evaluate('result.every(x => x > 0)', [1, 2])).toBe(true)
    expect(evaluate('result.find(x => x > 1)', [1, 2])).toBe(2)
    expect(evaluate('result.findIndex(x => x > 1)', [1, 2])).toBe(1)
    expect(evaluate('result.filter(x => x > 1)', [1, 2])).toEqual([2])
    expect(evaluate('result.map(x => x * 2)', [1, 2])).toEqual([2, 4])
    expect(evaluate('result.map(x => { return x * 2; })', [1, 2])).toEqual([2, 4])
    expect(evaluate('result.map((x, i) => i)', ['a', 'b'])).toEqual([0, 1])
    expect(evaluate('result.flat().length', [[1], [2]])).toBe(2)
    expect(evaluate('result[0].length', [['a']])).toBe(1)
  })

  it('calls whitelisted namespace functions', () => {
    expect(evaluate('String(result)', 5)).toBe('5')
    expect(evaluate('Number(result)', '5')).toBe(5)
    expect(evaluate('Boolean(result)', 0)).toBe(false)
    expect(evaluate('JSON.stringify(result)', { a: 1 })).toBe('{"a":1}')
    expect(evaluate('Array.isArray(result)', [])).toBe(true)
    expect(evaluate('Object.keys(result).length', { a: 1 })).toBe(1)
    expect(evaluate('Object.values(result).length', { a: 1 })).toBe(1)
    expect(evaluate('Object.entries(result).length', { a: 1 })).toBe(1)
    expect(evaluate('Number.isFinite(result)', 5)).toBe(true)
    expect(evaluate('Number.parseInt(result)', '5')).toBe(5)
    expect(evaluate('Number.parseInt(result, 16)', 'ff')).toBe(255)
    expect(evaluate('Number.parseFloat(result)', '1.5')).toBe(1.5)
    expect(evaluate('Math.abs(result)', -5)).toBe(5)
    expect(evaluate('Math.round(result)', 1.5)).toBe(2)
    expect(evaluate('Math.floor(result)', 1.9)).toBe(1)
    expect(evaluate('Math.ceil(result)', 1.1)).toBe(2)
    expect(evaluate('Math.min(result, 3)', 5)).toBe(3)
    expect(evaluate('Math.max(result, 3)', 5)).toBe(5)
  })

  it('refuses an unknown namespace function, method, or variable', () => {
    expect(rejection('JSON.parse(content)')).toContain('不支持的全局函数: JSON.parse')
    expect(rejection('Object()')).toContain('不支持的全局函数: Object')
    expect(rejection('result.foobar()')).toContain('不支持的方法调用: .foobar()')
    expect(rejection('process')).toContain('不支持的变量名: process')
    expect(rejection('(result)()')).toContain('只能调用数据字段上的检查方法或白名单全局函数')
    expect(() => evaluate('JSON === undefined', 0)).toThrow('命名空间 JSON 只能作为调用目标')
  })

  it('refuses loose equality, regex literals, assignments, and spread', () => {
    expect(rejection('result == 5')).toContain('不支持非严格相等')
    expect(rejection('result != 5')).toContain('不支持非严格相等')
    expect(rejection('/x/.test(content)')).toContain('不支持正则字面量')
    expect(rejection('result = 5')).toContain('表达式后存在多余内容')
    expect(rejection('[...result]')).toContain('不支持的条件语法')
    expect(rejection('result === 5;')).toContain('表达式后存在多余内容')
  })

  it('refuses a missing property name and a malformed object literal', () => {
    expect(rejection('result?.()')).toContain('属性访问后缺少属性名')
    expect(rejection('({ 1: 2 })')).toContain('对象字面量的键必须是名称或字符串')
    expect(rejection('(1) => result')).toContain('表达式后存在多余内容')
  })

  it('refuses an unsupported character and an unknown token', () => {
    expect(rejection('result # 5')).toContain('不支持的字符')
    expect(rejection('result === @')).toContain('不支持的字符')
    expect(rejection('typeof')).toContain('不支持的条件语法')
    expect(rejection('result === 5 x')).toContain('标识符 x')
    expect(rejection('(result')).toContain('期望 ), 实际为 表达式结束')
    expect(rejection('() =>')).toContain('不支持的条件语法: 表达式结束')
    expect(rejection('() => {')).toContain('箭头函数体只支持单个表达式')
  })

  it('surfaces a native evaluation error from a whitelisted method', () => {
    expect(() => evaluate('result.map("x")', [1])).toThrow('is not a function')
    expect(() => evaluate('result.get("a")', [])).toThrow('array.get is not a function')
  })
})

describe('limits', () => {
  it('stops a condition whose evaluation exceeds the step budget', () => {
    const items = Array.from({ length: 25000 }, (_, index) => index)
    expect(() => evaluate('result.map(x => x)', items)).toThrow('步数上限')
  })

  it('stops a condition with too many tokens', () => {
    expect(rejection(`${'1 + '.repeat(2100)}1`)).toContain('条件过长')
  })

  it('stops a deeply nested condition', () => {
    expect(rejection(`${'('.repeat(30)}result${')'.repeat(30)}`)).toContain('嵌套超过上限')
  })
})

describe('error surface', () => {
  it('carries a hint for a rewrite the model can apply', () => {
    try {
      compileExpression('result == 5')
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError)
      expect((error as ExpressionError).hint).toContain('===')
    }
  })

  it('carries no hint when the rejection needs none', () => {
    try {
      compileExpression('result.foobar()')
      throw new Error('expected a rejection')
    } catch (error) {
      expect((error as ExpressionError).hint).toContain('只读检查方法')
    }
  })
})
