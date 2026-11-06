/**
 * The restricted expression language model-authored assert conditions are
 * written in.
 *
 * A condition is evaluated in the harness's own process before and after every
 * governed tool call, so it must never be host code. This module parses a small
 * grammar and interprets the resulting tree; `this`, arbitrary member calls,
 * dynamic `import`, and unbounded loops are not expressible, so a condition
 * cannot reach `process`, the filesystem, or the event loop. The grammar covers
 * what a stop-condition check needs (comparisons, boolean logic, `typeof`,
 * `in`, property reads, and a whitelist of inspection methods) and rejects
 * everything else with an actionable reason.
 *
 * @module lcrd-expr
 */

/** Receives the verified tool result projection and returns the condition's value. */
export type ExpressionEvaluator = (result: unknown, content: unknown, isError: boolean) => unknown

/** Bound variables a condition may read, matching {@link ExpressionEvaluator}'s parameters. */
const BINDINGS = new Set(['result', 'content', 'isError'])

/** Literal constants a condition may name. */
const CONSTANTS = new Map<string, unknown>([
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['true', true],
  ['false', false],
  ['null', null],
])

/**
 * Property names that expose the prototype chain or the call machinery. Every
 * one of them is a route from a data value back to host code, so a condition
 * cannot name one even though the receiver is data.
 */
const FORBIDDEN_PROPERTIES = new Set([
  '__proto__', 'constructor', 'prototype', 'caller', 'callee', 'arguments', 'bind', 'call', 'apply',
])

/** Inspection methods a condition may call on a data value. */
const METHODS = new Set([
  'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'slice', 'substring', 'split',
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'charAt', 'at', 'repeat', 'replace',
  'join', 'concat', 'some', 'every', 'find', 'findIndex', 'filter', 'map', 'flat', 'keys', 'values',
  'entries', 'get', 'has', 'toFixed', 'toString',
])

/** Namespaces whose whitelisted members a condition may call. */
const NAMESPACES = new Set(['JSON', 'Math', 'Number', 'Object', 'Array', 'String', 'Boolean'])

/** Callable namespace members, keyed by their dotted source form. */
const NAMESPACE_CALLS: Record<string, (...args: unknown[]) => unknown> = {
  String: value => String(value),
  Number: value => Number(value),
  Boolean: value => Boolean(value),
  'JSON.stringify': value => JSON.stringify(value),
  'Array.isArray': value => Array.isArray(value),
  'Object.keys': value => Object.keys(value as object),
  'Object.values': value => Object.values(value as Record<string, unknown>),
  'Object.entries': value => Object.entries(value as Record<string, unknown>),
  'Number.isFinite': value => Number.isFinite(value),
  'Number.isNaN': value => Number.isNaN(value),
  'Number.parseInt': (value, radix) => Number.parseInt(String(value), radix === undefined ? 10 : Number(radix)),
  'Number.parseFloat': value => Number.parseFloat(String(value)),
  'Math.abs': value => Math.abs(Number(value)),
  'Math.round': value => Math.round(Number(value)),
  'Math.floor': value => Math.floor(Number(value)),
  'Math.ceil': value => Math.ceil(Number(value)),
  'Math.min': (...values) => Math.min(...values.map(Number)),
  'Math.max': (...values) => Math.max(...values.map(Number)),
}

/** Longest token sequence one condition may contain. */
const MAX_TOKENS = 4096

/** Deepest expression nesting one condition may contain. */
const MAX_DEPTH = 48

/** Interpretation steps one evaluation may spend; bounds total work per probe. */
const MAX_STEPS = 20000

/**
 * A condition this module refuses to compile or evaluate. The message is
 * model-facing, and `hint` carries the actionable rewrite when one exists.
 */
export class ExpressionError extends Error {
  /** Actionable rewrite advice for the model, when the rejection has one. */
  readonly hint: string | undefined

  /**
   * @param message - the rejection reason.
   * @param hint - actionable rewrite advice, if any.
   */
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ExpressionError'
    this.hint = hint
  }
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' }

type Node =
  | { kind: 'constant'; value: unknown }
  | { kind: 'binding'; name: 'result' | 'content' | 'isError' }
  | { kind: 'parameter'; name: string }
  | { kind: 'namespace'; name: string }
  | { kind: 'array'; items: readonly Node[] }
  | { kind: 'object'; entries: readonly { key: string; value: Node }[] }
  | { kind: 'member'; object: Node; property: Node; name: string | undefined; optional: boolean }
  | { kind: 'call'; callee: Node; args: readonly Node[] }
  | { kind: 'unary'; operator: string; argument: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'logical'; operator: string; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; consequent: Node; alternate: Node }
  | { kind: 'arrow'; params: readonly string[]; body: Node }

