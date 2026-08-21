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
/** Render one tool result into the verifier payload. */
export declare function resultPayload(result: ToolExecutionResult): VerifyPayload;
/** Structured assertions: every condition is a JS expression over `result`; all must hold and none may be trivially true. */
export declare function verifyAssert(conditions: string[], payload: VerifyPayload): Verdict;
/** Run the verifier declared in the step plan. */
export declare function runVerifier(ctx: Context, agent: Agent, verifier: VerifierSpec, result: ToolExecutionResult, options: {
    pythonCommand: string;
    pythonTimeoutMs: number;
    verifierModel: string | undefined;
    anchorText: string;
}, plan: StepPlan, signal: AbortSignal): Promise<Verdict>;
//# sourceMappingURL=verifiers.d.ts.map