/**
 * Flow-recorder bridge: the shared helpers every listener and tool uses to
 * create recorders, flush artifacts, and record tool / hook / verdict events.
 * Takes the plugin state and config once so extracted modules never import
 * the wiring root.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setApprovalPolicy, type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { FlowRecorder, type PlanContext } from './flow.ts'
import { PROTOCOL_VERSION } from './anchor.ts'
import type { LcrdState } from './state.ts'
import type { Attribution } from './attribution.ts'
import type { Verdict } from './types.ts'
import { clipSummary, summarizeArguments, summarizeResult } from './instrumentation.ts'

/** Immutable config the bridge needs to construct recorders and bound hook counts. */
export interface BridgeConfig {
  /** Flow-log directory override; absent uses the plugin-package default. */
  logDir: string | undefined
  /** Interaction mode stamped on the recorder meta. */
  interaction: 'auto' | 'auth' | 'manual'
  /** Whether learning mode is enabled (stamped on the recorder meta). */
  learningEnabled: boolean
  /** Learning entry threshold (stamped on the recorder meta). */
  learningThreshold: number
  /** Learning rounds before human review (stamped on the recorder meta). */
  maxLearningAttempts: number
  /** Consecutive failures that terminate; also the hook-interception bound. */
  maxRetries: number
  /** Validated plugin config, stamped on the recorder meta. */
  config: unknown
  /** The attribution bundle stamped on the recorder. */
  attribution: Attribution
  /** Approval policy the interaction mode maps to (`'never'` auto-rejects; `'ask'` delegates). */
  approvalPolicy: ApprovalPolicy
  /** The policy version new recorders freeze into `run.json`; null when evolution is off. */
  policyVersion: () => string | null
}

/** The shared recorder operations closed over one state + config pair. */
export interface RecorderBridge {
  /**
   * Lazily create the recorder and pin the approval policy once per agent.
   * Artifacts are refreshed by the per-turn `session/event` listener and
   * final-flushed by the global `agent/disposed` listener.
   * @param agent - the owning agent.
   * @returns the agent's flow recorder.
   */
  ensureFlow: (agent: Agent) => FlowRecorder
  /**
   * Rewrite the flow artifacts for one agent's recorder, if any; never throws.
   * @param agent - the owning agent.
   */
  flush: (agent: Agent) => void
  /**
   * Append one tool event carrying the call identity, the argument summary,
   * and — when the call produced a result — the structured result projection.
   * @param owner - the executing agent that owns the recorder.
   * @param exec - the executing tool call.
   * @param result - the canonical result; omitted by gate branches that
   *   decide before or without running a verifier.
   */
  recordTool: (
    owner: Agent,
    exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
    result?: ToolExecutionResult,
  ) => void
  /**
   * Record one policy-hook interception and count it. Hook interceptions are
   * bounded by `maxRetries` but never consume the task retry budget.
   * @param owner - the agent whose execution was intercepted.
   * @param kind - which hook interception the flow records.
   * @param detail - the hook's reason, recorded verbatim.
   * @returns the agent's interception count after this record.
   */
  recordHookInterception: (
    owner: Agent,
    kind: 'hook-denied' | 'hook-blocked' | 'hook-terminated' | 'hook-error',
    detail: string,
  ) => number
  /**
   * Record the verdict the model will see next, and count failures where the
   * engine rejected the model's own check rather than the work.
   * @param owner - the agent the verdict belongs to.
   * @param verdict - the normalized verifier outcome.
   * @param verifierKind - which verifier produced it.
   * @returns the agent's invalid-check count after this record.
   */
  noteVerdict: (owner: Agent, verdict: Verdict, verifierKind: string) => number
  /**
   * What the model had just seen when it declared a plan, for the recorded
   * decision context.
   * @param owner - the declaring agent.
   * @returns the recorded decision context.
   */
  planContext: (owner: Agent) => PlanContext
}

/**
 * Build the shared recorder operations for one plugin instance.
 * @param state - the mutable containers this instance owns.
 * @param config - immutable config for construction and hook bounds.
 * @returns the bridge closed over `state` and `config`.
 */