/** Mutable interpretation state shared by the whole evaluation, including arrow bodies. */
interface EvaluationContext {
  readonly result: unknown
  readonly content: unknown
  readonly isError: boolean
  readonly steps: { count: number }
}

/** Local bindings introduced by an arrow function's parameters. */
type Environment = Readonly<Record<string, unknown>> | undefined

/** Token spellings, longest first so a shared prefix never splits an operator. */
const PUNCTUATION = [
  '===', '!==', '...', '&&', '||', '??', '?.', '=>', '<=', '>=', '==', '!=',
  '(', ')', '[', ']', '{', '}', '.', ',', '?', ':', '!', '<', '>', '+', '-', '*', '/', '%', '=', ';',
] as const

/** Model-facing description of the token at the cursor. */
function describeToken(token: Token): string {
  switch (token.kind) {
    case 'eof': return '表达式结束'
    case 'number': return `数字 ${String(token.value)}`
    case 'string': return `字符串 "${token.value}"`
    case 'ident': return `标识符 ${token.value}`
    case 'punct': return `符号 ${token.value}`
  }
}

/** Split one condition into tokens, rejecting syntax the grammar does not carry. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    if (char.trim() === '') {
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      let value = ''
      index += 1
      let closed = false
      while (index < source.length) {
        const next = source[index] as string
        if (next === '\\') {
          const escape = source[index + 1] as string
          const table: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }
          value += table[escape] ?? escape
          index += 2
          continue
        }
        if (next === quote) {
          closed = true
          index += 1
          break
        }
        value += next
        index += 1
      }
      if (!closed) throw new ExpressionError(`字符串未闭合: ${describeToken({ kind: 'string', value })}`)
      tokens.push({ kind: 'string', value })
      continue
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1)
      if (end < 0) throw new ExpressionError('模板字符串未闭合')
      const body = source.slice(index + 1, end)
      if (body.includes('${')) {
        throw new ExpressionError('不支持模板字符串插值', '请改用字符串拼接或 includes 检查')
      }
      tokens.push({ kind: 'string', value: body })
      index = end + 1
      continue
    }
    if (char >= '0' && char <= '9') {
      const match = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
      /* v8 ignore next -- the branch is entered only on a leading digit, which the pattern always matches */
      if (match === null) throw new ExpressionError(`无法识别的数字: ${source.slice(index, index + 8)}`)
      tokens.push({ kind: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))
      /* v8 ignore next -- the branch is entered only on an identifier start, which the pattern always matches */
      if (match === null) throw new ExpressionError(`无法识别的标识符: ${source.slice(index, index + 8)}`)
      tokens.push({ kind: 'ident', value: match[0] })
      index += match[0].length
      continue
    }
    const punct = PUNCTUATION.find(candidate => source.startsWith(candidate, index))
    if (punct === undefined) {
      throw new ExpressionError(`不支持的字符: ${char}`, '条件只能是单个表达式,不能包含语句、赋值或函数声明')
    }
    tokens.push({ kind: 'punct', value: punct })
    index += punct.length
  }
  if (tokens.length > MAX_TOKENS) {
    throw new ExpressionError(`条件过长: ${String(tokens.length)} 个记号超过上限 ${String(MAX_TOKENS)}`)
  }
  tokens.push({ kind: 'eof', value: '' })
  return tokens
}

/** Recursive-descent parser over the whitelisted grammar. */
class Parser {
  private index = 0
  private depth = 0
  /** Arrow parameters in scope while parsing a nested body, innermost last. */
  private readonly parameters: string[] = []

  constructor(private readonly tokens: readonly Token[]) {}

