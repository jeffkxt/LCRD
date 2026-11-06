/**
 * Session and agent lifecycle wiring: transcript tracking for exported DPO
 * prompts, per-turn artifact dumps, run export at disposal, the process-exit
 * flush, and the pre-step task-boundary reset. Takes state and the recorder
 * bridge once so this module never imports the wiring root.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { type Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { appendDatasetRows, dpoPairsForRun, ensureDatasetFiles } from './dataset.ts'
import type { FlowRecorder } from './flow.ts'
import type { LcrdState, TranscriptState } from './state.ts'

/** Clip length of the recorded anchor excerpt, in characters. */
const ANCHOR_EXCERPT_MAX = 500

/** The recorder operations the lifecycle listeners use — a structural subset of the full bridge. */
export interface LifecycleBridge {
  /** Lazily create (or fetch) the agent's flow recorder. */
  ensureFlow: (agent: Agent) => FlowRecorder
}

/** State and configuration the lifecycle listeners close over. */
export interface LifecycleDeps {
  /** Mutable containers the listeners read and reset. */
  state: Pick<LcrdState,
    | 'transcripts' | 'pendingTokens' | 'sessionRecorders' | 'recorderSessions' | 'flows' | 'exportedRecorders' | 'allRecorders'
    | 'plans' | 'failures' | 'failedPlanKeys' | 'learning' | 'lastVerdict'
    | 'invalidChecks' | 'hookInterceptions' | 'pathViolations' | 'taskDirs' | 'terminated'>
  /** Shared recorder operations (ensureFlow). */
  bridge: LifecycleBridge
  /** Dataset export mode; `'run'` appends rows and DPO pairs at disposal. */
  datasetExport: 'off' | 'run'
  /** Dataset directory for the run export. */
  datasetDir: string
  /** Called after a run's final dump, so the online monitor can fold it; never throws. */
  onRunFinished?: (agent: Agent, recorder: FlowRecorder) => void
}

/**
 * The payload of one session event: durable logs wrap it under `data`, while an
 * in-process event carries the payload directly.
 * @param event - the session event as delivered.
 * @returns the payload to read fields from.
 */
function sessionPayloadOf(event: unknown): Record<string, unknown> {
  const candidate = event as { data?: unknown }
  return (typeof candidate.data === 'object' && candidate.data !== null ? candidate.data : event) as Record<string, unknown>
}

/**
 * Append one session event to the run's transcript, so the exported DPO prompt
 * carries what the model actually saw.
 * @param state - the session's transcript state.
 * @param event - the session event as delivered.
 */
function trackTranscript(state: TranscriptState, event: unknown): void {
  const type = (event as { type?: unknown }).type
  const payload = sessionPayloadOf(event)
  if (type === 'user/message') {
    const message = payload['message'] as { content?: unknown; source?: { kind?: string } } | undefined
    state.entries.push({
      role: 'user',
      text: textOfContent(message?.content),
      ...(message?.source?.kind === undefined ? {} : { source: message.source.kind }),
    })
  } else if (type === 'assistant/message') {
    const message = payload['message'] as { content?: unknown } | undefined
    state.entries.push({ role: 'assistant', text: textOfContent(message?.content) })
  } else if (type === 'tool/call') {
    const callId = asPayloadString(payload['callId'])
    const name = asPayloadString(payload['name'])
    const args = typeof payload['arguments'] === 'string' ? payload['arguments'] : JSON.stringify(payload['arguments'])
    state.entries.push({ role: 'assistant', text: '', toolCalls: [{ name, arguments: args, callId }] })
    if (name === 'lcrd_plan') state.planIndexByCallId.set(callId, state.entries.length - 1)
  } else if (type === 'tool/result') {
    const message = payload['message'] as { content?: unknown; toolCallId?: unknown; isError?: unknown } | undefined
    state.entries.push({
      role: 'tool',
      text: textOfContent(message?.content),
      callId: asPayloadString(message?.toolCallId),
      isError: message?.isError === true,
    })
  }
}

/**
 * Read one session payload field as a string, ignoring any non-string value.
 * @param value - the payload field.
 * @returns the string value, or an empty string.
 */
