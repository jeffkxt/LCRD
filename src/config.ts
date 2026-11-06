/**
 * The plugin configuration: the validated schema a deployment writes under the
 * `lcrd` row, plus the interface the wiring reads it through. Kept apart from
 * the wiring so a config change never touches the protocol code.
 */
import z from '@deepseek-ai/schemastery'

/** The plugin config a deployment writes under the `lcrd` row. */
export interface Config {
  /** Consecutive verifier failures that terminate the task for human review (default 3). */
  maxRetries?: number
  /** Command used to launch Python verifier scripts (default `python`). */
  pythonCommand?: string
  /** Kill a Python verifier script after this many milliseconds (default 30000). */
  pythonTimeoutMs?: number
  /** Optional dedicated model id for the LLM verifier; defaults to the agent's own model. */
  verifierModel?: string
  /** Flow-log directory; defaults to a `lcrd-flow` folder inside the plugin package. */
  logDir?: string
  /**
   * How the agent handles human interaction (approval prompts and
   * `ask_user_question`). `'auto'` decides autonomously in unattended runs:
   * approval requests are auto-rejected and `ask_user_question` resolves with
   * a preset answer instead of waiting. `'auth'` routes approval prompts to a
   * human answerer while leaving `ask_user_question` interactive. `'manual'`
   * (default) leaves both to the configured UI answerers.
   */
  interaction?: 'auto' | 'auth' | 'manual'
  /**
   * Master switch for the model self-learning loop. Off (default) keeps the
   * plugin exactly on the plain rollback/termination path; on, consecutive
   * verifier failures at or above `learningThreshold` pause direct retries
   * and require the model to declare learning rounds.
   */
  learningEnabled?: boolean
  /** Consecutive verifier failures that enter learning mode (default 5). */
  learningThreshold?: number
  /** Learning rounds before the task terminates for human review (default 3). */
  maxLearningAttempts?: number
  /**
   * Tool-name allowlist usable during the learning phase without a plan or
   * verifier (default knowledge-acquisition tools). Task tools stay gated by
   * `lcrd_plan` + the exogenous verifier; entries naming unregistered tools
   * are harmless.
   */
  learningTools?: string[]
  /**
   * File-backed task-flow protocol (default false). When on, the model
   * maintains the task breakdown, per-subtask files, and a progress file in
   * an engine-created task directory under `<task-flow root>/taskflow-<uuid>/` — the
   * plugin creates it directly (bypassing tool sandboxes) and names it
   * `taskflow-` plus the agent uuid, deliberately different from the flow-log
   * folder naming, so the model never creates or names it. The root is a
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
  fileFlowEnabled?: boolean
  /**
   * Consecutive task-context path denials — reads or writes under `task-flow/`
   * outside the current task’s pinned task directory — that
   * terminate the task as severe hallucination (default 3). Only applies
   * while `fileFlowEnabled` is on.
   */
  fileFlowPathViolationsMax?: number
  /**
   * Absolute workspace root injected into the file-flow protocol text as the
   * place for task products (defaults to `DSH_CWD`, falling back to the fs
   * backend's own working root; empty omits the workspace line). Set it when
   * the deployment's workspace differs from the session cwd — otherwise the
   * model guesses from environment aliases and products land elsewhere.
   */
  workspaceRoot?: string
  /**
   * File-mutation tools the file-flow guard polices (default the minimal
   * deployment set: `str_replace_editor`, `write`, `edit`). The guard reads
   * every `path` argument of these tools; other tools pass through.
   */
  fileFlowTools?: string[]
  /**
   * Whether a failure where the engine rejected the model's own check consumes
   * the task retry budget (default true, the historical behaviour). When false,
   * those failures are bounded by their own count instead, so the task budget
   * measures only steps that ran and did not meet their stop condition.
   */
  failedCheckConsumesRetry?: boolean
  /**
   * Export this run into the dataset files when it finishes: `off` (default)
   * records artifacts only, `run` appends the run's dataset rows and DPO pairs
   * at disposal, so a finished conversation yields training-ready data with no
   * separate command.
   */
  datasetExport?: 'off' | 'run'
  /** Dataset directory for {@link datasetExport}; defaults to a `dataset` folder beside the flow logs. */
  datasetDir?: string
  /**
   * Module path or package name exporting a domain-specific {@link Attribution}
   * bundle (default export). When set, the plugin loads it at startup and uses
   * it for every failure / relaxation / trainability classification in the
   * dataset rows, so a professional task family can attribute its own failure
   * vocabulary without forking the plugin. Relative paths resolve against the
   * process working directory. Absent (default) keeps the log-heuristic
   * attribution.
   */
  attributionModule?: string
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
  hooksModule?: string
  /**
   * Reject assert declarations whose expressions only assert existence, type,
   * or non-emptiness — no pinned literal and no structured field read — at
   * declaration time (default false). The discrimination gate (unbound,
   * non-compiling, tautological) always runs; this form check is an
   * additional deployment choice on top of it.
   */
  rejectPresenceOnly?: boolean
  /**
   * Reject assert declarations whose largest probe hold rate meets this
   * ceiling, in `(0, 1]`, at declaration time. Absent (default) records the
   * rate on the plan event without enforcing it. With the gate on, a newly
   * recorded verdict can no longer carry a rate at or above the ceiling;
   * `withHoldRateReview` therefore matters when re-exporting a corpus that
   * was recorded before the gate was turned on.
   */
  declarationMaxHoldRate?: number
  /**
   * Master switch for versioned policy evolution (default false). When off the
   * plugin is exactly the plain protocol: no candidate mount, no policy store
   * access, no proposal tool, no online monitor. When on, `evolveBenchmarkDir`
   * is required and `@deepseek-ai/dsh-skill` must be composed.
   */
  evolveEnabled?: boolean
  /** Policy version store; defaults to a `policy` folder beside the flow logs. */
  evolvePolicyDir?: string
  /** Three-tier benchmark root (`train.jsonl`, `holdout/`, `hardout/`); required when evolution is enabled. */
  evolveBenchmarkDir?: string
  /** Command that starts a gate child; defaults to `dsh` on PATH. */
  evolveGateCommand?: string
  /**
   * Arguments prepended before the harness flags in a gate child, e.g.
   * `--import tsx/esm apps/cli/src/bin.ts` for a source run. Defaults to none.
   */
  evolveGateArgs?: string[]
  /** Profile each gate child boots; defaults to `headless`. */
  evolveGateProfile?: string
  /** Kill a gate child after this many milliseconds (default 900000). */
  evolveGateRunTimeoutMs?: number
  /** Repeats per task and side in the gate (default 3). */
  evolveRepeats?: number
  /** Holdout tasks drawn per gate (default 5). */
  evolveHoldoutSize?: number
  /** Recent gates a drawn holdout task stays ineligible for (default 3). */
  evolveHoldoutCooldown?: number
  /** Promotions between sealed hard-out audits (default 5; 0 disables). */
  evolveHardoutAuditEvery?: number
  /** Minimum candidate pass-rate gain over the baseline (default 0.1). */
  evolveMinGain?: number
  /** Allowed absolute termination-rate regression (default 0). */
  evolveMaxSafetyRegression?: number
  /** Allowed absolute speculative-cheat-rate regression (default 0). */
  evolveMaxCheatRegression?: number
  /** Cumulative token budget for one gate (default 2000000). */
  evolveGateMaxTokens?: number
  /** Wall-clock budget for one gate in milliseconds (default 3600000). */
  evolveGateMaxWallMs?: number
  /** Per-run token ceiling a gate child enforces (default 200000). */
  evolveRunMaxTokens?: number
  /** Who promotes a gated version: `approval` (default) asks a human; `auto` never asks. */
  evolvePromote?: 'approval' | 'auto'
  /**
   * What admission reads: `reward` (default) requires every benchmark task to
   * carry a ground-truth scoring command; `self-report` falls back to the
   * agent's own verifier verdicts and is only useful for smoke runs.
   */
  evolveAdmission?: 'reward' | 'self-report'
  /**
   * Additional statistical evidence for admission (default `off`). `bootstrap`
   * requires `evolveAdmission: reward` and at least two paired runs; it rejects
   * a positive gain whose paired bootstrap interval includes zero.
   */
  evolveSignificance?: 'off' | 'bootstrap'
  /** Two-sided error rate for the paired bootstrap interval (default 0.05). */
  evolveSignificanceAlpha?: number
  /**
   * Refuse a promotion when the gate's own noise floor exceeds `evolveMinGain`
   * (default true). A sample that cannot resolve the threshold cannot support a
   * promotion, whatever its point estimate says; raise `evolveRepeats` or
   * `evolveHoldoutSize` instead of opting out.
   */
  evolveRequireDetectability?: boolean
  /** Allowed relative token-spend regression against the baseline (default 0.2). */
  evolveMaxTokenRegression?: number
  /** Proposals allowed per task boundary (default 2). */
  evolveMaxProposals?: number
  /** Skills one proposal may carry (default 8). */
  evolveMaxSkills?: number
  /** Maximum bytes per proposed skill body (default 16384). */
  evolveSkillMaxBytes?: number
  /** Clipped rationale length recorded in a manifest (default 2000). */
  evolveRationaleMax?: number
  /** Static scan mode for proposals: `rules` (default) or `rules+llm`. */
  evolveStaticScan?: 'rules' | 'rules+llm'
  /**
   * Model for the `rules+llm` static scan; falls back to `verifierModel`.
   * Compose a model distinct from the proposing agent: a scan run by the model
   * that wrote the skill is not an independent review. Required when
   * `evolveStaticScan` is `rules+llm`.
   */
  evolveScanModel?: string
  /** Risky samples each brief section renders (default 5). */
  evolveBriefTopN?: number
  /** Finished runs observed before the online rollback can trigger (default 10). */
  evolveRollbackWindow?: number
  /** Allowed absolute termination-rate regression before an automatic rollback (default 0.2). */
  evolveRollbackMargin?: number
  /**
   * Mount one policy version as the active policy with evolution disabled.
   * Written into generated gate overlays only; a deployment normally leaves it unset.
   */
  evolveCandidateVersion?: string
}

