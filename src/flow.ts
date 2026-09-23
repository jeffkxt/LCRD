/**
 * LCRD execution-flow recorder: every protocol event (plan, tool, verdict,
 * intercept) is appended in order, and the flow artifacts — a Mermaid
 * flowchart (viewable in VS Code, GitHub, mermaid.live), a Markdown report,
 * and a raw JSON transcript — are rewritten after every completed turn, on
 * agent disposal, and on process exit, so they stay fresh while the agent
 * lives.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describeStrictness, relaxationAxes, type AssertionStrictness, type RelaxationAxis } from './instrumentation.ts'
import { datasetRowsForRun, defaultAttribution, type RunRows } from './dataset.ts'
import type { Attribution } from './attribution.ts'
import type { VerdictExceptionKind, VerifierSpec } from './types.ts'

/** Where flow artifacts land: an explicit override, or the default plugin-folder location. */
export type FlowOutDir = string | undefined

/** Current artifact schema version; changes when a recorded field changes meaning. */
export const FLOW_SCHEMA_VERSION = 2

/** The append-only event stream written beside the rewritten snapshot files. */
export const FLOW_STREAM_FILE = 'lcrd-flow.jsonl'

/** The per-run metadata file written beside the events: what ran, under which configuration. */
export const RUN_META_FILE = 'run.json'

/**
 * What the model had just seen when it declared a plan: the decision context
 * that turns a recorded declaration into a (state, action) sample without
 * joining the session log.
 */
export interface PlanContext {
  /** Consecutive verifier failures at declaration time. */
  failures: number
  /** Learning phase the declaration was made in. */
  phase: 'normal' | 'learn' | 'resolve'
  /** Clipped reason of the preceding verdict; null when no verdict has run. */
  lastReason: string | null
  /** Whether the preceding verdict passed; null when no verdict has run. */
  lastPass: boolean | null
  /** Verifier kind of the preceding verdict; null when no verdict has run. */
  lastVerifierKind: string | null
  /** Failures in which the engine rejected the model's own check rather than the work. */
  invalidChecks: number
}

/** One ordered protocol event. */
export type FlowEvent =
  | {
    type: 'plan'
    goal: string
    stop: string
    feasibility: boolean
    verifier: string
    verifierSpec?: VerifierSpec
    /** Strictness reading of the declared check, stamped by the recorder. */
    strictness?: AssertionStrictness
    /** Axes the declared check loosened along relative to the previous plan, stamped by the recorder. */
    relaxation?: RelaxationAxis[]
    /** What the model had just seen when it declared this plan. */
    context?: PlanContext
    /** Whether this declaration repeats the agent's own previous one, so no method change happened. */
    repeatPlan?: boolean
    /** The `lcrd_plan` call's identity, so a dataset row joins the session log's call. */
    callId?: string
  }
  | {
    type: 'tool'
    name: string
    /** Call identity from the tool runtime, so the event joins the session log's tool records. */
    callId?: string
    /** Clipped JSON of the model-supplied arguments: what the run declared it was doing. */
    argsSummary?: string
    /** Runtime kind of the structured result (`error` for a failed call). */
    resultKind?: string
    /** Clipped JSON of the structured result, or the rendered content for a failed call. */
    resultSummary?: string
    /** Failure message of a failed call. */
    errorMessage?: string
    /** Machine-routable error code of a failed call, when the runtime supplied one. */
    errorCode?: string
  }
  | {
    type: 'verdict'
    pass: boolean
    reason: string
    count?: number
    /** Verifier kind that produced this verdict. */
    verifierKind?: string
    /** The verified call's identity, so a verdict names its referent instead of relying on position. */
    callId?: string
    /** The verified call's tool name. */
    tool?: string
    /** Why the verifier threw, when it did. */
    exceptionKind?: VerdictExceptionKind
  }
  | { type: 'learn'; analysis: string; knowledge: string; method: string; criteria: string }
  | { type: 'learn-verify'; learned: boolean; evidence: string; count?: number }
  | {
    type: 'intercept'
    /**
     * Why the execution was intercepted. `terminated` and `hook-terminated` end
     * the task for human review; the `hook-*` kinds name a policy-hook decision
     * (or a failing hook itself), which consumes no task retry budget.
     */
    kind: 'missing-plan' | 'infeasible' | 'terminated' | 'hook-denied' | 'hook-blocked' | 'hook-terminated' | 'hook-error'
    detail: string
  }

