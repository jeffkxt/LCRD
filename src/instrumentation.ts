/**
 * Record-resolution instrumentation for plan declarations and tool calls: how
 * discriminating a model-authored check is at declaration time, which axes one
 * declaration loosened along relative to the previous one, and a compact
 * projection of the tool arguments and structured result the check referred
 * to. These readings are recorded, never enforced — the post-execute verifier
 * owns the verdict, so a declared check can be measured without changing what
 * passes.
 *
 * @module lcrd-instrumentation
 */
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { probeExpression, probeHoldRate, resultPayload, type ConditionProbe } from './verifiers.ts'
import { verifierMode, type VerifierSpec } from './types.ts'

/** Axes along which one declaration loosens its check relative to the previous one. */
export type RelaxationAxis =
  /** The model switched verifier kind. */
  | 'verifier-kind'
  /** The declaration carries fewer expressions than the previous one. */
  | 'fewer-expressions'
  /** The check now only asserts existence, type, or non-emptiness. */
  | 'presence-only'
  /** A field read of the structured result value disappeared. */
  | 'lost-structural'
  /** A pinned expected value (quoted text or a numeric threshold) disappeared. */
  | 'dropped-literals'
  /** The check started reading the rendered text instead of the structured value. */
  | 'substring-text'
  /** The declaration's constraint dropped: its measurable hold rate rose. */
  | 'weaker-constraint'

/**
 * Discrimination reading of a declared check. `empty` marks a declaration that
 * carries no expression at all (an assert or python list the engine rejects),
 * and `unchecked` marks the kinds the plan-time probe does not evaluate: the
 * python verifier needs an interpreter process, whose cost belongs to the
 * post-execute verdict rather than to every declaration.
 */
export type Discrimination = ConditionProbe | 'unchecked' | 'empty'

/** What one declared check looks like at declaration time. */
export interface AssertionStrictness {
  /** The verifier kind the model chose. */
  kind: VerifierSpec['kind']
  /**
   * The binding the declaration claimed: `oracle` binds the step, `probe` states
   * a prediction. Recorded so a reader sees a mode switch, which the relaxation
   * axes deliberately do not report (it is a declared change, not a hidden one).
   */
  mode: 'oracle' | 'probe'
  /** How many expressions the declaration evaluates; zero for the llm verifier. */
  expressions: number
  /** How many expressions hold on every probe input, so they add no discrimination. */
  tautological: number
  /** Whether any expression pins a literal: quoted text, or a numeric threshold above 1. */
  literal: boolean
  /** Whether any expression reads a field or attribute of the structured result value. */
  structural: boolean
  /** Whether any expression reads the rendered text, including substring tests through it. */
  usesContent: boolean
  /** Whether no expression pins a literal or reads a field: the check only asserts existence, type, or non-emptiness. */
  presenceOnly: boolean
  /**
   * The largest hold rate among the declaration's measurable expressions, so
   * `1 - maxHoldRate` reads as the declaration's constraint: a tautology sits
   * at 1, a tightly pinned check near 0. Null when no expression could be
   * probed, which is every python and llm declaration.
   */
  maxHoldRate: number | null
  /** Aggregate probe reading: the weakest declared expression decides. */
  discrimination: Discrimination
}

/** A literal pinned by an expression: quoted text, or a numeric threshold above 1. */
const LITERAL_RE = /(['"][^'"]+['"]|\b(?:[2-9]|\d{2,})\b)/