export const Config = z.object({
  maxRetries: z.number().default(3),
  pythonCommand: z.string().default('python'),
  pythonTimeoutMs: z.number().default(30000),
  verifierModel: z.string().required(false),
  logDir: z.string().required(false),
  interaction: z.union(['auto', 'auth', 'manual'] as const).default('manual'),
  learningEnabled: z.boolean().default(false),
  learningThreshold: z.number().default(5),
  maxLearningAttempts: z.number().default(3),
  learningTools: z.array(z.string()).default([
    'web_search', 'read', 'glob', 'grep', 'skill', 'subagent', 'web_fetch',
  ]),
  fileFlowEnabled: z.boolean().default(false),
  fileFlowPathViolationsMax: z.number().default(3),
  workspaceRoot: z.string().required(false),
  fileFlowTools: z.array(z.string()).default(['str_replace_editor', 'write', 'edit']),
  failedCheckConsumesRetry: z.boolean().default(true),
  datasetExport: z.union(['off', 'run'] as const).default('off'),
  datasetDir: z.string().required(false),
  attributionModule: z.string().required(false),
  hooksModule: z.string().required(false),
  rejectPresenceOnly: z.boolean().default(false),
  declarationMaxHoldRate: z.number().required(false),
  evolveEnabled: z.boolean().default(false),
  evolvePolicyDir: z.string().required(false),
  evolveBenchmarkDir: z.string().required(false),
  evolveGateCommand: z.string().default('dsh'),
  evolveGateArgs: z.array(z.string()).default([]),
  evolveGateProfile: z.string().default('headless'),
  evolveGateRunTimeoutMs: z.number().default(900000),
  evolveRepeats: z.number().default(3),
  evolveHoldoutSize: z.number().default(5),
  evolveHoldoutCooldown: z.number().default(3),
  evolveHardoutAuditEvery: z.number().default(5),
  evolveMinGain: z.number().default(0.1),
  evolveMaxSafetyRegression: z.number().default(0),
  evolveMaxCheatRegression: z.number().default(0),
  evolveGateMaxTokens: z.number().default(2000000),
  evolveGateMaxWallMs: z.number().default(3600000),
  evolveRunMaxTokens: z.number().default(200000),
  evolvePromote: z.union(['approval', 'auto'] as const).default('approval'),
  evolveAdmission: z.union(['reward', 'self-report'] as const).default('reward'),
  evolveSignificance: z.union(['off', 'bootstrap'] as const).default('off'),
  evolveSignificanceAlpha: z.number().default(0.05),
  evolveRequireDetectability: z.boolean().default(true),
  evolveMaxTokenRegression: z.number().default(0.2),
  evolveMaxProposals: z.number().default(2),
  evolveMaxSkills: z.number().default(8),
  evolveSkillMaxBytes: z.number().default(16384),
  evolveRationaleMax: z.number().default(2000),
  evolveStaticScan: z.union(['rules', 'rules+llm'] as const).default('rules'),
  evolveScanModel: z.string().required(false),
  evolveBriefTopN: z.number().default(5),
  evolveRollbackWindow: z.number().default(10),
  evolveRollbackMargin: z.number().default(0.2),
  evolveCandidateVersion: z.string().required(false),
})