/**
 * Whether an intercept kind ends the task for human review.
 * @param kind - the recorded intercept kind.
 * @returns true when the run is terminal.
 */
function isTerminalIntercept(kind: string): boolean {
  return kind === 'terminated' || kind === 'hook-terminated'
}

/** Envelope the recorder stamps on every appended event. */
export interface FlowEventEnvelope {
  /** 1-based position in the recorded stream, equal to the `.jsonl` line number. */
  seq: number
  /** ISO-8601 instant the event was appended. */
  ts: string
}

/** One recorded event: the protocol event plus its envelope. */
export type RecordedFlowEvent = FlowEvent & FlowEventEnvelope

/** The interaction mode recorded per task, mirrored from the plugin config. */
export type InteractionMode = 'auto' | 'auth' | 'manual'

/** Machine-readable summary line emitted alongside the detailed events. */
export interface FlowMeta {
  session_id: string
  task_id: string
  md_file: string
  human_interaction_mode: InteractionMode
  hit_ask_intercepted: boolean
  lcrd_retry_consumed: number
  lcrd_retry_max: number
  goal_changed_times: number
  stop_changed_times: number
  verifier_changed_times: number
  has_verifier_exception: boolean
  final_verdict: 'pass' | 'fail' | 'terminated'
  tb_final_reward: number | null
  root_cause_hint: string | null
  learning_enabled: boolean
  learning_threshold: number
  learning_attempts_max: number
  learning_attempts_consumed: number
  learning_success: boolean
  /** Schema version of this artifact set; a recorded field that changes meaning bumps it. */
  schema_version: number
  /** Append-only event stream written beside this snapshot, one JSON event per line. */
  events_file: string
  /** Digest of the anchoring first user message, or null before one is recorded. */
  anchor_digest: string | null
  /** Clipped text of that message, so an offline judge can label anchor conformance. */
  anchor_excerpt: string | null
  /** Plan declarations that loosened their check relative to the previous declaration. */
  relaxation_count: number
  /** Plan declarations that repeated the previous one, so no method change happened. */
  repeat_plan_count: number
  /** Version of the plugin package that recorded this run. */
  plugin_version: string
  /** Version of the injected protocol text and corrective notices. */
  protocol_version: number
  /** Model the agent ran with, as recorded at first write. */
  model: string | null
  /** Provider behind that model. */
  provider: string | null
  /** Platform the run was recorded on. */
  platform: string
}

/** The per-run metadata written beside the events: what ran, under which configuration. */
export interface RunMeta {
  schema_version: number
  plugin_version: string
  protocol_version: number
  session_id: string
  task_id: string
  /** The configuration the plugin was mounted with, as validated. */
  config: unknown
  model: string | null
  provider: string | null
  platform: string
  arch: string
  node: string
  /** The session's working directory, when the agent carried one. */
  cwd: string | null
  started_at: string
  /** Time of the latest write; equal to `started_at` before the first flush. */
  ended_at: string
  final_verdict: FlowMeta['final_verdict']
  /** How the run stands: the protocol terminated it, the last verdict passed, or it is still open. */
  termination: 'terminated' | 'completed' | 'incomplete'
  anchor_digest: string | null
  /** Clipped anchoring user message, so an offline judge can label anchor conformance. */
  anchor_excerpt: string | null
}

/** Walk up from this module to the nearest directory owning a `package.json`. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    /* v8 ignore next -- the module always sits inside a package; the filesystem-root escape is defensive */
    if (parent === dir) return dir
    dir = parent
  }
}

/**
 * Default log directory: a `lcrd-flow` folder inside the plugin package.
 * @returns the absolute default artifact directory.
 */
export function defaultLogDir(): string {
  return join(packageRoot(), 'lcrd-flow')
}

/** The plugin package's own recorded version, read from its manifest once. */
let cachedPluginVersion: string | undefined

/**
 * The version of the plugin package that records a run, so artifacts from
 * different releases stay distinguishable.
 * @returns the package version, or `unknown` when the manifest cannot be read.
 */
export function pluginVersion(): string {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion
  /* v8 ignore start -- the manifest is unreadable only from a broken installation */
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    cachedPluginVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    cachedPluginVersion = 'unknown'
  }
  /* v8 ignore stop */
  return cachedPluginVersion
}

