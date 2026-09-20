import type { Agent } from '@deepseek-ai/dsh-agent';
import { type AssertionStrictness, type RelaxationAxis } from './instrumentation.ts';
import { type RunRows } from './dataset.ts';
import type { Attribution } from './attribution.ts';
import type { VerdictExceptionKind, VerifierSpec } from './types.ts';
/** Where flow artifacts land: an explicit override, or the default plugin-folder location. */
export type FlowOutDir = string | undefined;
/** Current artifact schema version; changes when a recorded field changes meaning. */
export declare const FLOW_SCHEMA_VERSION = 2;
/** The append-only event stream written beside the rewritten snapshot files. */
export declare const FLOW_STREAM_FILE = "lcrd-flow.jsonl";
/** The per-run metadata file written beside the events: what ran, under which configuration. */
export declare const RUN_META_FILE = "run.json";
/**
 * What the model had just seen when it declared a plan: the decision context
 * that turns a recorded declaration into a (state, action) sample without
 * joining the session log.
 */
export interface PlanContext {
    /** Consecutive verifier failures at declaration time. */
    failures: number;
    /** Learning phase the declaration was made in. */
    phase: 'normal' | 'learn' | 'resolve';
    /** Clipped reason of the preceding verdict; null when no verdict has run. */
    lastReason: string | null;
    /** Whether the preceding verdict passed; null when no verdict has run. */
    lastPass: boolean | null;
    /** Verifier kind of the preceding verdict; null when no verdict has run. */
    lastVerifierKind: string | null;
    /** Failures in which the engine rejected the model's own check rather than the work. */
    invalidChecks: number;
}
/** One ordered protocol event. */
export type FlowEvent = {
    type: 'plan';
    goal: string;
    stop: string;
    feasibility: boolean;
    verifier: string;
    verifierSpec?: VerifierSpec;
    /** Strictness reading of the declared check, stamped by the recorder. */
    strictness?: AssertionStrictness;
    /** Axes the declared check loosened along relative to the previous plan, stamped by the recorder. */
    relaxation?: RelaxationAxis[];
    /** What the model had just seen when it declared this plan. */
    context?: PlanContext;
    /** Whether this declaration repeats the agent's own previous one, so no method change happened. */
    repeatPlan?: boolean;
    /** The `lcrd_plan` call's identity, so a dataset row joins the session log's call. */
    callId?: string;
} | {
    type: 'tool';
    name: string;
    /** Call identity from the tool runtime, so the event joins the session log's tool records. */
    callId?: string;
    /** Clipped JSON of the model-supplied arguments: what the run declared it was doing. */
    argsSummary?: string;
    /** Runtime kind of the structured result (`error` for a failed call). */
    resultKind?: string;
    /** Clipped JSON of the structured result, or the rendered content for a failed call. */
    resultSummary?: string;
    /** Failure message of a failed call. */
    errorMessage?: string;
    /** Machine-routable error code of a failed call, when the runtime supplied one. */
    errorCode?: string;
} | {
    type: 'verdict';
    pass: boolean;
    reason: string;
    count?: number;
    /** Verifier kind that produced this verdict. */
    verifierKind?: string;
    /** The verified call's identity, so a verdict names its referent instead of relying on position. */
    callId?: string;
    /** The verified call's tool name. */
    tool?: string;
    /** Why the verifier threw, when it did. */
    exceptionKind?: VerdictExceptionKind;
} | {
    type: 'learn';
    analysis: string;
    knowledge: string;
    method: string;
    criteria: string;
} | {
    type: 'learn-verify';
    learned: boolean;
    evidence: string;
    count?: number;
} | {
    type: 'intercept';
    /**
     * Why the execution was intercepted. `terminated` and `hook-terminated` end
     * the task for human review; the `hook-*` kinds name a policy-hook decision
     * (or a failing hook itself), which consumes no task retry budget.
     */
    kind: 'missing-plan' | 'infeasible' | 'terminated' | 'hook-denied' | 'hook-blocked' | 'hook-terminated' | 'hook-error';
    detail: string;
};
/** Envelope the recorder stamps on every appended event. */
export interface FlowEventEnvelope {
    /** 1-based position in the recorded stream, equal to the `.jsonl` line number. */
    seq: number;
    /** ISO-8601 instant the event was appended. */
    ts: string;
}
/** One recorded event: the protocol event plus its envelope. */
export type RecordedFlowEvent = FlowEvent & FlowEventEnvelope;
/** The interaction mode recorded per task, mirrored from the plugin config. */
export type InteractionMode = 'auto' | 'auth' | 'manual';
/** Machine-readable summary line emitted alongside the detailed events. */
export interface FlowMeta {
    session_id: string;
    task_id: string;
    md_file: string;
    human_interaction_mode: InteractionMode;
    hit_ask_intercepted: boolean;
    lcrd_retry_consumed: number;
    lcrd_retry_max: number;
    goal_changed_times: number;
    stop_changed_times: number;
    verifier_changed_times: number;
    has_verifier_exception: boolean;
    final_verdict: 'pass' | 'fail' | 'terminated';
    tb_final_reward: number | null;
    root_cause_hint: string | null;
    learning_enabled: boolean;
    learning_threshold: number;
    learning_attempts_max: number;
    learning_attempts_consumed: number;
    learning_success: boolean;
    /** Schema version of this artifact set; a recorded field that changes meaning bumps it. */
    schema_version: number;
    /** Append-only event stream written beside this snapshot, one JSON event per line. */
    events_file: string;
    /** Digest of the anchoring first user message, or null before one is recorded. */
    anchor_digest: string | null;
    /** Clipped text of that message, so an offline judge can label anchor conformance. */
    anchor_excerpt: string | null;
    /** Plan declarations that loosened their check relative to the previous declaration. */
    relaxation_count: number;
    /** Plan declarations that repeated the previous one, so no method change happened. */
    repeat_plan_count: number;
    /** Version of the plugin package that recorded this run. */
    plugin_version: string;
    /** Version of the injected protocol text and corrective notices. */
    protocol_version: number;
    /** Model the agent ran with, as recorded at first write. */
    model: string | null;
    /** Provider behind that model. */
    provider: string | null;
    /** Platform the run was recorded on. */
    platform: string;
}
/** The per-run metadata written beside the events: what ran, under which configuration. */
export interface RunMeta {
    schema_version: number;
    plugin_version: string;
    protocol_version: number;
    session_id: string;
    task_id: string;
    /** The configuration the plugin was mounted with, as validated. */
    config: unknown;
    model: string | null;
    provider: string | null;
    platform: string;
    arch: string;
    node: string;
    /** The session's working directory, when the agent carried one. */
    cwd: string | null;
    started_at: string;
    /** Time of the latest write; equal to `started_at` before the first flush. */
    ended_at: string;
    final_verdict: FlowMeta['final_verdict'];
    /** How the run stands: the protocol terminated it, the last verdict passed, or it is still open. */
    termination: 'terminated' | 'completed' | 'incomplete';
    anchor_digest: string | null;
    /** Clipped anchoring user message, so an offline judge can label anchor conformance. */
    anchor_excerpt: string | null;
}
/**
 * Default log directory: a `lcrd-flow` folder inside the plugin package.
 * @returns the absolute default artifact directory.
 */
