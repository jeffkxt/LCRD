/**
 * Vocabulary for the versioned policy layer: the immutable version manifest,
 * the current-version pointer, quarantine records, the three-tier benchmark,
 * and the gate/score artifacts. Pure types — no filesystem or harness access —
 * so the store, the gate, and the CLI agree on one definition.
 *
 * @module lcrd-evolve-types
 */
import type { RelaxType } from '../types.ts'

/** How a relaxation came about, judged from the recorded facts. Only `speculative_cheat` is penalized. */
export type { RelaxType }

/** Lifecycle of one policy version. */
export type PolicyVersionStatus =
  /** Written by a proposal, awaiting its gate. */
  | 'proposed'
  /** The gate ran and the candidate did not qualify. */
  | 'gated-failed'
  /** The gate stopped on its token budget before deciding. */
  | 'gate-aborted'
  /** The gate passed; awaiting human approval or offline promotion. */
  | 'gated-passed'
  /** The current version. */
  | 'promoted'
  /** Reverted by the online monitor; never usable as a parent again. */
  | 'quarantined'

/** One skill file a version carries. */
export interface PolicySkill {
  /** Kebab-case skill name. */
  name: string
  /** Model-facing catalog description. */
  description: string
  /** SHA-256 hex digest of the markdown body. */
  digest: string
  /** Body size in bytes. */
  bytes: number
}

/** The immutable record of one policy version. */
export interface PolicyManifest {
  /** Manifest vocabulary version. */
  schemaVersion: 1
  /** Version name, `v` plus at least four digits. */
  version: string
  /** The version this one was proposed against; null for the bootstrap version. */
  parent: string | null
  /** ISO-8601 creation instant. */
  createdAt: string
  /** Session that authored the proposal, for attribution. */
  authorSession: string | null
  /** The model's own justification, recorded verbatim. */
  rationale: string
  /** Digest of the benchmark the gate scored against; null before a gate. */
  benchmarkDigest: string | null
  /** The gate that qualified this version; null before a gate or for the bootstrap version. */
  gateId: string | null
  /** Skills this version carries. */
  skills: PolicySkill[]
  /** Lifecycle state. */
  status: PolicyVersionStatus
}

/** One promotion in the pointer's audit history. */
export interface PromotionRecord {
  /** The promoted version. */
  version: string
  /** ISO-8601 promotion instant. */
  ts: string
  /** The gate that qualified it; null for the bootstrap version and offline promotions. */
  gateId: string | null
  /** Who promoted it: a session id, `operator`, or `bootstrap`. */
  promotedBy: string
}

/**
 * One version's admission outcome, appended to the archive when its gate ends.
 * Every gate writes a row, admitted or not: the archive is the search's memory
 * of stepping stones, and parent selection reads it instead of assuming the
 * active version is the only place to start from.
 */
export interface ArchiveEntry {
  /** Row vocabulary version. */
  schemaVersion: 1
  /** The version this row describes. */
  version: string
  /** The version it was proposed against. */
  parent: string | null
  /** The gate that judged it; null when the gate never ran. */
  gateId: string | null
  /** Whether the gate admitted it. */
  admitted: boolean
  /** The candidate's admission metric (reward rate or pass rate); null when unavailable. */
  score: number | null
  /** Candidate minus baseline admission metric; null when either side is missing. */
  gain: number | null
  /** Why the gate refused, when it did. */
  reasons: string[]
  /** ISO-8601 instant. */
  ts: string
}

/** The single mutable pointer naming the active version. */
export interface PolicyPointer {
  /** Monotonic revision; every promotion or rollback increments it (CAS guard). */
  revision: number
  /** The active version name. */
  version: string
  /** Promotion history, oldest first. */
  history: PromotionRecord[]
  /** Set by the hard-out audit when the sealed suite degraded; blocks promotions until cleared. */
  promotionHeld: boolean
}

/** One quarantined version and why it was reverted. */
export interface QuarantineEntry {
  /** The quarantined version. */
  version: string
  /** ISO-8601 instant. */
  ts: string
  /** Human-readable cause, shown to the model by the next proposal. */
  reason: string
  /** The online window metrics that triggered the revert. */
  metrics: GateMetrics | null
  /** The parent version's baseline metrics at that time. */
  metricsBaseline: GateMetrics | null
}

/** One benchmark task. */
export interface BenchmarkTask {
  /** Stable task id, unique across all three tiers. */
  id: string
  /** The root-anchor prompt the run starts from. */
  anchor: string
  /** Which tier the task belongs to. */
  suite: 'train' | 'holdout' | 'hardout'
  /** Per-task repeat override; absent uses the gate's configured repeat count. */
  repeats?: number
  /**
   * Ground-truth scoring command, run by the gate after the child exits. The
   * exit code decides when it prints no number: 0 means reward 1, non-zero 0;
   * a printed number is parsed as the reward. Admission requires this command.
   * The command runs inside that run's isolated workspace, so it can only
   * observe artifacts the run produced there.
   */
  reward?: string
  /**
   * Directory under the benchmark root copied into the run's isolated
   * workspace before the child starts. Every run gets its own copy, so a
   * candidate never observes the baseline's artifacts. Absent means the run
   * starts in an empty workspace and must rely on absolute paths.
   */
  fixture?: string
}

/** The loaded three-tier benchmark and its content digest. */
export interface BenchmarkSpec {
  /** SHA-256 hex digest over every suite file, so a mid-gate edit invalidates the run. */
  digest: string
  /** Readable-by-the-model proposal corpus. */
  train: BenchmarkTask[]
  /** Gate-only admission pool. */
  holdout: BenchmarkTask[]
  /** Sealed periodic-audit suite; never used by the daily gate. */
  hardout: BenchmarkTask[]
}

