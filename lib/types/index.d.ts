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
import z from '@deepseek-ai/schemastery';
/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, pluginVersion, planFingerprint, shortAgentId } from './flow.ts';
/** The recorded-event vocabulary: envelope, schema version, stream and run-meta file names. */
export { FLOW_SCHEMA_VERSION, FLOW_STREAM_FILE, RUN_META_FILE } from './flow.ts';
export type { FlowEvent, FlowEventEnvelope, PlanContext, RecordedFlowEvent, RunMeta } from './flow.ts';
/** The version of the injected protocol text and corrective notices. */
export { PROTOCOL_VERSION } from './anchor.ts';
/** The exogenous verifier API: payload rendering, the code verifier, the plan-time probes, and the shared condition rejection. */
export { conditionRejection, probeExpression, probeHoldRate, resultPayload, verifyAssert } from './verifiers.ts';
export type { ConditionProbe, VerifyPayload } from './verifiers.ts';
/** The record-resolution instrumentation API: assertion strictness, relaxation axes, and tool summaries. */
export { clipSummary, describeStrictness, relaxationAxes, specExpressions, summarizeArguments, summarizeResult } from './instrumentation.ts';
export type { AssertionStrictness, RelaxationAxis, ResultSummary } from './instrumentation.ts';
/** The dataset API: the failure taxonomy, per-run row construction, the append path, and the hold-rate review wrapper. */
export { DATASET_FILES, appendDatasetRows, classifyFailure, classifyRelaxationCause, classifyTrainability, datasetRowsForRun, dpoPairsForRun, ensureDatasetFiles, expressionsOf, renderTranscriptEntry, withExpressions, withHoldRateReview, } from './dataset.ts';
export type { DatasetRow, DpoPair, FailureClass, RelaxationCause, RelaxationRow, RunRow, RunRows, Trainability, TranscriptEntry, } from './dataset.ts';
/** The attribution hook: the replaceable failure/relaxation/trainability classifier bundle and its loader. */
export { defaultAttribution } from './dataset.ts';
export { isAttribution, loadAttribution } from './attribution.ts';
export type { Attribution } from './attribution.ts';
/** The policy-hook seam: the deployment module inspecting LCRD's own plan and verified results. */
export { isLcrdHooks, loadHooks } from './hooks.ts';
export type { LcrdHooks, PlanCheckDecision, PlanCheckInput, ResultCheckDecision, ResultCheckInput, } from './hooks.ts';
/** The step-plan and learning vocabulary the protocol tools accept and the flow artifacts record. */
export type { LearnDeclaration, LearnVerdict, StepPlan, Verdict, VerdictExceptionKind, VerifierSpec } from './types.ts';
/** The file-flow path classifier: hard isolation applies only to task-context paths under `task-flow/`. */
export { classifyFlowPath, fileFlowSectionText } from './file-flow.ts';
export type { FlowPathClass } from './file-flow.ts';
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
    /**
     * File-backed task-flow protocol (default false). When on, the model
     * maintains the task breakdown, per-subtask files, and a progress file in
     * an engine-created task directory under `<task-flow root>/taskflow-<uuid>/` — the
     * directories, bypassing tool sandboxes) and named exactly like the flow
     * log folder, so the model never creates or names it. The root is a
     * sibling of the flow-log directory (the plugin package root by default),
     * so the task context persists beside the logs, independent of the model's
     * execution directory. The model executes subtasks one by one and
     * validates the whole task at the end. Hard isolation applies only to the
     * task context: the first file operation of a guarded tool creates and
     * pins the task directory (with guidance), and afterwards paths under
     * `task-flow/` must stay inside the pinned directory, while every other
     * path passes through unguarded. Intended for minimal deployments without
     * web tools; standard model deployments keep the plain in-context rollback
     * flow.
     */
    fileFlowEnabled?: boolean;
    /**
     * Consecutive task-context path denials — reads or writes under `task-flow/`
     * outside the current task’s pinned task directory — that
     * terminate the task as severe hallucination (default 3). Only applies
     * while `fileFlowEnabled` is on.
     */
    fileFlowPathViolationsMax?: number;
    /**
     * Absolute workspace root injected into the file-flow protocol text as the
     * place for task products (defaults to `DSH_CWD`, falling back to the fs
     * backend's own working root; empty omits the workspace line). Set it when
     * the deployment's workspace differs from the session cwd — otherwise the
     * model guesses from environment aliases and products land elsewhere.
     */
    workspaceRoot?: string;
    /**
     * File-mutation tools the file-flow guard polices (default the minimal
     * deployment set: `str_replace_editor`, `write`, `edit`). The guard reads
     * every `path` argument of these tools; other tools pass through.
     */
    fileFlowTools?: string[];
    /**
     * Whether a failure where the engine rejected the model's own check consumes
     * the task retry budget (default true, the historical behaviour). When false,
     * those failures are bounded by their own count instead, so the task budget
     * measures only steps that ran and did not meet their stop condition.
     */
    failedCheckConsumesRetry?: boolean;
    /**
     * Export this run into the dataset files when it finishes: `off` (default)
     * records artifacts only, `run` appends the run's dataset rows and DPO pairs
     * at disposal, so a finished conversation yields training-ready data with no
     * separate command.
     */
    datasetExport?: 'off' | 'run';
    /** Dataset directory for {@link datasetExport}; defaults to a `dataset` folder beside the flow logs. */
    datasetDir?: string;
    /**
     * Module path or package name exporting a domain-specific {@link Attribution}
     * bundle (default export). When set, the plugin loads it at startup and uses
     * it for every failure / relaxation / trainability classification in the
     * dataset rows, so a professional task family can attribute its own failure
     * vocabulary without forking the plugin. Relative paths resolve against the
     * process working directory. Absent (default) keeps the log-heuristic
     * attribution.
     */
    attributionModule?: string;
    /**
     * Module path or package name exporting a domain-specific {@link LcrdHooks}
     * bundle (default export). When set, the plugin loads it at startup and runs
     * it at two points: after the model declares a plan (the hook may replace the
     * effective plan, reject the declaration, or leave it) and after a governed
     * tool result was verified (the hook may reject the result or terminate the
     * task). A replacement plan is silent to the model: the `lcrd_plan` result
     * still echoes the declaration, while the flow artifacts record the effective
     * plan. Hook interceptions consume no task retry budget; they are counted
     * separately and terminate the task once they reach `maxRetries`. Relative
     * paths resolve against the process working directory. Absent (default) keeps
     * the plain protocol with no policy hook.
     */
    hooksModule?: string;
    /**
     * Reject assert declarations whose expressions only assert existence, type,
     * or non-emptiness — no pinned literal and no structured field read — at
     * declaration time (default false). The discrimination gate (unbound,
     * non-compiling, tautological) always runs; this form check is an
     * additional deployment choice on top of it.
     */
    rejectPresenceOnly?: boolean;
    /**
     * Reject assert declarations whose largest probe hold rate meets this
     * ceiling, in `(0, 1]`, at declaration time. Absent (default) records the
     * rate on the plan event without enforcing it. With the gate on, a newly
     * recorded verdict can no longer carry a rate at or above the ceiling;
     * `withHoldRateReview` therefore matters when re-exporting a corpus that
     * was recorded before the gate was turned on.
     */
    declarationMaxHoldRate?: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    maxRetries: z<number, number>;
    pythonCommand: z<string, string>;
    pythonTimeoutMs: z<number, number>;
    verifierModel: z<string, string>;
    logDir: z<string, string>;
    interaction: z<"auto" | "auth" | "manual", "auto" | "auth" | "manual">;
    learningEnabled: z<boolean, boolean>;
    learningThreshold: z<number, number>;
    maxLearningAttempts: z<number, number>;
    learningTools: z<string[], string[]>;
    fileFlowEnabled: z<boolean, boolean>;
    fileFlowPathViolationsMax: z<number, number>;
    workspaceRoot: z<string, string>;
    fileFlowTools: z<string[], string[]>;
    failedCheckConsumesRetry: z<boolean, boolean>;
    datasetExport: z<"off" | "run", "off" | "run">;
    datasetDir: z<string, string>;
    attributionModule: z<string, string>;
    hooksModule: z<string, string>;
    rejectPresenceOnly: z<boolean, boolean>;
    declarationMaxHoldRate: z<number, number>;
}>, Schemastery.ObjectT<{
    maxRetries: z<number, number>;
    pythonCommand: z<string, string>;
    pythonTimeoutMs: z<number, number>;
    verifierModel: z<string, string>;
    logDir: z<string, string>;
    interaction: z<"auto" | "auth" | "manual", "auto" | "auth" | "manual">;
    learningEnabled: z<boolean, boolean>;
    learningThreshold: z<number, number>;
    maxLearningAttempts: z<number, number>;
    learningTools: z<string[], string[]>;
    fileFlowEnabled: z<boolean, boolean>;
    fileFlowPathViolationsMax: z<number, number>;
    workspaceRoot: z<string, string>;
    fileFlowTools: z<string[], string[]>;
    failedCheckConsumesRetry: z<boolean, boolean>;
    datasetExport: z<"off" | "run", "off" | "run">;
    datasetDir: z<string, string>;
    attributionModule: z<string, string>;
    hooksModule: z<string, string>;
    rejectPresenceOnly: z<boolean, boolean>;
    declarationMaxHoldRate: z<number, number>;
}>>;
/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map