  /** Parse the whole source as one expression. */
  parseProgram(): Node {
    const node = this.parseConditional()
    const rest = this.peek()
    if (rest.kind !== 'eof') {
      throw new ExpressionError(`表达式后存在多余内容: ${describeToken(rest)}`, '条件必须是单个表达式')
    }
    return node
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] as Token
  }

  private peekPunct(): string | undefined {
    const token = this.peek()
    return token.kind === 'punct' ? token.value : undefined
  }

  private next(): Token {
    const token = this.peek()
    if (token.kind !== 'eof') this.index += 1
    return token
  }

  private accept(value: string): boolean {
    if (this.peekPunct() === value) {
      this.index += 1
      return true
    }
    return false
  }

  private expect(value: string): void {
    if (!this.accept(value)) {
      throw new ExpressionError(`期望 ${value}, 实际为 ${describeToken(this.peek())}`)
    }
  }

  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_DEPTH) throw new ExpressionError(`表达式嵌套超过上限 ${String(MAX_DEPTH)}`)
  }

  private leave(): void {
    this.depth -= 1
  }

  private parseConditional(): Node {
    this.enter()
    const test = this.parseNullish()
    if (this.accept('?')) {
      const consequent = this.parseConditional()
      this.expect(':')
      const alternate = this.parseConditional()
      this.leave()
      return { kind: 'conditional', test, consequent, alternate }
    }
    this.leave()
    return test
  }

  private parseNullish(): Node {
    let left = this.parseOr()
    while (this.peekPunct() === '??') {
      this.next()
      left = { kind: 'logical', operator: '??', left, right: this.parseOr() }
    }
    return left
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.accept('||')) left = { kind: 'logical', operator: '||', left, right: this.parseAnd() }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseEquality()
    while (this.accept('&&')) left = { kind: 'logical', operator: '&&', left, right: this.parseEquality() }
    return left
  }

  private parseEquality(): Node {
    let left = this.parseRelational()
    for (;;) {
      const operator = this.peekPunct()
      if (operator === '===' || operator === '!==') {
        this.next()
        left = { kind: 'binary', operator, left, right: this.parseRelational() }
        continue
      }
      if (operator === '==' || operator === '!=') {
        throw new ExpressionError('不支持非严格相等 == / !=', '请使用 === 或 !==,它们不会做隐式类型转换')
      }
      return left
    }
  }

  private parseRelational(): Node {
    let left = this.parseAdditive()
    for (;;) {
      const punct = this.peekPunct()
      const ident = this.peek()
      const operator = punct !== undefined && ['<', '>', '<=', '>='].includes(punct)
        ? punct
        : ident.kind === 'ident' && ident.value === 'in' ? 'in' : undefined
      if (operator === undefined) return left
      this.next()
      left = { kind: 'binary', operator, left, right: this.parseAdditive() }
    }
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative()
    for (;;) {
      if (this.accept('+')) {
        left = { kind: 'binary', operator: '+', left, right: this.parseMultiplicative() }
      } else if (this.accept('-')) {
        left = { kind: 'binary', operator: '-', left, right: this.parseMultiplicative() }
      } else {
        return left
      }
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary()
    for (;;) {
      if (this.accept('*')) {
        left = { kind: 'binary', operator: '*', left, right: this.parseUnary() }
      } else if (this.accept('/')) {
        left = { kind: 'binary', operator: '/', left, right: this.parseUnary() }
      } else if (this.accept('%')) {
        left = { kind: 'binary', operator: '%', left, right: this.parseUnary() }
      } else {
        return left
      }
    }
  }

  private parseUnary(): Node {
    this.enter()
    const token = this.peek()
    if (token.kind === 'punct' && ['!', '-', '+'].includes(token.value)) {
      this.next()
      const argument = this.parseUnary()
      this.leave()
      return { kind: 'unary', operator: token.value, argument }
    }
    if (token.kind === 'ident' && token.value === 'typeof') {
      this.next()
      const argument = this.parseUnary()
      this.leave()
      return { kind: 'unary', operator: 'typeof', argument }
    }
    const node = this.parsePostfix()
    this.leave()
    return node
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary()
    for (;;) {
      const optional = this.accept('?.')
      if (this.accept('[')) {
        const property = this.parseConditional()
        this.expect(']')
        const literal = property.kind === 'constant' && typeof property.value === 'string' ? property.value : undefined
        if (literal !== undefined && FORBIDDEN_PROPERTIES.has(literal)) {
          throw new ExpressionError(`不允许访问属性 ${literal}`, '条件只能读取数据字段,不能访问原型链或函数构造器')
        }
        node = { kind: 'member', object: node, property, name: literal, optional }
        continue
      }
      if (optional || this.accept('.')) {
        const name = this.next()
        if (name.kind !== 'ident') throw new ExpressionError(`属性访问后缺少属性名, 实际为 ${describeToken(name)}`)
        if (FORBIDDEN_PROPERTIES.has(name.value)) {
          throw new ExpressionError(`不允许访问属性 ${name.value}`, '条件只能读取数据字段,不能访问原型链或函数构造器')
        }
        node = { kind: 'member', object: node, property: { kind: 'constant', value: name.value }, name: name.value, optional }
        continue
      }
      if (this.accept('(')) {
        node = this.parseCallee(node, this.parseArguments())
        continue
      }
      return node
    }
  }

  /** Validate one call target and build its node. */
  private parseCallee(callee: Node, args: readonly Node[]): Node {
    if (callee.kind === 'namespace') {
      if (NAMESPACE_CALLS[callee.name] === undefined) {
        throw new ExpressionError(`不支持的全局函数: ${callee.name}`, '可用的全局函数见 lcrd_plan 的说明')
      }
      return { kind: 'call', callee, args }
    }
    if (callee.kind === 'member' && callee.name !== undefined) {
      if (callee.object.kind === 'namespace') {
        const dotted = `${callee.object.name}.${callee.name}`
        if (NAMESPACE_CALLS[dotted] === undefined) {
          throw new ExpressionError(`不支持的全局函数: ${dotted}`, '可用的全局函数见 lcrd_plan 的说明')
        }
        return { kind: 'call', callee, args }
      }
      if (!METHODS.has(callee.name)) {
        throw new ExpressionError(
          `不支持的方法调用: .${callee.name}()`,
          '只能调用只读检查方法(includes / startsWith / get / some / every 等)',
        )
      }
      return { kind: 'call', callee, args }
    }
    throw new ExpressionError(
      '只能调用数据字段上的检查方法或白名单全局函数',
      '不能调用 this、函数构造器或其它任意函数',
    )
  }

  private parseArguments(): readonly Node[] {
    if (this.accept(')')) return []
    const args: Node[] = []
    do {
      args.push(this.parseConditional())
    } while (this.accept(','))
    this.expect(')')
    return args
  }

  private parsePrimary(): Node {
    const token = this.peek()
    if (token.kind === 'number' || token.kind === 'string') {
      this.next()
      return { kind: 'constant', value: token.value }
    }
    if (token.kind === 'ident') {
      this.next()
      if (CONSTANTS.has(token.value)) return { kind: 'constant', value: CONSTANTS.get(token.value) }
      if (this.parameters.includes(token.value)) return { kind: 'parameter', name: token.value }
      if (BINDINGS.has(token.value)) {
        return { kind: 'binding', name: token.value as 'result' | 'content' | 'isError' }
      }
      if (this.peekPunct() === '=>') {
        this.next()
        const body = this.withParameters([token.value], () => this.parseArrowBody())
        return { kind: 'arrow', params: [token.value], body }
      }
      if (NAMESPACES.has(token.value)) return { kind: 'namespace', name: token.value }
      throw new ExpressionError(
        `不支持的变量名: ${token.value}`,
        '条件只能读取 result / content / isError',
      )
    }
    if (this.accept('(')) {
      if (this.looksLikeArrowParams()) {
        const params: string[] = []
        if (!this.accept(')')) {
          do {
            const param = this.next()
            /* v8 ignore next -- looksLikeArrowParams already refused a non-identifier parameter */
            if (param.kind !== 'ident') throw new ExpressionError(`箭头函数参数必须是标识符, 实际为 ${describeToken(param)}`)
            params.push(param.value)
          } while (this.accept(','))
          this.expect(')')
        }
        this.expect('=>')
        const body = this.withParameters(params, () => this.parseArrowBody())
        return { kind: 'arrow', params, body }
      }
      const inner = this.parseConditional()
      this.expect(')')
      return inner
    }
    if (this.accept('[')) {
      const items: Node[] = []
      if (!this.accept(']')) {
        do {
          items.push(this.parseConditional())
        } while (this.accept(','))
        this.expect(']')
      }
      return { kind: 'array', items }
    }
    if (this.accept('{')) {
      const entries: { key: string; value: Node }[] = []
      if (!this.accept('}')) {
        do {
          const key = this.next()
          const name = key.kind === 'ident' || key.kind === 'string' ? key.value : undefined
          if (name === undefined) throw new ExpressionError(`对象字面量的键必须是名称或字符串, 实际为 ${describeToken(key)}`)
          if (FORBIDDEN_PROPERTIES.has(name)) throw new ExpressionError(`不允许使用属性名 ${name}`, '条件只能构造普通数据对象')
          this.expect(':')
          entries.push({ key: name, value: this.parseConditional() })
        } while (this.accept(','))
        this.expect('}')
      }
      return { kind: 'object', entries }
    }
    if (token.kind === 'punct' && token.value === '/') {
      throw new ExpressionError('不支持正则字面量', '请改用 includes / startsWith / endsWith / indexOf 等字符串方法')
    }
    throw new ExpressionError(`不支持的条件语法: ${describeToken(token)}`)
  }

  /** Parse one arrow body with its parameters in scope, then restore the outer scope. */
  private withParameters<T>(params: readonly string[], parse: () => T): T {
    this.parameters.push(...params)
    try {
      return parse()
    } finally {
      for (let index = 0; index < params.length; index += 1) this.parameters.pop()
    }
  }

  /** Parse an arrow body: one expression, or a block holding a single `return`. */
  private parseArrowBody(): Node {
    if (!this.accept('{')) return this.parseConditional()
    const keyword = this.next()
    if (!(keyword.kind === 'ident' && keyword.value === 'return')) {
      throw new ExpressionError('箭头函数体只支持单个表达式或 return 语句')
    }
    const body = this.parseConditional()
    this.accept(';')
    this.expect('}')
    return body
  }

  /** Whether the tokens at the cursor are an arrow parameter list `( a , b ) =>`. */
  private looksLikeArrowParams(): boolean {
    let cursor = this.index
    let expectIdent = true
    for (;;) {
      const token = this.tokens[cursor]
      /* v8 ignore next -- the token list always ends with eof, which exits the loop below */
      if (token === undefined) return false
      if (token.kind === 'punct' && token.value === ')') {
        const after = this.tokens[cursor + 1]
        return after !== undefined && after.kind === 'punct' && after.value === '=>'
      }
      if (expectIdent) {
        if (token.kind !== 'ident') return false
      } else if (!(token.kind === 'punct' && token.value === ',')) {
        return false
      }
      expectIdent = !expectIdent
      cursor += 1
    }
  }
}

