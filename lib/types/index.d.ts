/**
 * LCRD hard-isolation minimal sample: the three-symbol protocol (root anchor,
 * stop symbol, rollback symbol) implemented over the harness extension points.
 * The root anchor is pinned in the system prompt, the model declares each
 * subtask plan through the `lcrd_plan` tool, and every tool result is verified
 * after execution by an exogenous verifier the model chose; failures roll back
 * with corrective feedback and terminate after a configured retry budget.
 *
 * @module lcrd-hard-isolation
 */
import type { Context } from '@deepseek-ai/cordis';
/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, shortAgentId } from './flow.ts';
/** The exogenous verifier API: payload rendering and the code verifier. */
export { resultPayload, verifyAssert } from './verifiers.ts';
export type { VerifyPayload } from './verifiers.ts';
export declare const name = "lcrd-hard-isolation";
export declare const inject: string[];
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /** Consecutive verifier failures that terminate the task for human review (default 3). */
    maxRetries?: number;
    /** Command used to launch Python verifier scripts (default `python`). */
    pythonCommand?: string;
    /** Kill a Python verifier script after this many milliseconds (default 30000). */
    pythonTimeoutMs?: number;
    /** Optional dedicated model id for the LLM verifier; defaults to the agent's own model. */
    verifierModel?: string;
    /** Flow-log directory; defaults to a `lcrd-flow` folder inside the plugin package. */
    logDir?: string;
    /**
     * How the agent handles human interaction (approval prompts and
     * `ask_user_question`). `'auto'` decides autonomously in unattended runs:
     * approval requests are auto-rejected and `ask_user_question` resolves with
     * a preset answer instead of waiting. `'auth'` routes approval prompts to a
     * human answerer while leaving `ask_user_question` interactive. `'manual'`
     * (default) leaves both to the configured UI answerers.
     */
    interaction?: 'auto' | 'auth' | 'manual';
    /**
     * Master switch for the model self-learning loop. Off (default) keeps the
     * plugin exactly on the plain rollback/termination path; on, consecutive
     * verifier failures at or above `learningThreshold` pause direct retries
     * and require the model to declare learning rounds.
     */
    learningEnabled?: boolean;
    /** Consecutive verifier failures that enter learning mode (default 5). */
    learningThreshold?: number;
    /** Learning rounds before the task terminates for human review (default 3). */
    maxLearningAttempts?: number;
    /**
     * Tool-name allowlist usable during the learning phase without a plan or
     * verifier (default knowledge-acquisition tools). Task tools stay gated by
     * `lcrd_plan` + the exogenous verifier; entries naming unregistered tools
     * are harmless.
     */
    learningTools?: string[];
}
export declare const Config: any;
/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map