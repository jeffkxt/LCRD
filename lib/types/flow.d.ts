import type { Agent } from '@deepseek-ai/dsh-agent';
import type { VerifierSpec } from './types.ts';
/** Where flow artifacts land: an explicit override, or the default plugin-folder location. */
export type FlowOutDir = string | undefined;
/** One ordered protocol event. */
export type FlowEvent = {
    type: 'plan';
    goal: string;
    stop: string;
    feasibility: boolean;
    verifier: string;
    verifierSpec?: VerifierSpec;
} | {
    type: 'tool';
    name: string;
} | {
    type: 'verdict';
    pass: boolean;
    reason: string;
    count?: number;
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
    kind: 'missing-plan' | 'infeasible' | 'terminated';
    detail: string;
};
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
}
/** Default log directory: a `lcrd-flow` folder inside the plugin package. */
export declare function defaultLogDir(): string;
/** Stable 8-hex suffix from an agent id, disambiguating same-slug task folders. */
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
    /** @param agent - the session owner; its id disambiguates the output files. */
    /** @param maxRetries - the configured failure budget, shown on FAIL verdicts. */
    /** @param options - artifact directory (defaults to the plugin folder), task slug, and meta inputs. */
    constructor(agent: Agent, maxRetries: number, options?: FlowRecorderOptions);
    /**
     * The per-task artifact subfolder. Named after the goal slug plus a stable
     * agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
     * agents with the same goal never collide; without a goal it falls back to
     * the agent id. Fixed at the first write so early events and later events
     * always land in the same folder.
     */
    private taskDir;
    /** Append one event; artifacts are rewritten per turn, on disposal, and on process exit. */
    push(event: FlowEvent): void;
    /** Compare a newly declared plan against the previous one, counting contract drift. */
    private trackPlanChange;
    /** Record that an `ask_user_question` was auto-intercepted in unattended mode. */
    markAskIntercepted(): void;
    /** Record that a verifier failure was an exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
    markVerifierException(): void;
    /** Record that the task completed through a post-learning re-solve; resets the consumed-attempts report. */
    markLearningSuccess(): void;
    /** Compute the machine-readable summary from the recorded state. */
    computeMeta(): FlowMeta;
    /** Append one line to this task's live `.log` file (and keep echoing to console). */
    log(line: string): void;
    /** Render the Mermaid flowchart source. */
    renderMermaid(): string;
    /** Render the Markdown report embedding the flowchart. */
    renderMarkdown(): string;
    /**
     * Write the flowchart, report, and JSON transcript into the task subfolder.
     * Re-runnable: every call rewrites the current snapshot, so per-turn dumps
     * stay fresh until the final disposal or process-exit flush. Synchronous so
     * it also runs from a process-exit handler; never throws.
     */
    dump(): void;
}
//# sourceMappingURL=flow.d.ts.map