/**
 * LCRD step-plan vocabulary shared by the model-facing `lcrd_plan` tool, the
 * root-anchor prompt section, and the post-execute verifier pipeline.
 */
/** One subtask declaration the model must emit before executing tools. */
export interface StepPlan {
    /** The current subtask goal (serves the root anchor, never replaces it). */
    goal: string;
    /** Local stop condition, checkable by an external verifier after the tool result. */
    stop_condition: string;
    /** Whether the model judges this subtask feasible up front. */
    feasibility: boolean;
    /** The verifier the model chooses; the plugin only executes it. */
    verifier: VerifierSpec;
}
/**
 * Three verifier forms the model may choose. The model supplies only data
 * (expressions over `result` for the code verifiers, no text for the LLM
 * verifier); the verification program itself is plugin-owned, so the model
 * cannot write itself a pass.
 */
export type VerifierSpec = 
/** Structured JS expressions over `result`; every one must hold. */
{
    kind: 'assert';
    conditions: string[];
}
/**
 * Python expressions over `result`, evaluated by a plugin-owned script
 * template; every one must hold.
 */
 | {
    kind: 'python';
    checks: string[];
}
/** Plugin-owned fixed-prompt LLM session checked against the root anchor. */
 | {
    kind: 'llm';
};
/** Normalized verifier outcome consumed by the rollback logic. */
export interface Verdict {
    pass: boolean;
    reason: string;
    /** True when the failure was a verifier exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
    exception?: boolean;
}
//# sourceMappingURL=types.d.ts.map