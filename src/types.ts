/**
 * LCRD step-plan vocabulary shared by the model-facing `lcrd_plan` tool, the
 * root-anchor prompt section, and the post-execute verifier pipeline.
 */

/** One subtask declaration the model must emit before executing tools. */
export interface StepPlan {
  /** The current subtask goal (serves the root anchor, never replaces it). */
  goal: string
  /** Local stop condition, checkable by an external verifier after the tool result. */
  stop_condition: string
  /** Whether the model judges this subtask feasible up front. */
  feasibility: boolean
  /** The verifier the model chooses; the plugin only executes it. */
  verifier: VerifierSpec
}

/**
 * Three verifier forms the model may choose. The model supplies only data
 * (expressions over `result` for the code verifiers, no text for the LLM
 * verifier); the verification program itself is plugin-owned, so the model
 * cannot write itself a pass.
 */
export type VerifierSpec =
  /** Structured JS expressions over `result`; every one must hold. */
  | { kind: 'assert'; conditions: string[] }
  /**
   * Python expressions over `result`, evaluated by a plugin-owned script
   * template; every one must hold.
   */
  | { kind: 'python'; checks: string[] }
  /** Plugin-owned fixed-prompt LLM session checked against the root anchor. */
  | { kind: 'llm' }

/** Normalized verifier outcome consumed by the rollback logic. */
export interface Verdict {
  pass: boolean
  reason: string
  /** True when the failure was a verifier exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
  exception?: boolean
}

/**
 * One learning-round declaration the model must emit before acquiring
 * knowledge. The evaluation criteria are model-authored by design: a failed
 * self-evaluation consumes a learning attempt, and the real check of whether
 * the knowledge transferred is the re-solve passing the exogenous verifier.
 */
export interface LearnDeclaration {
  /** Why the current task cannot be solved: problem decomposition and root cause. */
  problem_analysis: string
  /** The specific knowledge the model needs to acquire. */
  knowledge_needed: string
  /** How the model will learn: web search, reading files, reflection, delegation, etc. */
  learning_method: string
  /** The model's own criteria for judging whether the knowledge has been acquired. */
  eval_criteria: string
}

/** The model's self-evaluation verdict after one learning round. */
export interface LearnVerdict {
  /** Whether the model judges it has acquired the knowledge. */
  learned: boolean
  /** Evidence backing the self-evaluation. */
  evidence: string
}