function asPayloadString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Join the text blocks of one message's content.
 * @param content - the message content from the session event.
 * @returns the concatenated text blocks.
 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * Digest and excerpt of the anchoring user message text. The anchor is the
 * conversation's first user message: the digest groups runs that share one root
 * anchor, and the excerpt lets an offline judge label conformance against it.
 * @param message - the user message that opened the task.
 * @returns the 16-hex digest and the clipped message text.
 */
function anchorIdentityOf(message: Message): { digest: string; excerpt: string } {
  const text = message.content
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join('\n')
  return {
    digest: createHash('sha256').update(text).digest('hex').slice(0, 16),
    excerpt: text.length <= ANCHOR_EXCERPT_MAX ? text : `${text.slice(0, ANCHOR_EXCERPT_MAX)}…`,
  }
}

/**
 * Export one finished run into the dataset files: its rows plus the DPO pairs
 * built from the recorded declarations and the transcribed prompt. Runs once
 * per recorder — whether the run ended by disposal or by process exit — and
 * never throws into teardown.
 * @param recorder - the finished run's recorder.
 * @param session - the session the recorder belongs to, for the transcript.
 * @param deps - state, bridge, and export config.
 */
function exportRecorder(recorder: FlowRecorder, session: Session, deps: LifecycleDeps): void {
  const { datasetExport, datasetDir } = deps
  const { exportedRecorders, transcripts } = deps.state
  if (datasetExport !== 'run' || exportedRecorders.has(recorder)) return
  exportedRecorders.add(recorder)
  /* v8 ignore start -- the export only fails on filesystem errors, which must not break teardown */
  try {
    const rows = recorder.datasetRows()
    const transcript = transcripts.get(session)
    // The row carries the plan's `lcrd_plan` call id; the transcript maps that
    // call to its message, which is where the DPO prompt must stop.
    const planIndexByStep = new Map<number, number>()
    if (transcript !== undefined) {
      for (const record of rows.records) {
        if (record.type !== 'plan' || record.callId === undefined) continue
        const index = transcript.planIndexByCallId.get(record.callId)
        if (index !== undefined) planIndexByStep.set(record.step, index)
      }
    }
    const pairs = transcript === undefined || planIndexByStep.size === 0
      ? []
      : dpoPairsForRun({
        rows,
        transcript: transcript.entries,
        planIndexByStep,
        runId: rows.run.session_id,
      })
    appendDatasetRows(datasetDir, rows, pairs)
    ensureDatasetFiles(datasetDir)
    recorder.log(`[LCRD] dataset export: ${rows.records.length} rows, ${pairs.length} DPO pairs -> ${datasetDir}`)
  } catch { /* the export must never break teardown */ }
  /* v8 ignore stop */
}

/**
 * Flush every run this plugin instance still holds: rewrite the artifacts and
 * export the dataset rows. The one-shot headless profile exits the process
 * instead of disposing agents, so this is that surface's final flush.
 * @param deps - state, bridge, and export config.
 */
export function flushOnExit(deps: LifecycleDeps): void {
  const { allRecorders, recorderSessions } = deps.state
  for (const recorder of allRecorders) {
    /* v8 ignore start -- dump fails only on filesystem errors, which must not fail process exit */
    try { recorder.dump() } catch { /* exit must not fail the session */ }
    /* v8 ignore stop */
    const session = recorderSessions.get(recorder)
    if (session !== undefined) exportRecorder(recorder, session, deps)
  }
}