export function createRecorderBridge(state: LcrdState, config: BridgeConfig): RecorderBridge {
  const {
    flows,
    sessionRecorders,
    recorderSessions,
    policySet,
    allRecorders,
    hookInterceptions,
    lastVerdict,
    invalidChecks,
    failures,
    learning,
    pendingTokens,
  } = state

  function ensureFlow(agent: Agent): FlowRecorder {
    let recorder = flows.get(agent)
    if (!recorder) {
      recorder = new FlowRecorder(agent, config.maxRetries, {
        outDir: config.logDir,
        interaction: config.interaction,
        learningEnabled: config.learningEnabled,
        learningThreshold: config.learningThreshold,
        maxLearningAttempts: config.maxLearningAttempts,
        protocolVersion: PROTOCOL_VERSION,
        config: config.config,
        attribution: config.attribution,
        policyVersion: config.policyVersion(),
      })
      const pending = pendingTokens.get(agent.session)
      if (pending !== undefined) {
        recorder.recordUsage(pending)
        pendingTokens.delete(agent.session)
      }
      flows.set(agent, recorder)
      sessionRecorders.set(agent.session, recorder)
      recorderSessions.set(recorder, agent.session)
      allRecorders.add(recorder)
      try {
        /* v8 ignore start -- repeated ensureFlow with a live approval service already set the policy */
        if (!policySet.has(agent)) {
          setApprovalPolicy(agent.session, config.approvalPolicy)
          policySet.add(agent)
        }
        /* v8 ignore stop */
      } catch { /* approval service absent — leave the default policy */ }
    }
    return recorder
  }

  function flush(agent: Agent): void {
    const recorder = flows.get(agent)
    /* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
    if (recorder) {
      try { recorder.dump() } catch { /* dump must not break the session */ }
    }
    /* v8 ignore stop */
  }

  function recordTool(
    owner: Agent,
    exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
    result?: ToolExecutionResult,
  ): void {
    const summary = result === undefined ? undefined : summarizeResult(result)
    ensureFlow(owner).push({
      type: 'tool',
      name: exec.name,
      callId: String(exec.callId),
      argsSummary: summarizeArguments(exec.arguments),
      ...(summary === undefined ? {} : { resultKind: summary.kind, resultSummary: summary.summary }),
      ...(summary?.error === undefined ? {} : { errorMessage: summary.error }),
      ...(summary?.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
    })
  }

  function recordHookInterception(
    owner: Agent,
    kind: 'hook-denied' | 'hook-blocked' | 'hook-terminated' | 'hook-error',
    detail: string,
  ): number {
    const count = (hookInterceptions.get(owner) ?? 0) + 1
    hookInterceptions.set(owner, count)
    const recorder = ensureFlow(owner)
    recorder.markHookInterception()
    recorder.push({ type: 'intercept', kind, detail })
    recorder.log(`[LCRD] ${kind} (${count}/${config.maxRetries}): ${detail}`)
    flush(owner)
    return count
  }

  function noteVerdict(owner: Agent, verdict: Verdict, verifierKind: string): number {
    lastVerdict.set(owner, { pass: verdict.pass, reason: verdict.reason, verifierKind })
    if (verdict.exceptionKind === 'invalid-condition' || verdict.exceptionKind === 'eval-error') {
      invalidChecks.set(owner, (invalidChecks.get(owner) ?? 0) + 1)
    }
    return invalidChecks.get(owner) ?? 0
  }

  function planContext(owner: Agent): PlanContext {
    const previous = lastVerdict.get(owner)
    return {
      failures: failures.get(owner) ?? 0,
      phase: learning.get(owner)?.phase ?? 'normal',
      lastReason: previous === undefined ? null : clipSummary(previous.reason),
      lastPass: previous?.pass ?? null,
      lastVerifierKind: previous?.verifierKind ?? null,
      invalidChecks: invalidChecks.get(owner) ?? 0,
    }
  }

  return { ensureFlow, flush, recordTool, recordHookInterception, noteVerdict, planContext }
}