export declare function defaultLogDir(): string;
/**
 * The version of the plugin package that records a run, so artifacts from
 * different releases stay distinguishable.
 * @returns the package version, or `unknown` when the manifest cannot be read.
 */
export declare function pluginVersion(): string;
/**
 * Stable 8-hex suffix from an agent id, disambiguating same-slug task folders.
 * @param id - the agent or session id to hash.
 * @returns the 8-hex FNV-1a hash suffix.
 */
export declare function shortAgentId(id: string): string;
/** Options for {@link FlowRecorder}. */
export interface FlowRecorderOptions {
    /** Artifact directory; defaults to {@link defaultLogDir}. */
    outDir?: FlowOutDir;
    /** Per-task identifier for the `task_id` meta field; defaults to the agent id (the first plan goal overrides it). */
    taskSlug?: string;
    /** The interaction mode this task ran under; recorded in the meta summary. */
    interaction?: InteractionMode;
    /** External Terminal-Bench sandbox reward (0/1), filled in after the run. */
    tbFinalReward?: number | null;
    /** Optional root-cause label, e.g. from the external evaluator. */
    rootCauseHint?: string | null;
    /** Whether the learning loop is enabled; recorded in the meta summary. */
    learningEnabled?: boolean;
    /** Consecutive verifier failures that enter learning mode; recorded in the meta summary. */
    learningThreshold?: number;
    /** Learning-round budget; recorded in the meta summary. */
    maxLearningAttempts?: number;
    /** Version of the plugin package recording this run; defaults to the package's own version. */
    pluginVersion?: string;
    /** Version of the injected protocol text and corrective notices. */
    protocolVersion?: number;
    /** The validated plugin configuration, recorded verbatim for cross-run comparison. */
    config?: unknown;
    /** The attribution bundle classifying failures, relaxations, and trainability; defaults to the log heuristics. */
    attribution?: Attribution;
}
/** In-order recorder for one agent's whole session (one task), one subfolder per agent. */
export declare class FlowRecorder {
    private readonly events;
    private readonly agentId;
    private readonly maxRetries;
    private readonly outDir;
    private readonly interaction;
    private readonly tbFinalReward;
    private readonly rootCauseHint;
    private readonly learningEnabled;
    private readonly learningThreshold;
    private readonly maxLearningAttempts;
    private readonly attribution;
    private taskSlug;
    private taskLabeled;
    private logOpened;
    private taskDirName;
    private goalChanged;
    private stopChanged;
    private verifierChanged;
    private askIntercepted;
    private verifierException;
    private retryConsumed;
    private hasAnyVerdict;
    private lastPass;
    private learningAttemptsConsumed;
    private learningSucceeded;
    private previousStrictness;
    private relaxationCount;
    private repeatPlanCount;
    private anchorDigest;
    private anchorExcerpt;
    private readonly pluginVersionValue;
    private readonly protocolVersion;
    private readonly configSnapshot;
    private readonly model;
    private readonly provider;
    private readonly cwd;
    private readonly startedAt;
    private endedAt;
    /** @param agent - the session owner; its id disambiguates the output files. */
    /** @param maxRetries - the configured failure budget, shown on FAIL verdicts. */
    /** @param options - artifact directory (defaults to the plugin folder), task slug, and meta inputs. */
    constructor(agent: Agent, maxRetries: number, options?: FlowRecorderOptions);
    /**
     * The per-task artifact subfolder. Named after the goal slug plus a stable
     * agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
     * agents with the same goal never collide; without a goal it falls back to
     * the agent id (a `session-<uuid>`). Fixed at the first write so early
     * events and later events always land in the same folder.
     */
    private taskDir;
    /**
     * Append one event; artifacts are rewritten per turn, on disposal, and on process exit.
     * @param event - the ordered protocol event to append.
     */
    push(event: FlowEvent): void;
    /**
     * Stamp one appended event with its envelope and, for a plan, the strictness
     * reading plus the axes it relaxed along. The comparison uses this agent's
     * own previous declaration, so a relaxation label never depends on another
     * agent's plan.
     * @param event - the ordered protocol event to append.
     * @returns the recorded event written to both the snapshot and the stream.
     */
    private stamp;
    /** The agent's own preceding plan declaration, when there is one. */
    private previousPlan;
    /**
     * Append one recorded event to the task's `.jsonl` stream. The snapshot files
     * are rewritten on every dump, so the stream is the durable record: an
     * interrupted run keeps every event already appended, and no later dump
     * rewrites what earlier turns recorded.
     * @param event - the recorded event to append.
     */
    private appendStream;
    /**
     * External fields an offline evaluator backfilled into the previous snapshot.
     * Reading them back keeps a mid-process backfill from being overwritten by
     * the next dump; the constructor options still win over the file.
     * @returns the backfilled reward and root-cause hint; each null when absent.
     */
    private readBackfill;
    /** Compare a newly declared plan against the previous one, counting contract drift. */
    private trackPlanChange;
    /** Record that an `ask_user_question` was auto-intercepted in unattended mode. */
    markAskIntercepted(): void;
    /** Record that a verifier failure was an exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
    markVerifierException(): void;
    /**
     * Compute the per-run metadata: what ran, with which model, under which
     * configuration and protocol version.
     * @returns the metadata written to `run.json`.
     */
    computeRunMeta(): RunMeta;
    /**
     * Convert this run's recorded events into dataset rows: the same shape the
     * corpus-level exporter writes, built from the recorder's own state so the
     * plugin can export a run the moment it finishes.
     * @returns the run's dataset rows, relaxation rows, and run-level row.
     */
    datasetRows(): RunRows;
    /** Record that the task completed through a post-learning re-solve; resets the consumed-attempts report. */
    markLearningSuccess(): void;
    /**
     * Record the digest and excerpt of the task's root anchor. Only the first
     * call counts: the anchor is the conversation's first user message, so a
     * later command in the same session must not replace it.
     * @param digest - hex digest of the anchoring user message text.
     * @param excerpt - clipped text of that message, for offline anchor judgement.
     */
    markAnchorDigest(digest: string, excerpt: string): void;
    /**
     * Compute the machine-readable summary from the recorded state.
     * @returns the summary line emitted in the JSON transcript.
     */
    computeMeta(): FlowMeta;
    /**
     * Append one line to this task's live `.log` file (and keep echoing to console).
     * @param line - the timestamped log line to append.
     */
    log(line: string): void;
    /**
     * Render the Mermaid flowchart source.
     * @returns the flowchart text with every event chained in order.
     */
    renderMermaid(): string;
    /**
     * Render the Markdown report embedding the flowchart.
     * @returns the report with the outcome, flowchart, and event timeline.
     */
    renderMarkdown(): string;
    /**
     * Write the per-run metadata, flowchart, report, and JSON transcript into the
     * task subfolder. Re-runnable: every call rewrites the current snapshot, so
     * per-turn dumps stay fresh until the final disposal or process-exit flush.
     * Synchronous so it also runs from a process-exit handler; never throws.
     */
    dump(): void;
}
//# sourceMappingURL=flow.d.ts.map