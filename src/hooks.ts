/**
 * The policy-hook seam: one deployment module inspects LCRD's own declared
 * plan right after the model declares it and again right after the governed
 * tool result was verified. The hook may replace the effective plan (silently —
 * the model keeps seeing its own declaration), reject a declaration, reject a
 * verified result, or terminate the task for human review. It never touches a
 * tool call's logged arguments and never rewrites harness state: LCRD remains
 * the only writer of its plan, budget, and termination state.
 *
 * @module lcrd-hooks
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { importModule } from './module-loader.ts'
import type { StepPlan, Verdict } from './types.ts'

/** One plan-declaration check: the model's declared plan, before it governs execution. */
export interface PlanCheckInput {
  /** The agent that declared the plan. */
  readonly agent: Agent
  /** The plan exactly as the model declared it; the effective plan may replace it. */
  readonly plan: Readonly<StepPlan>
  /** The `lcrd_plan` call identity, for logging and correlation. */
  readonly callId: string
  /** The declaration call's cancellation signal; an async check should observe it. */
  readonly signal: AbortSignal
}

/** What a plan check decides. */
export type PlanCheckDecision =
  /** Keep the declared plan as the effective one. */
  | { kind: 'allow' }
  /** Replace the effective plan; the model is not told, the flow artifacts record the replacement. */
  | { kind: 'modify'; plan: StepPlan }
  /** Reject the declaration; the subtask does not become effective and no verification follows. */
  | { kind: 'deny'; reason: string }

/** One post-execution check: the verified tool result and the effective plan that governed it. */
export interface ResultCheckInput {
  /** The agent that ran the tool. */
  readonly agent: Agent
  /** The effective plan that governed this execution. */
  readonly plan: Readonly<StepPlan>
  /** The executed tool's name. */
  readonly tool: string
  /** The executed call's identity, for logging and correlation. */
  readonly callId: string
  /** The executed tool's canonical result, as LCRD's verifier saw it. */
  readonly result: Readonly<ToolExecutionResult>
  /** The exogenous verifier's outcome for this result. */
  readonly verdict: Verdict
  /** The call's cancellation signal; an async check should observe it. */
  readonly signal: AbortSignal
}

/** What a result check decides. */
export type ResultCheckDecision =
  /** Continue with LCRD's normal verdict handling. */
  | { kind: 'allow' }
  /** Reject the result with corrective feedback, consuming no task retry. */
  | { kind: 'block'; reason: string }
  /** Terminate the whole task for human review. */
  | { kind: 'terminate'; reason: string }

/**
 * The hook module a deployment points `hooksModule` at: either check may be
 * omitted, but at least one must be present.
 */
export interface LcrdHooks {
  /** Inspect one plan declaration before it becomes effective. */
  checkPlan?(input: PlanCheckInput): PlanCheckDecision | Promise<PlanCheckDecision>
  /** Inspect one verified tool result. */
  checkResult?(input: ResultCheckInput): ResultCheckDecision | Promise<ResultCheckDecision>
}

/**
 * Whether a value is a usable hook module: every present check is a function,
 * and at least one check is present.
 * @param value - the loaded module export.
 * @returns true when the value carries a usable hook.
 */
export function isLcrdHooks(value: unknown): value is LcrdHooks {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as LcrdHooks
  const hasPlan = candidate.checkPlan !== undefined
  const hasResult = candidate.checkResult !== undefined
  if (!hasPlan && !hasResult) return false
  if (hasPlan && typeof candidate.checkPlan !== 'function') return false
  if (hasResult && typeof candidate.checkResult !== 'function') return false
  return true
}

/**
 * Load one hook module from a module specifier.
 * @param specifier - the module path or package name exporting the bundle.
 * @param baseUrl - directory for resolving a relative path; defaults to the process working directory.
 * @returns the loaded bundle, validated by {@link isLcrdHooks}.
 */
export async function loadHooks(specifier: string, baseUrl = process.cwd()): Promise<LcrdHooks> {
  const module = await importModule(specifier, baseUrl)
  if (!isLcrdHooks(module)) {
    throw new Error(`hooks module ${specifier} must export checkPlan and/or checkResult as functions`)
  }
  return module
}

/**
 * Whether a value is a well-formed plan: the shape a `modify` decision must
 * return. The hook module is a deployment boundary, so its replacement plan is
 * checked before LCRD stores or verifies with it.
 * @param value - the replacement plan a hook returned.
 * @returns true when every plan field and verifier list is usable.
 */
export function isStepPlan(value: unknown): value is StepPlan {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Partial<StepPlan>
  if (typeof plan.goal !== 'string' || plan.goal.length === 0) return false
  if (typeof plan.stop_condition !== 'string' || plan.stop_condition.length === 0) return false
  if (typeof plan.feasibility !== 'boolean') return false
  const verifier = plan.verifier as { kind?: unknown; conditions?: unknown; checks?: unknown } | null | undefined
  if (typeof verifier !== 'object' || verifier === null) return false
  if (verifier.kind === 'llm') return true
  const expressions = verifier.kind === 'assert' ? verifier.conditions : verifier.kind === 'python' ? verifier.checks : undefined
  return Array.isArray(expressions)
    && expressions.length > 0
    && expressions.every(expression => typeof expression === 'string')
}