/** Describe one value's type for a model-facing rejection reason. */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Read one property of a data value, refusing the prototype route and null receivers. */
function readProperty(receiver: unknown, key: string): unknown {
  if (FORBIDDEN_PROPERTIES.has(key)) {
    throw new ExpressionError(`不允许访问属性 ${key}`, '条件只能读取数据字段,不能访问原型链或函数构造器')
  }
  if (receiver === null || receiver === undefined) {
    throw new ExpressionError(`Cannot read properties of ${describeType(receiver)} (reading '${key}')`)
  }
  return (receiver as Record<string, unknown>)[key]
}

/** Apply one method call on a data value. */
function callMethod(receiver: unknown, name: string, args: readonly unknown[]): unknown {
  const method = readProperty(receiver, name)
  if (typeof method !== 'function') {
    throw new ExpressionError(`${describeType(receiver)}.${name} is not a function`)
  }
  return Reflect.apply(method, receiver, args)
}

/** Strict comparison and arithmetic; the casts are erased so the engine's own JS semantics apply. */
function compare(operator: string, left: unknown, right: unknown): unknown {
  const l = left as number
  const r = right as number
  switch (operator) {
    case '===': return left === right
    case '!==': return left !== right
    case '<': return l < r
    case '>': return l > r
    case '<=': return l <= r
    case '>=': return l >= r
    case '+': return l + r
    case '-': return l - r
    case '*': return l * r
    case '/': return l / r
    case '%': return l % r
    /* v8 ignore next -- the parser only builds the comparison operators above */
    default: throw new ExpressionError(`不支持的运算符: ${operator}`)
  }
}

