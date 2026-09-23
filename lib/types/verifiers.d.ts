import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { StepPlan, Verdict, VerifierSpec } from './types.ts';
/** Payload handed to every verifier: the error flag, the canonical value, and the model-facing text. */
export interface VerifyPayload {
    isError: boolean;
    value: unknown;
    content: string;
}
/**
 * Render one tool result into the verifier payload.
 * @param result - the executed tool's canonical result.
 * @returns the payload every verifier evaluates against.
 */
export declare function resultPayload(result: ToolExecutionResult): VerifyPayload;
/** One model-authored JS condition classified by the probe matrix, without a tool result. */
export type ConditionProbe = 'discriminating' | 'tautological' | 'unbound' | 'invalid';
/**
 * Probe one model-authored JS condition and report the fraction of probe
 * inputs on which it holds: `0` is maximally constraining, `1` is a tautology,
 * and a rate strictly between the two is a condition that actually separates
 * inputs. Instrumentation only — it measures a declaration before the tool
 * runs and grants no verdict.
 *
 * XXX: the python verifier runs the same probe matrix inside its template
 * script and reports only PASS/FAIL, so its hold rate stays unmeasured; the
 * template would have to print the rate for the recorder to read it.
 * @param expression - the model-authored condition.
 * @returns the hold rate in `[0, 1]`, or null when the condition cannot be
 *   probed (it reads no bound variable or does not compile).
 */
export declare function probeHoldRate(expression: string): number | null;
/**
 * Classify one model-authored JS condition through the same probe matrix the
 * post-execute verifier runs, without any tool result. Instrumentation only:
 * it lets a caller record how discriminating a declared check is before the
 * tool executes, and grants no verdict.
 * @param expression - the model-authored condition.
 * @returns `unbound` when it reads no bound variable, `invalid` when it does not
 *   compile, `tautological` when it holds on every probe input, otherwise
 *   `discriminating`.
 */
export declare function probeExpression(expression: string): ConditionProbe;
/**
 * The rejection reason for one unbound or tautological condition, shared by
 * the declaration-time gate and the post-execute verifier so both name the
 * same cause for the same condition.
 * @param condition - the model-authored condition the probe rejected.
 * @param kind - `unbound` when it reads no bound variable, `tautological` when it holds on every probe input.
 * @returns the model-facing rejection reason.
 */
export declare function conditionRejection(condition: string, kind: 'unbound' | 'tautological'): string;
/**
 * Structured assertions: every condition is a JS expression over
 * `result` (the structured value), `content` (the rendered text), or
 * `isError`; all must hold and none may be trivially true. A failed tool
 * result fails outright before any condition runs.
 * @param conditions - the model-authored JS expressions, each referencing at least one bound variable.
 * @param payload - the verified tool result projection.
 * @returns the normalized verdict; failure reasons localize the cause.
 */
export declare function verifyAssert(conditions: string[], payload: VerifyPayload): Verdict;
/**
 * Run the verifier declared in the step plan.
 * @param ctx - plugin context (used only by the llm verifier's stream).
 * @param agent - the executing agent (used only by the llm verifier's provider/model).
 * @param verifier - the model-chosen verifier specification.
 * @param result - the executed tool's canonical result.
 * @param options - python command/timeout and the optional dedicated verifier model plus the anchor text.
 * @param plan - the declared step plan (used only by the llm verifier prompt).
 * @param signal - cancellation for the llm stream.
 * @returns the normalized verdict.
 */
export declare function runVerifier(ctx: Context, agent: Agent, verifier: VerifierSpec, result: ToolExecutionResult, options: {
    pythonCommand: string;
    pythonTimeoutMs: number;
    verifierModel: string | undefined;
    anchorText: string;
}, plan: StepPlan, signal: AbortSignal): Promise<Verdict>;
//# sourceMappingURL=verifiers.d.ts.map