/** Make a filesystem-safe, human-readable task slug. */
function slugify(text: string): string {
  const cleaned = text.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim()
  return cleaned.length === 0 ? '' : cleaned.slice(0, 60)
}

/**
 * Stable 8-hex suffix from an agent id, disambiguating same-slug task folders.
 * @param id - the agent or session id to hash.
 * @returns the 8-hex FNV-1a hash suffix.
 */
export function shortAgentId(id: string): string {
  let hash = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Escape node text for Mermaid syntax. */
function mermaidEscape(text: string): string {
  return text
    .replace(/"/g, '#quot;')
    .replace(/\(/g, '#40;')
    .replace(/\)/g, '#41;')
    .replace(/\[/g, '#91;')
    .replace(/\]/g, '#93;')
    .replace(/\|/g, '#124;')
    .replace(/</g, '#60;')
    .replace(/>/g, '#62;')
}

/** Clip long event text to keep the flowchart readable. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Normalized fingerprint of one declaration: its goal, stop condition, and
 * verifier specification. Two declarations with the same fingerprint retry the
 * same method, which is what the rollback symbol forbids.
 * @param plan - a plan event, or a step plan's goal/stop plus its verifier fields.
 * @returns the fingerprint string compared across declarations.
 */
export function planFingerprint(plan: { goal: string; stop: string; verifier: string; verifierSpec?: VerifierSpec }): string {
  return [plan.goal.trim(), plan.stop.trim(), JSON.stringify(plan.verifierSpec ?? plan.verifier)].join('\u0000')
}

/** Options for {@link FlowRecorder}. */
export interface FlowRecorderOptions {
  /** Artifact directory; defaults to {@link defaultLogDir}. */
  outDir?: FlowOutDir
  /** Per-task identifier for the `task_id` meta field; defaults to the agent id (the first plan goal overrides it). */
  taskSlug?: string
  /** The interaction mode this task ran under; recorded in the meta summary. */
  interaction?: InteractionMode
  /** External Terminal-Bench sandbox reward (0/1), filled in after the run. */
  tbFinalReward?: number | null
  /** Optional root-cause label, e.g. from the external evaluator. */
  rootCauseHint?: string | null
  /** Whether the learning loop is enabled; recorded in the meta summary. */
  learningEnabled?: boolean
  /** Consecutive verifier failures that enter learning mode; recorded in the meta summary. */
  learningThreshold?: number
  /** Learning-round budget; recorded in the meta summary. */
  maxLearningAttempts?: number
  /** Version of the plugin package recording this run; defaults to the package's own version. */
  pluginVersion?: string
  /** Version of the injected protocol text and corrective notices. */
  protocolVersion?: number
  /** The validated plugin configuration, recorded verbatim for cross-run comparison. */
  config?: unknown
  /** The attribution bundle classifying failures, relaxations, and trainability; defaults to the log heuristics. */
  attribution?: Attribution
}

/** In-order recorder for one agent's whole session (one task), one subfolder per agent. */
export class FlowRecorder {
  private readonly events: RecordedFlowEvent[] = []
  private readonly agentId: string
  private readonly maxRetries: number
  private readonly outDir: string
  private readonly interaction: InteractionMode
  private readonly tbFinalReward: number | null
  private readonly rootCauseHint: string | null
  private readonly learningEnabled: boolean
  private readonly learningThreshold: number
  private readonly maxLearningAttempts: number
  private readonly attribution: Attribution
  private taskSlug: string
  private taskLabeled = false
  private logOpened = false
  private taskDirName: string | undefined
  private goalChanged = 0
  private stopChanged = 0
  private verifierChanged = 0
  private askIntercepted = false
  private verifierException = false
  private retryConsumed = 0
  private hasAnyVerdict = false
  private lastPass = false
  private learningAttemptsConsumed = 0
  private learningSucceeded = false
  private previousStrictness: AssertionStrictness | undefined
  private relaxationCount = 0
  private repeatPlanCount = 0
  private anchorDigest: string | null = null
  private anchorExcerpt: string | null = null
  private readonly pluginVersionValue: string
  private readonly protocolVersion: number
  private readonly configSnapshot: unknown
  private readonly model: string | null
  private readonly provider: string | null
  private readonly cwd: string | null
  private readonly startedAt: string
  private endedAt: string

  /** @param agent - the session owner; its id disambiguates the output files. */
  /** @param maxRetries - the configured failure budget, shown on FAIL verdicts. */
  /** @param options - artifact directory (defaults to the plugin folder), task slug, and meta inputs. */
  constructor(agent: Agent, maxRetries: number, options?: FlowRecorderOptions) {
    this.agentId = String(agent.id)
    this.maxRetries = maxRetries
    this.outDir = options?.outDir ?? defaultLogDir()
    this.taskSlug = options?.taskSlug ?? this.agentId
    this.interaction = options?.interaction ?? 'manual'
    this.tbFinalReward = options?.tbFinalReward ?? null
    this.rootCauseHint = options?.rootCauseHint ?? null
    this.learningEnabled = options?.learningEnabled ?? false
    this.learningThreshold = options?.learningThreshold ?? 5
    this.maxLearningAttempts = options?.maxLearningAttempts ?? 3
    this.pluginVersionValue = options?.pluginVersion ?? pluginVersion()
    this.protocolVersion = options?.protocolVersion ?? 0
    this.configSnapshot = options?.config
    this.attribution = options?.attribution ?? defaultAttribution
    this.model = agent.options.model ?? null
    this.provider = agent.options.provider ?? null
    this.cwd = agent.session.header.cwd ?? null
    this.startedAt = new Date().toISOString()
    this.endedAt = this.startedAt
  }

  /**
   * The per-task artifact subfolder. Named after the goal slug plus a stable
   * agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
   * agents with the same goal never collide; without a goal it falls back to
   * the agent id (a `session-<uuid>`). Fixed at the first write so early
   * events and later events always land in the same folder.
   */
  private taskDir(): string {
    if (this.taskDirName === undefined) {
      this.taskDirName = this.taskSlug !== this.agentId
        ? `${this.taskSlug}-${shortAgentId(this.agentId)}`
        : this.agentId
    }
    return join(this.outDir, this.taskDirName)
  }

  /**
   * Append one event; artifacts are rewritten per turn, on disposal, and on process exit.
   * @param event - the ordered protocol event to append.
   */
  push(event: FlowEvent): void {
    if (event.type === 'plan') {
      if (!this.taskLabeled) {
        const slug = slugify(event.goal)
        if (slug) {
          this.taskSlug = slug
          this.taskLabeled = true
        }
      }
      this.trackPlanChange(event)
    } else if (event.type === 'verdict') {
      this.hasAnyVerdict = true
      this.lastPass = event.pass
      if (event.count !== undefined) this.retryConsumed = event.count
    } else if (event.type === 'learn-verify') {
      if (event.count !== undefined) this.learningAttemptsConsumed = event.count
    } else if (event.type === 'intercept' && event.kind === 'terminated') {
      this.retryConsumed = this.maxRetries
    }
    const recorded = this.stamp(event)
    this.events.push(recorded)
    this.appendStream(recorded)
  }

  /**
   * Stamp one appended event with its envelope and, for a plan, the strictness
   * reading plus the axes it relaxed along. The comparison uses this agent's
   * own previous declaration, so a relaxation label never depends on another
   * agent's plan.
   * @param event - the ordered protocol event to append.
   * @returns the recorded event written to both the snapshot and the stream.
   */
  private stamp(event: FlowEvent): RecordedFlowEvent {
    const envelope: FlowEventEnvelope = { seq: this.events.length + 1, ts: new Date().toISOString() }
    if (event.type !== 'plan') return { ...event, ...envelope }
    const previous = this.previousPlan()
    const repeatPlan = previous !== undefined
      && planFingerprint(previous) === planFingerprint(event)
    if (repeatPlan) this.repeatPlanCount += 1
    if (event.verifierSpec === undefined) return { ...event, ...envelope, relaxation: [], repeatPlan }
    const strictness = describeStrictness(event.verifierSpec)
    const relaxation = this.previousStrictness === undefined
      ? []
      : relaxationAxes(this.previousStrictness, strictness)
    if (relaxation.length > 0) this.relaxationCount += 1
    this.previousStrictness = strictness
    return { ...event, ...envelope, strictness, relaxation, repeatPlan }
  }

  /** The agent's own preceding plan declaration, when there is one. */
  private previousPlan(): Extract<FlowEvent, { type: 'plan' }> | undefined {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const candidate = this.events[i]
      if (candidate !== undefined && candidate.type === 'plan') return candidate
    }
    return undefined
  }

  /**
   * Append one recorded event to the task's `.jsonl` stream. The snapshot files
   * are rewritten on every dump, so the stream is the durable record: an
   * interrupted run keeps every event already appended, and no later dump
   * rewrites what earlier turns recorded.
   * @param event - the recorded event to append.
   */
  private appendStream(event: RecordedFlowEvent): void {
    /* v8 ignore start -- the stream fails only on filesystem errors, which must never break the session */
    try {
      mkdirSync(this.taskDir(), { recursive: true })
      appendFileSync(join(this.taskDir(), FLOW_STREAM_FILE), `${JSON.stringify(event)}\n`, 'utf8')
    } catch { /* the stream must never break the session */ }
    /* v8 ignore stop */
  }

  /**
   * External fields an offline evaluator backfilled into the previous snapshot.
   * Reading them back keeps a mid-process backfill from being overwritten by
   * the next dump; the constructor options still win over the file.
   * @returns the backfilled reward and root-cause hint; each null when absent.
   */
  private readBackfill(): { reward: number | null; hint: string | null } {
    try {
      const raw = JSON.parse(readFileSync(join(this.taskDir(), 'lcrd-flow.json'), 'utf8')) as {
        tb_final_reward?: unknown
        root_cause_hint?: unknown
      }
      return {
        reward: typeof raw.tb_final_reward === 'number' ? raw.tb_final_reward : null,
        hint: typeof raw.root_cause_hint === 'string' ? raw.root_cause_hint : null,
      }
    } catch {
      return { reward: null, hint: null }
    }
  }

  /** Compare a newly declared plan against the previous one, counting contract drift. */
  private trackPlanChange(event: { goal: string; stop: string; verifier: string; verifierSpec?: VerifierSpec }): void {
    let previous: FlowEvent | undefined
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const candidate = this.events[i]
      if (candidate !== undefined && candidate.type === 'plan') {
        previous = candidate
        break
      }
    }
    if (!previous || previous.type !== 'plan') return
    if (previous.goal !== event.goal) this.goalChanged += 1
    if (previous.stop !== event.stop) this.stopChanged += 1
    const specA = previous.verifierSpec ?? previous.verifier
    const specB = event.verifierSpec ?? event.verifier
    if (JSON.stringify(specA) !== JSON.stringify(specB)) this.verifierChanged += 1
  }

  /** Record that an `ask_user_question` was auto-intercepted in unattended mode. */
  markAskIntercepted(): void {
    this.askIntercepted = true
  }

  /** Record that a verifier failure was an exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
  markVerifierException(): void {
    this.verifierException = true
  }

  /**
   * Compute the per-run metadata: what ran, with which model, under which
   * configuration and protocol version.
   * @returns the metadata written to `run.json`.
   */
  computeRunMeta(): RunMeta {
    const meta = this.computeMeta()
    const terminal = meta.final_verdict === 'terminated'
    return {
      schema_version: FLOW_SCHEMA_VERSION,
      plugin_version: this.pluginVersionValue,
      protocol_version: this.protocolVersion,
      session_id: this.agentId,
      task_id: this.taskSlug,
      config: this.configSnapshot,
      model: this.model,
      provider: this.provider,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cwd: this.cwd,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      final_verdict: meta.final_verdict,
      termination: terminal ? 'terminated' : meta.final_verdict === 'pass' ? 'completed' : 'incomplete',
      anchor_digest: this.anchorDigest,
      anchor_excerpt: this.anchorExcerpt,
    }
  }

  /**
   * Convert this run's recorded events into dataset rows: the same shape the
   * corpus-level exporter writes, built from the recorder's own state so the
   * plugin can export a run the moment it finishes.
   * @returns the run's dataset rows, relaxation rows, and run-level row.
   */
  datasetRows(): RunRows {
    const run = this.computeRunMeta()
    return datasetRowsForRun({
      runId: this.agentId,
      sessionId: this.agentId,
      taskId: this.taskSlug,
      taskGroup: this.anchorDigest ?? this.taskSlug,
      events: this.events,
      meta: this.computeMeta(),
      run,
    }, this.attribution)
  }

  /** Record that the task completed through a post-learning re-solve; resets the consumed-attempts report. */
  markLearningSuccess(): void {
    this.learningSucceeded = true
    this.learningAttemptsConsumed = 0
  }

  /**
   * Record the digest and excerpt of the task's root anchor. Only the first
   * call counts: the anchor is the conversation's first user message, so a
   * later command in the same session must not replace it.
   * @param digest - hex digest of the anchoring user message text.
   * @param excerpt - clipped text of that message, for offline anchor judgement.
   */
  markAnchorDigest(digest: string, excerpt: string): void {
    if (this.anchorDigest !== null) return
    this.anchorDigest = digest
    this.anchorExcerpt = excerpt
  }

  /**
   * Compute the machine-readable summary from the recorded state.
   * @returns the summary line emitted in the JSON transcript.
   */
  computeMeta(): FlowMeta {
    const terminal = this.events.some(
      event => event.type === 'intercept' && isTerminalIntercept(event.kind),
    )
    const finalVerdict: FlowMeta['final_verdict'] = terminal
      ? 'terminated'
      : this.hasAnyVerdict
        ? (this.lastPass ? 'pass' : 'fail')
        : 'fail'
    const backfill = this.readBackfill()
    return {
      session_id: this.agentId,
      task_id: this.taskSlug,
      md_file: 'lcrd-flow.md',
      human_interaction_mode: this.interaction,
      hit_ask_intercepted: this.askIntercepted,
      lcrd_retry_consumed: this.retryConsumed,
      lcrd_retry_max: this.maxRetries,
      goal_changed_times: this.goalChanged,
      stop_changed_times: this.stopChanged,
      verifier_changed_times: this.verifierChanged,
      has_verifier_exception: this.verifierException,
      final_verdict: finalVerdict,
      tb_final_reward: this.tbFinalReward ?? backfill.reward,
      root_cause_hint: this.rootCauseHint ?? backfill.hint,
      learning_enabled: this.learningEnabled,
      learning_threshold: this.learningThreshold,
      learning_attempts_max: this.maxLearningAttempts,
      learning_attempts_consumed: this.learningAttemptsConsumed,
      learning_success: this.learningSucceeded,
      schema_version: FLOW_SCHEMA_VERSION,
      events_file: FLOW_STREAM_FILE,
      anchor_digest: this.anchorDigest,
      anchor_excerpt: this.anchorExcerpt,
      relaxation_count: this.relaxationCount,
      repeat_plan_count: this.repeatPlanCount,
      plugin_version: this.pluginVersionValue,
      protocol_version: this.protocolVersion,
      model: this.model,
      provider: this.provider,
      platform: process.platform,
    }
  }

  /**
   * Append one line to this task's live `.log` file (and keep echoing to console).
   * @param line - the timestamped log line to append.
   */
  log(line: string): void {
    console.log(line)
    try {
      mkdirSync(this.taskDir(), { recursive: true })
      if (!this.logOpened) {
        appendFileSync(
          join(this.taskDir(), 'lcrd-flow.log'),
          `# LCRD 任务日志 — Agent ${this.agentId} — 起始 ${new Date().toISOString()}\n`,
          'utf8',
        )
        this.logOpened = true
      }
      appendFileSync(join(this.taskDir(), 'lcrd-flow.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // logging must never break the session
    }
  }

  /**
   * Render the Mermaid flowchart source.
   * @returns the flowchart text with every event chained in order.
   */
  renderMermaid(): string {
    const lines = ['flowchart TD']
    let index = 0
    let previous: string | undefined
    for (const event of this.events) {
      index += 1
      let id: string
      switch (event.type) {
        case 'plan':
          id = `P${index}`
          lines.push(`${id}["lcrd_plan: ${mermaidEscape(clip(event.goal, 40))}<br/>verifier=${event.verifier}"]`)
          break
        case 'tool':
          id = `T${index}`
          lines.push(`${id}["tool: ${mermaidEscape(event.name)}"]`)
          break
        case 'verdict': {
          id = `V${index}`
          const label = event.pass
            ? 'verify PASS'
            : `verify FAIL${event.count === undefined ? '' : ` ${event.count}/${this.maxRetries}`}`
          lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.reason, 60))}"}`)
          break
        }
        case 'learn':
          id = `L${index}`
          lines.push(`${id}["lcrd_learn: ${mermaidEscape(clip(event.analysis, 30))}<br/>learn=${mermaidEscape(clip(event.method, 30))}"]`)
          break
        case 'learn-verify': {
          id = `LV${index}`
          const label = event.learned
            ? 'learn PASS'
            : `learn FAIL${event.count === undefined ? '' : ` ${event.count}/${this.maxLearningAttempts}`}`
          lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.evidence, 60))}"}`)
          break
        }
        case 'intercept': {
          id = `I${index}`
          const label = event.kind === 'missing-plan'
            ? '拦截: 未声明计划'
            : event.kind === 'infeasible'
              ? '拦截: 计划不可行'
              : event.kind === 'hook-denied'
                ? '拦截: 策略拒绝声明'
                : event.kind === 'hook-blocked'
                  ? '拦截: 策略拒绝结果'
                  : event.kind === 'hook-error'
                    ? '拦截: 策略检查异常'
                    : event.kind === 'hook-terminated'
                      ? '终止: 策略终止转人工'
                      : '终止: 连续失败转人工'
          lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.detail, 60))}"}`)
          break
        }
      }
      if (previous !== undefined) lines.push(`${previous} --> ${id}`)
      previous = id
    }
    const terminal = this.events.some(
      event => event.type === 'intercept' && isTerminalIntercept(event.kind),
    )
    lines.push(`F["${terminal ? '任务终止转人工' : '会话结束'}"]`)
    if (previous !== undefined) lines.push(`${previous} --> F`)
    return lines.join('\n')
  }

  /**
   * Render the Markdown report embedding the flowchart.
   * @returns the report with the outcome, flowchart, and event timeline.
   */
  renderMarkdown(): string {
    const terminal = this.events.some(
      event => event.type === 'intercept' && isTerminalIntercept(event.kind),
    )
    const rows = this.events.map((event, i) => {
      const detail = event.type === 'plan'
        ? `goal=${event.goal} / stop=${event.stop} / feasible=${String(event.feasibility)} / verifier=${event.verifier}`
        : event.type === 'tool'
          ? event.name
          : event.type === 'verdict'
            ? `${event.pass ? 'PASS' : 'FAIL'}${event.count === undefined ? '' : ` (${event.count}/${this.maxRetries})`}: ${event.reason}`
            : event.type === 'learn'
              ? `analysis=${event.analysis} / knowledge=${event.knowledge} / method=${event.method} / criteria=${event.criteria}`
              : event.type === 'learn-verify'
                ? `${event.learned ? 'PASS' : 'FAIL'}${event.count === undefined ? '' : ` (${event.count}/${this.maxLearningAttempts})`}: ${event.evidence}`
                : `${event.kind}: ${event.detail}`
      return `| ${i + 1} | \`${event.type}\` | ${detail.replaceAll('|', '\\|')} |`
    }).join('\n')
    return `# LCRD 执行流程

- Agent: \`${this.agentId}\`
- 时间: ${new Date().toISOString()}
- 结果: ${terminal ? '任务终止转人工' : '会话正常结束'}

\`\`\`mermaid
${this.renderMermaid()}
\`\`\`

## 事件时间线

| # | 类型 | 详情 |
|---|---|---|
${rows}
`
  }

  /**
   * Write the per-run metadata, flowchart, report, and JSON transcript into the
   * task subfolder. Re-runnable: every call rewrites the current snapshot, so
   * per-turn dumps stay fresh until the final disposal or process-exit flush.
   * Synchronous so it also runs from a process-exit handler; never throws.
   */
  dump(): void {
    this.endedAt = new Date().toISOString()
    mkdirSync(this.taskDir(), { recursive: true })
    const base = join(this.taskDir(), 'lcrd-flow')
    writeFileSync(join(this.taskDir(), RUN_META_FILE), JSON.stringify(this.computeRunMeta(), null, 2), 'utf8')
    writeFileSync(`${base}.md`, this.renderMarkdown(), 'utf8')
    writeFileSync(`${base}.mmd`, this.renderMermaid(), 'utf8')
    writeFileSync(`${base}.json`, JSON.stringify({ ...this.computeMeta(), events: this.events }, null, 2), 'utf8')
  }
}