/** The token-usage fields one assistant message may carry. */
interface UsageFields {
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

/**
 * Narrow one usage count to a positive finite number.
 * @param value - the raw count.
 * @returns the count, or zero.
 */
function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Total tokens one usage record reports. The provider total wins when present;
 * otherwise the disjoint counts are summed.
 * @param usage - the usage record from the assistant message.
 * @returns the token total, or zero.
 */
function usageTokens(usage: UsageFields | undefined): number {
  if (usage === undefined) return 0
  const total = usageNumber(usage.totalTokens)
  if (total > 0) return total
  return usageNumber(usage.inputTokens) + usageNumber(usage.outputTokens)
    + usageNumber(usage.cacheReadTokens) + usageNumber(usage.cacheWriteTokens)
}

/**
 * Register the session/event, agent/disposed, process-exit, and agent/pre-step
 * lifecycle listeners on the plugin context.
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param deps - state, bridge, and export config the listeners close over.
 */
export function registerLifecycle(ctx: Context, deps: LifecycleDeps): void {
  const {
    transcripts, pendingTokens, sessionRecorders, flows, allRecorders,
    plans, failures, failedPlanKeys, learning, lastVerdict,
    invalidChecks, hookInterceptions, pathViolations, taskDirs, terminated,
  } = deps.state
  const { ensureFlow } = deps.bridge

  // Rewrite the flow artifacts at every protocol step (plan declaration and
  // each verified tool result) so the exports stay current mid-turn, and
  // again after every completed turn — a long-lived surface must not wait for
  // disposal to materialize them.
  ctx.on('session/event', (session, event) => {
    // The transcript feeds the exported DPO prompts; it tracks every session
    // event, not only the turn boundary the dump uses.
    const state = transcripts.get(session) ?? { entries: [], planIndexByCallId: new Map<string, number>() }
    trackTranscript(state, event)
    transcripts.set(session, state)
    if (event.type === 'assistant/message') {
      // Usage is a sibling of `message` on the event payload, not part of it.
      const tokens = usageTokens(sessionPayloadOf(event)['usage'] as UsageFields | undefined)
      if (tokens > 0) {
        const recorder = sessionRecorders.get(session)
        if (recorder) recorder.recordUsage(tokens)
        else pendingTokens.set(session, (pendingTokens.get(session) ?? 0) + tokens)
      }
    }
    if (event.type !== 'turn/end') return
    const recorder = sessionRecorders.get(session)
    if (recorder) {
      /* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
      try { recorder.dump() } catch { /* dump must not break the session */ }
      /* v8 ignore stop */
    }
  })

  // Final flush as soon as the agent is disposed, whichever session/scope it
  // lives in. The global event carries the agent in its payload, so this
  // fires reliably for every session in a long-running process (unlike the
  // per-agent scoped listener). dump() rewrites the latest snapshot, then the
  // recorder leaves the exit-flush set so a long-running process does not
  // retain disposed runs.
  ctx.on('agent/disposed', ({ agent }) => {
    const recorder = flows.get(agent)
    if (recorder) {
      /* v8 ignore start -- dump fails only on filesystem errors, which must not break disposal */
      try { recorder.dump() } catch { /* dump must not break disposal */ }
      /* v8 ignore stop */
      allRecorders.delete(recorder)
    }
    // After the final dump, so the exported rows see the same events as the artifacts.
    if (recorder) exportRecorder(recorder, agent.session, deps)
    if (recorder) deps.onRunFinished?.(agent, recorder)
  })

  // Long-running surfaces dispose the agent (agent/disposed above); a one-shot
  // run instead shuts the app down, which disposes this plugin fiber. Flush on
  // both paths: the process-exit listener covers a bare exit, and the fiber
  // teardown covers an orderly shutdown that never emits either event.
  // Registered as a fiber effect so plugin disposal removes the listener.
  ctx.effect(() => {
    const onExit = (): void => { flushOnExit(deps) }
    process.on('exit', onExit)
    return () => {
      process.off('exit', onExit)
      flushOnExit(deps)
    }
  }, 'lcrd process-exit flush')

  // A new user command is a fresh task boundary: reset the failure count, the
  // learning budget, and any termination so the model may retry the new task
  // from scratch. Plugin-injected notices carry a non-`user` producer kind and
  // never reset; only real user input does.
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const userMessage = messages.find(message => message.source.kind === 'user')
    if (userMessage !== undefined) {
      // A fresh task must re-declare its plan: a stale plan from an earlier
      // command would otherwise gate the new task's first tool result.
      const anchor = anchorIdentityOf(userMessage)
      ensureFlow(agent).markAnchorDigest(anchor.digest, anchor.excerpt)
      plans.delete(agent)
      failures.delete(agent)
      failedPlanKeys.delete(agent)
      learning.delete(agent)
      lastVerdict.delete(agent)
      invalidChecks.delete(agent)
      hookInterceptions.delete(agent)
      pathViolations.delete(agent)
      taskDirs.delete(agent)
      if (terminated.has(agent)) {
        ensureFlow(agent).log('[LCRD] user command: termination reset for a new task')
        terminated.delete(agent)
      }
    }
    return next()
  })
}