/** A read of one field or attribute of the structured result value. */
const STRUCTURAL_RE = /(\.get\(|result\s*\[|result\s*\.\s*\w+)/

/** A read of the rendered text, or a substring test expressed through it. */
const CONTENT_RE = /(\bcontent\b|str\(result\)|in result|in str\()/

/**
 * The expressions one verifier spec evaluates.
 * @param spec - the model-chosen verifier specification.
 * @returns the declared expression list; empty for the llm verifier.
 */
export function specExpressions(spec: VerifierSpec): string[] {
  return spec.kind === 'assert' ? spec.conditions : spec.kind === 'python' ? spec.checks : []
}

/**
 * Read one declared check: its static axes plus the probe-matrix reading of
 * each JS expression. Failure reasons stay the verifier's, so a declared check
 * is measured without being judged.
 * @param spec - the model-chosen verifier specification.
 * @returns the strictness reading recorded on the plan event.
 */
export function describeStrictness(spec: VerifierSpec): AssertionStrictness {
  const expressions = specExpressions(spec)
  const mode = verifierMode(spec)
  const readings = expressions.map(expression => ({
    literal: LITERAL_RE.test(expression),
    structural: STRUCTURAL_RE.test(expression),
    usesContent: CONTENT_RE.test(expression),
  }))
  const probes: ConditionProbe[] = spec.kind === 'assert' && mode === 'oracle' ? expressions.map(probeExpression) : []
  const rates = spec.kind === 'assert' && mode === 'oracle'
    ? expressions.map(probeHoldRate).filter((rate): rate is number => rate !== null)
    : []
  const literal = readings.some(reading => reading.literal)
  const structural = readings.some(reading => reading.structural)
  return {
    kind: spec.kind,
    mode,
    expressions: expressions.length,
    tautological: probes.filter(probe => probe === 'tautological').length,
    literal,
    structural,
    usesContent: readings.some(reading => reading.usesContent),
    presenceOnly: expressions.length > 0 && !literal && !structural,
    maxHoldRate: rates.length === 0 ? null : Math.max(...rates),
    discrimination: spec.kind === 'assert'
      ? mode === 'probe' ? 'unchecked' : aggregateDiscrimination(probes)
      : spec.kind === 'python' && expressions.length === 0 ? 'empty' : 'unchecked',
  }
}

/**
 * Aggregate per-expression probes into the declaration's reading: the weakest
 * expression decides, because the verifier requires every declared expression
 * to hold.
 * @param probes - one probe reading per declared expression.
 * @returns the aggregate reading; a declaration with no expression cannot discriminate.
 */
function aggregateDiscrimination(probes: ConditionProbe[]): Discrimination {
  if (probes.length === 0) return 'empty'
  if (probes.includes('unbound')) return 'unbound'
  if (probes.includes('invalid')) return 'invalid'
  return probes.every(probe => probe === 'tautological') ? 'tautological' : 'discriminating'
}

/**
 * The axes along which one declaration loosened its check. Every axis reads
 * recorded fields, so a relaxation label is reproducible from the transcript
 * alone and never depends on a value the tool happened to return. The axes are
 * monotone shape signals rather than verdicts: a rewrite that stays as tight
 * while changing shape trips them too, so a reader judges the two expression
 * lists on the relaxation record.
 * @param previous - the strictness reading of the previous plan declaration.
 * @param next - the strictness reading of the newly declared plan.
 * @returns the relaxed axes in a fixed order; empty when the check did not loosen.
 */
export function relaxationAxes(previous: AssertionStrictness, next: AssertionStrictness): RelaxationAxis[] {
  const axes: RelaxationAxis[] = []
  // A probe declaration claims no binding, so no axis of constraint applies to
  // it; a mode switch is visible on the plan's recorded strictness instead.
  if (previous.mode === 'probe' || next.mode === 'probe') return axes
  if (previous.kind !== next.kind) axes.push('verifier-kind')
  if (next.expressions < previous.expressions) axes.push('fewer-expressions')
  if (!previous.presenceOnly && next.presenceOnly) axes.push('presence-only')
  if (previous.structural && !next.structural) axes.push('lost-structural')
  if (previous.literal && !next.literal) axes.push('dropped-literals')
  if (!previous.usesContent && next.usesContent) axes.push('substring-text')
  // The quantitative reading: a higher hold rate means the check holds on more
  // probe inputs, so it separates fewer of them.
  if (previous.maxHoldRate !== null && next.maxHoldRate !== null && next.maxHoldRate > previous.maxHoldRate) {
    axes.push('weaker-constraint')
  }
  return axes
}

/** Clip length of one recorded argument or result summary, in characters. */
const SUMMARY_MAX = 240

/**
 * Clip one recorded summary to the transcript budget.
 * @param text - the raw summary text.
 * @returns the text, truncated with an ellipsis when it exceeds the budget.
 */
export function clipSummary(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX)}…`
}

/**
 * Render tool arguments into one recorded line.
 * @param args - the model-supplied tool arguments.
 * @returns the clipped JSON rendering, or a marker when the value cannot be serialized.
 */
export function summarizeArguments(args: unknown): string {
  try {
    // `JSON.stringify` returns undefined for a value it cannot render (undefined,
    // a function, a symbol), which its declared return type does not express.
    const serialized: unknown = JSON.stringify(args)
    return clipSummary(typeof serialized === 'string' ? serialized : String(args))
  } catch {
    return '(unserializable arguments)'
  }
}

/** The recorded projection of one tool result: its runtime kind, clipped summary, and failure detail. */
export interface ResultSummary {
  /** Runtime kind of the structured value: `array`, `null`, or the JSON `typeof` reading; `error` for a failed call. */
  kind: string
  /** Clipped JSON rendering of the structured value, or of the rendered content for a failed call. */
  summary: string
  /** Failure message of a failed call, kept so environment failures stay classifiable offline. */
  error: string | undefined
  /** Machine-routable error code of a failed call, when the tool runtime supplies one. */
  errorCode: string | undefined
}

/**
 * Project one executed tool result into the fields recorded beside the call.
 * @param result - the executed tool's canonical result.
 * @returns the kind, clipped summary, and failure detail recorded on the tool event.
 */
export function summarizeResult(result: ToolExecutionResult): ResultSummary {
  const payload = resultPayload(result)
  if (result.isError) {
    return {
      kind: 'error',
      summary: clipSummary(payload.content),
      error: result.error.message,
      errorCode: result.error.info?.code,
    }
  }
  return { kind: valueKind(payload.value), summary: summarizeArguments(payload.value), error: undefined, errorCode: undefined }
}

/**
 * The runtime kind of a structured tool value; the canonical tool contract
 * restricts the value to JSON, so every reading is a JSON kind.
 * @param value - the structured value carried by the verifier payload.
 * @returns `null`, `array`, or the JSON `typeof` reading.
 */
function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