/** One task selection recorded in the rotation history. */
export interface HoldoutSelection {
  /** The gate that used these tasks. */
  gateId: string
  /** ISO-8601 instant. */
  ts: string
  /** Task ids drawn for that gate. */
  ids: string[]
}

/** Rotation history, so a task cannot be reused before its cooldown expires. */
export interface HoldoutHistory {
  /** Selections in chronological order. */
  selections: HoldoutSelection[]
}

/** Aggregated metrics for one side of a gate. */
export interface GateMetrics {
  /** Completed runs divided by attempted runs (the agent's self-assessment). */
  passRate: number
  /** Mean ground-truth reward over runs that carried one; null when none did. */
  rewardRate: number | null
  /**
   * Terminated runs that did not reach full reward, divided by attempted runs.
   * A run the protocol terminated after the task's own reward was met is
   * protocol overhead rather than risk, so the safety comparisons ignore it.
   */
  terminatedRate: number
  /** `speculative_cheat` relaxations divided by plan declarations. */
  cheatRate: number
  /** Total policy-hook interceptions. */
  hookInterceptions: number
  /** Total file-flow path violations. */
  pathViolations: number
  /** Total tokens consumed by the runs. */
  tokens: number
  /** Number of runs aggregated. */
  runs: number
}

/** One recorded gate-side run. */
export interface GateSample {
  /** Task id. */
  taskId: string
  /** 1-based repeat index. */
  repeat: number
  /** The policy version the run mounted. */
  version: string
  /** Whether the child produced a `run.json`; false means the mount itself failed. */
  recorded: boolean
  /** Ground-truth reward the task's scoring command produced, or null when the task carries none. */
  reward: number | null
  /** How the run stood. */
  termination: 'terminated' | 'completed' | 'incomplete'
  /** LCRD's internal verdict. */
  finalVerdict: 'pass' | 'fail' | 'terminated'
  /** Relaxation counts by type. */
  relaxTypes: Record<RelaxType, number>
  /** Plan declarations the run recorded. */
  planCount: number
  /** Tokens the run reported. */
  tokens: number
  /** Policy-hook interceptions the run reported. */
  hookInterceptions: number
  /** File-flow path violations the run reported. */
  pathViolations: number
}

/** The gate report written beside the candidate version. */
export interface GateReport {
  /** Report vocabulary version. */
  schemaVersion: 1
  /** Gate identity. */
  gateId: string
  /** The candidate version under test. */
  version: string
  /** The version the candidate was compared against. */
  baselineVersion: string
  /** ISO-8601 instant. */
  createdAt: string
  /** Benchmark digest at the start; a change mid-gate voids the result. */
  benchmarkDigest: string
  /** Task ids drawn from the holdout pool. */
  selectedTasks: string[]
  /** Repeats per task. */
  repeats: number
  /** Which metric decided admission. */
  admission: 'reward' | 'self-report'
  /** Baseline aggregate. */
  baseline: GateMetrics
  /** Candidate aggregate. */
  candidate: GateMetrics
  /** Whether the candidate qualified. */
  pass: boolean
  /** The manifest outcome this report describes. */
  outcome: 'gated-passed' | 'gated-failed' | 'gate-aborted'
  /** Why it did or did not qualify. */
  reasons: string[]
  /** The admission threshold this gate was judged against. */
  minGain: number
  /** Smallest gain this gate's own sample could detect; null with fewer than two paired runs. */
  detectability: number | null
  /** Paired rows the detectability reading used. */
  pairedN: number
  /** Every run, so a reader sees raw rows rather than a verdict. */
  samples: GateSample[]
}

/** The online score folded from finished runs. */
export interface PolicyScore {
  /** The scored version. */
  version: string
  /** The most recent window of run observations. */
  window: GateSample[]
  /**
   * The version's own first full window, used as its online reference. The
   * monitor never compares online runs with the gate's holdout metrics: the
   * task distributions differ.
   */
  baseline: GateMetrics | null
  /** ISO-8601 instant of the latest fold. */
  updatedAt: string
}

/** One statically detected risk in a proposed skill body. */
export interface StaticFinding {
  /** Rule id, stable across releases. */
  rule: string
  /** Whether the finding blocks the proposal or only warns. */
  severity: 'block' | 'warn'
  /** 1-based line number; 0 for a whole-file rule. */
  line: number
  /** Clipped offending text, safe to render in a report. */
  excerpt: string
}

/** Stage that rejected one proposal. */
export type RejectedEditStage = 'static-scan' | 'gate-failed' | 'gate-aborted'

/** One rejected proposal, replayed as negative feedback for the next proposal. */
export interface RejectedEdit {
  /** Log vocabulary version. */
  schemaVersion: 1
  /** `'unstaged'` when the static scan rejected it before a version existed. */
  version: string
  /** The parent version the proposal named. */
  parent: string
  /** ISO-8601 instant. */
  ts: string
  /** Which stage produced the rejection. */
  stage: RejectedEditStage
  /** Clipped rejection reasons, safe to render in a tool result. */
  reasons: string[]
  /** Static findings grouped by skill; absent for gate stages. */
  findings?: { skill: string; findings: StaticFinding[] }[]
  /** Gate metrics for a failed gate; absent or null otherwise. */
  metrics?: { baseline: GateMetrics; candidate: GateMetrics } | null
}

/** One skill the model proposes. */
export interface ProposedSkill {
  /** Kebab-case skill name. */
  name: string
  /** Model-facing catalog description. */
  description: string
  /** Markdown instruction body. */
  content: string
}

/** One promotion result returned to the tool and the CLI. */
export interface PromotionResult {
  /** The version that became current. */
  version: string
  /** The pointer revision after the switch. */
  revision: number
}
