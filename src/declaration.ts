/**
 * Declaration-time parsing and gates for the model-facing `lcrd_plan` tool:
 * argument narrowing and the L1–L4 declaration checks. Pure — no plugin
 * state — so the plan tool and any hook wrapper can import it without a cycle.
 */
import type { StepPlan } from './types.ts'
import { conditionRejection, probeExpression } from './verifiers.ts'
import { describeStrictness } from './instrumentation.ts'
import { verifierMode } from './types.ts'

/** Narrow one tool-argument value to a string, rejecting anything else.
 * @param raw - the raw argument value from the tool call.
 * @param field - the argument name used in the rejection message.
 * @returns the non-empty string argument.
 */
export function parseString(raw: unknown, field: string): string {
  /* v8 ignore next 2 -- the tool schema rejects non-string arguments before execute runs */
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`)
  }
  return raw
}

/** Narrow one tool-argument value to a boolean, rejecting anything else.
 * @param raw - the raw argument value from the tool call.
 * @param field - the argument name used in the rejection message.
 * @returns the boolean argument.
 */
export function parseBoolean(raw: unknown, field: string): boolean {
  /* v8 ignore next 2 -- the tool schema rejects non-boolean arguments before execute runs */
  if (typeof raw !== 'boolean') {
    throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`)
  }
  return raw
}

/** Validate the model-supplied verifier object against the declared protocol.
 * @param raw - the raw verifier object from the tool call.
 * @returns the validated verifier descriptor.
 */
export function parseVerifier(raw: unknown): StepPlan['verifier'] {
  /* v8 ignore next 2 -- the tool schema rejects a non-object verifier before execute runs */
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('lcrd_plan: 参数 verifier 必须是对象')
  }
  const record = raw as Record<string, unknown>
  if (record.kind === 'assert') {
    const conditions = record.conditions
    /* v8 ignore next 2 -- the tool schema rejects non-string-array conditions before execute runs */
    if (!Array.isArray(conditions) || !conditions.every(item => typeof item === 'string')) {
      throw new Error('lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组')
    }
    if (conditions.length === 0) {
      throw new Error('lcrd_plan: verifier.kind=assert 的 conditions 不能为空,至少需要一条断言表达式')
    }
    const mode = record.mode
    /* v8 ignore next 2 -- the tool schema constrains mode to the two declared values */
    if (mode !== undefined && mode !== 'oracle' && mode !== 'probe') {
      throw new Error('lcrd_plan: verifier.mode 只能是 oracle 或 probe')
    }
    return mode === undefined ? { kind: 'assert', conditions } : { kind: 'assert', mode, conditions }
  }
  if (record.kind === 'python') {
    const checks = record.checks
    /* v8 ignore next 2 -- the tool schema rejects non-string-array checks before execute runs */
    if (!Array.isArray(checks) || !checks.every(item => typeof item === 'string')) {
      throw new Error('lcrd_plan: verifier.kind=python 需要 checks 为字符串数组')
    }
    if (checks.length === 0) {
      throw new Error('lcrd_plan: verifier.kind=python 的 checks 不能为空,至少需要一条检查表达式')
    }
    return { kind: 'python', checks }
  }
  /* v8 ignore start -- the tool schema rejects unknown verifier kinds before execute runs */
  if (record.kind === 'llm') {
    return { kind: 'llm' }
  }
  throw new Error(`lcrd_plan: 未知的 verifier kind: ${String(record.kind)}`)
  /* v8 ignore stop */
}

/** The declaration-time gates the declaration validator enforces: presence-only rejection and the hold-rate ceiling. */
export interface DeclarationPolicy {
  /** Whether to reject presence-only assert declarations (L2 form check). */
  rejectPresenceOnly: boolean
  /** Optional probe hold-rate ceiling in `(0, 1]`; absent disables L4 rate enforcement. */
  maxHoldRate: number | undefined
}

/**
 * Enforce the declaration-time gates on one step plan: every assert condition
 * must compile and pass the discrimination probe, and — when the deployment
 * enabled them — the declaration must not be presence-only and must hold on
 * fewer probe inputs than the configured ceiling. Python and llm verifiers
 * have no JS condition list to probe and pass unconditionally; their checks
 * are still rejected by the post-execute verifier when invalid.
 * @param plan - the plan under declaration (the model's, or a hook's replacement).
 * @param policy - the configured declaration gates.
 * @throws when any condition or the declaration's form fails a gate.
 */
export function validateDeclaration(plan: StepPlan, policy: DeclarationPolicy): void {
  if (plan.verifier.kind !== 'assert') return
  const mode = verifierMode(plan.verifier)
  const conditions = plan.verifier.conditions
  for (const condition of conditions) {
    const probe = probeExpression(condition)
    if (probe === 'unbound') {
      throw new Error(conditionRejection(condition, probe))
    }
    if (probe === 'invalid') {
      throw new Error(`断言无法编译: ${condition}`)
    }
    if (mode === 'oracle' && probe === 'tautological') {
      throw new Error(conditionRejection(condition, probe))
    }
  }
  // A probe declaration states a prediction instead of binding the step, so the
  // form gates stay off: they exist to stop a self-issued pass, and a prediction
  // issues none. The step is still bound by the engine baseline (a failed tool
  // call always fails) and by the run's own task-level check.
  if (mode === 'probe') return
  if (!policy.rejectPresenceOnly && policy.maxHoldRate === undefined) return
  const strictness = describeStrictness(plan.verifier)
  if (policy.rejectPresenceOnly && strictness.presenceOnly) {
    throw new Error(`断言只断言存在性或类型(presence-only),未钉住任何字面量或结构化字段: ${conditions.join('; ')}`)
  }
  if (policy.maxHoldRate !== undefined) {
    // L1 already rejected every unbound/non-compiling condition, so every
    // expression was probed and the declaration's max hold rate is measured.
    const rate = strictness.maxHoldRate as number
    if (rate >= policy.maxHoldRate) {
      throw new Error(`断言探测通过率 ${rate.toFixed(2)} ≥ 上限 ${policy.maxHoldRate.toFixed(2)},约束过弱: ${conditions.join('; ')}`)
    }
  }
}
