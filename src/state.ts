/**
 * Per-plugin mutable state: the WeakMap/WeakSet containers every listener and
 * tool closes over. Created once per `apply()` so extracted modules share one
 * object identity without importing the wiring root.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FlowRecorder } from './flow.ts'
import type { TranscriptEntry } from './dataset.ts'
import type { StepPlan } from './types.ts'

/** What the model saw in one session, for the exported DPO prompts. */
export interface TranscriptState {
  /** Ordered session events the DPO prompt must reproduce. */
  entries: TranscriptEntry[]
  /** Map from each `lcrd_plan` call id to its transcript index. */
  planIndexByCallId: Map<string, number>
}

/** One piece of knowledge a learning tool produced this round, so a self-evaluation can cite it. */
export interface LearnEvidence {
  /** Short id the model cites in `lcrd_learn_verify`. */
  id: string
  /** What produced it: a file read, a URL fetch, or another learning tool call. */
  kind: 'path' | 'url' | 'call'
  /** The path, URL, or call identity the entry describes. */
  label: string
  /** Digest of the acquired text, so two rounds that read different content differ. */
  digest: string
  /** Clipped excerpt of that text, so the record names what was actually acquired. */
  excerpt: string
}

/** Per-agent learning-mode state: consumed rounds, the current phase, and the knowledge acquired this round. */
export interface LearningState {
  /** Learning rounds already consumed. */
  attempts: number
  /** Whether the model is declaring/learning or re-solving. */
  phase: 'learn' | 'resolve'
  /** Knowledge the configured learning tools produced this round; a self-evaluation must cite one. */
  evidence: LearnEvidence[]
}

/** The verdict the model last saw, so the next declaration records its decision context. */
export interface LastVerdict {
  /** Whether the last verifier passed. */
  pass: boolean
  /** The verifier's reason text. */
  reason: string
  /** Which verifier kind produced it. */
  verifierKind: string
}

/**
 * All mutable containers for one plugin instance. The wiring root creates one
 * and passes it (or a deps object holding it) into extracted tools and
 * listeners so they never import `index.ts`.
 */
export interface LcrdState {
  /** Each agent's latest declared step plan. */
  plans: WeakMap<Agent, StepPlan>
  /** Consecutive verifier failures per agent. */
  failures: WeakMap<Agent, number>
  /**
   * Fingerprint of the plan whose last verification failed, so an identical
   * redeclaration of that same failed method is rejected at declaration time.
   * Cleared when a verification passes and when a new user command starts a
   * fresh task.
   */
  failedPlanKeys: WeakMap<Agent, string>
  /** Policy-hook interceptions (deny / block / failing hook), bounded by `maxRetries` independently of the task budget. */
  hookInterceptions: WeakMap<Agent, number>
  /**
   * Executions whose own result already states a terminal decision made during
   * the tool body — a policy-hook termination or a repeated-failed-declaration
   * termination. The terminated guard must leave that specific message intact
   * on the terminating call; only later calls get the generic notice.
   */
  terminalExecutions: WeakSet<object>
  /** The verdict the model last saw, so the next declaration records its decision context. */
  lastVerdict: WeakMap<Agent, LastVerdict>
  /** Recorders whose dataset export already happened, so disposal and exit never double-append. */
  exportedRecorders: WeakSet<FlowRecorder>
  /** The model-visible transcript per session, for the exported DPO prompts. */
  transcripts: WeakMap<Session, TranscriptState>
  /** Token usage observed before the session's flow recorder existed, folded in when it is created. */
  pendingTokens: WeakMap<Session, number>
  /** Failures in which the engine rejected the model's own check rather than the work. */
  invalidChecks: WeakMap<Agent, number>
  /** Agents whose retry budget is exhausted (further tool results are blocked). */
  terminated: WeakSet<Agent>
  /** Per-agent learning-mode state. */
  learning: WeakMap<Agent, LearningState>
  /** Per-agent consecutive task-context path denials under the file-flow guard. */
  pathViolations: WeakMap<Agent, number>
  /** Per-agent file-flow launch gate: the pinned `task-flow/<task-slug>` directory, set by the first task-context access. */
  taskDirs: WeakMap<Agent, string>
  /** Executions denied by the file-flow guard; their results are final and never run the verifier. */
  guardDenied: WeakSet<object>
  /** Per-agent flow recorder, created lazily on first protocol step. */
  flows: WeakMap<Agent, FlowRecorder>
  /** Per-session mirror of the flow recorder, for turn-boundary dumps. */
  sessionRecorders: WeakMap<Session, FlowRecorder>
  /** The session a recorder belongs to, so the process-exit flush can export it. */
  recorderSessions: WeakMap<FlowRecorder, Session>
  /** Agents whose approval policy was already pinned, so `ensureFlow` sets it once. */
  policySet: WeakSet<Agent>
  /** Every recorder this plugin instance created, for process-exit flush. */
  allRecorders: Set<FlowRecorder>
}

/**
 * Create an empty state object for one `apply()` call.
 * @returns fresh containers with no cross-plugin leakage.
 */
export function createState(): LcrdState {
  return {
    plans: new WeakMap(),
    failures: new WeakMap(),
    failedPlanKeys: new WeakMap(),
    hookInterceptions: new WeakMap(),
    terminalExecutions: new WeakSet(),
    lastVerdict: new WeakMap(),
    exportedRecorders: new WeakSet(),
    transcripts: new WeakMap(),
    pendingTokens: new WeakMap(),
    invalidChecks: new WeakMap(),
    terminated: new WeakSet(),
    learning: new WeakMap(),
    pathViolations: new WeakMap(),
    taskDirs: new WeakMap(),
    guardDenied: new WeakSet(),
    flows: new WeakMap(),
    sessionRecorders: new WeakMap(),
    recorderSessions: new WeakMap(),
    policySet: new WeakSet(),
    allRecorders: new Set(),
  }
}