/** Interpret one node against the tool result projection and local bindings. */
function interpret(node: Node, context: EvaluationContext, environment: Environment): unknown {
  context.steps.count += 1
  if (context.steps.count > MAX_STEPS) {
    throw new ExpressionError(`条件求值超过步数上限 ${String(MAX_STEPS)}`, '请简化条件,避免对超大结果全量遍历')
  }
  switch (node.kind) {
    case 'constant':
      return node.value
    case 'binding':
      return context[node.name]
    case 'parameter':
      return environment?.[node.name]
    case 'namespace':
      throw new ExpressionError(`命名空间 ${node.name} 只能作为调用目标`)
    case 'array':
      return node.items.map(item => interpret(item, context, environment))
    case 'object': {
      const result: Record<string, unknown> = {}
      for (const entry of node.entries) result[entry.key] = interpret(entry.value, context, environment)
      return result
    }
    case 'member': {
      const receiver = interpret(node.object, context, environment)
      if (node.optional && (receiver === null || receiver === undefined)) return undefined
      const key = node.name ?? String(interpret(node.property, context, environment))
      return readProperty(receiver, key)
    }
    case 'call': {
      const args = node.args.map(arg => interpret(arg, context, environment))
      if (node.callee.kind === 'namespace') {
        const fn = NAMESPACE_CALLS[node.callee.name]
        /* v8 ignore next -- the parser rejects an unknown namespace call before this runs */
        if (fn === undefined) throw new ExpressionError(`不支持的全局函数: ${node.callee.name}`)
        return fn(...args)
      }
      /* v8 ignore next -- the parser only builds member and namespace callees */
      if (node.callee.kind !== 'member') throw new ExpressionError('只能调用数据字段上的检查方法或白名单全局函数')
      if (node.callee.object.kind === 'namespace') {
        const dotted = `${node.callee.object.name}.${String(node.callee.name)}`
        const fn = NAMESPACE_CALLS[dotted]
        /* v8 ignore next -- the parser rejects an unknown namespace member before this runs */
        if (fn === undefined) throw new ExpressionError(`不支持的全局函数: ${dotted}`)
        return fn(...args)
      }
      const receiver = interpret(node.callee.object, context, environment)
      if (node.callee.optional && (receiver === null || receiver === undefined)) return undefined
      /* v8 ignore next -- the parser rejects a call without a static member name */
      if (node.callee.name === undefined) throw new ExpressionError('只能调用静态方法名')
      if (typeof receiver === 'function') {
        throw new ExpressionError('不允许在函数值上调用方法', '条件只能作用于数据值')
      }
      return callMethod(receiver, node.callee.name, args)
    }
    case 'unary': {
      const argument = interpret(node.argument, context, environment)
      switch (node.operator) {
        case '!': return !argument
        case '-': return -(argument as number)
        case '+': return Number(argument)
        case 'typeof': return typeof argument
        /* v8 ignore next -- the parser only builds the unary operators above */
        default: throw new ExpressionError(`不支持的运算符: ${node.operator}`)
      }
    }
    case 'logical': {
      const left = interpret(node.left, context, environment)
      if (node.operator === '&&') return left ? interpret(node.right, context, environment) : left
      if (node.operator === '||') return left ? left : interpret(node.right, context, environment)
      return left === null || left === undefined ? interpret(node.right, context, environment) : left
    }
    case 'binary': {
      const left = interpret(node.left, context, environment)
      if (node.operator === 'in') {
        const right = interpret(node.right, context, environment)
        if (right === null || right === undefined || typeof right !== 'object') {
          throw new ExpressionError(`Cannot use 'in' operator to search for '${String(left)}' in ${describeType(right)}`)
        }
        return String(left) in right
      }
      return compare(node.operator, left, interpret(node.right, context, environment))
    }
    case 'conditional':
      return interpret(node.test, context, environment)
        ? interpret(node.consequent, context, environment)
        : interpret(node.alternate, context, environment)
    case 'arrow':
      return (...args: unknown[]): unknown => {
        const bindings: Record<string, unknown> = {}
        node.params.forEach((param, index) => {
          bindings[param] = args[index]
        })
        return interpret(node.body, context, { ...environment, ...bindings })
      }
  }
}

/**
 * Compile one model-authored condition into an evaluator.
 *
 * The returned function interprets the whitelisted tree; it never executes
 * source text, so it cannot reach `this`, `process`, the module loader, or the
 * event loop. Evaluation errors (a member read on `undefined`, a method missing
 * from the configured whitelist, the step budget) surface as
 * {@link ExpressionError} when the evaluator runs; grammar rejections surface
 * here.
 *
 * @param source - the model-authored condition.
 * @returns the evaluator for this condition.
 * @throws {ExpressionError} when the condition is outside the whitelisted grammar.
 */
export function compileExpression(source: string): ExpressionEvaluator {
  const program = new Parser(tokenize(source)).parseProgram()
  return (result, content, isError) => interpret(program, { result, content, isError, steps: { count: 0 } }, undefined)
}
