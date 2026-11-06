/**
 * Learning-phase gates and the post-verify learning transition for the
 * `tools/post-execute` path: plan/tool interception while a learning round is
 * open, entry when consecutive failures reach the threshold, and round-failure
 * handling that either returns to learning or terminates. State mutations for
 * the learning budget live here; the surrounding verify orchestration stays in
 * `step-verify.ts`.
 */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { FlowRecorder } from './flow.ts'
import { blockNotice } from './notice.ts'
import type { LearnEvidence, LcrdState } from './state.ts'
import type { Verdict } from './types.ts'
import { learningExhausted } from './step-terminate.ts'

/** The recorder operations the learning gates use — a structural subset of the full bridge. */
export interface LearnGateBridge {
  /** Lazily create (or fetch) the agent's flow recorder. */
  ensureFlow: (agent: Agent) => FlowRecorder
  /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
  flush: (agent: Agent) => void
  /** Record one tool event on the flow (gates decide before the verifier runs). */
  recordTool: (
    owner: Agent,
    exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
  ) => void
}

/** State and configuration the learning gates close over. */
export interface LearnGateDeps {
  /** Mutable containers the gates mutate (learning phase / attempts, termination). */
  state: Pick<LcrdState, 'learning' | 'terminated'>
  /** Shared recorder operations (ensureFlow / flush / recordTool). */
  bridge: LearnGateBridge
  /** Whether learning mode is enabled (threshold entry is a no-op when off). */
  learningEnabled: boolean
  /** Consecutive verifier failures that enter learning mode. */
  learningThreshold: number
  /** Learning rounds before human review. */
  maxLearningAttempts: number
  /** The configured knowledge-acquisition tool names (allowed during the learn phase). */
  learningToolSet: Set<string>
}

/**
 * The plan-gate notice for a known learn-phase `lcrd_plan` call (the caller
 * has already confirmed the agent's learning state).
 * @returns the block decision.
 */
export function learnPhasePlanBlocked(): PostToolDecision {
  return blockNotice(
    '[LCRD] 学习阶段禁止声明任务计划。请先调用 lcrd_learn 声明学习轮次,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后才能重新声明 lcrd_plan 重解任务。',
    '[LCRD] 当前处于学习阶段:先完成 lcrd_learn → 学习工具 → lcrd_learn_verify,再重解任务。',
    'lcrd learn phase plan blocked',
  )
}

/**
 * In the learn phase, allow a configured learning tool (marking evidence) or
 * block any other tool with the allowlist notice. Outside the learn phase this
 * is a no-op.
 * @param agent - the owning agent.
 * @param exec - the executed tool call.
 * @param deps - state, bridge, and config the gate closes over.
 * @returns `'pass'` for a learning tool, a block decision for a gated tool, or
 *   undefined when no learning round is open.
 */
/** Longest excerpt kept from one learning tool's result, in characters. */
const EVIDENCE_EXCERPT_MAX = 160

/** Evidence entries one learning round keeps; later calls still pass, they stop being citable. */
const EVIDENCE_MAX = 20

/**
 * Build the evidence entry one learning tool call contributes: what was read (a
 * path, a URL, or the call itself), a digest of the acquired text, and a clipped
 * excerpt, so a self-evaluation cites a fact instead of asserting one.
 * @param exec - the learning tool call.
 * @param result - its executed result.
 * @param index - how many entries the round already holds, so ids stay short and sequential.
 * @returns the evidence entry; null when the call produced no text to cite.
 */
export function learnEvidence(
  exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
  result: ToolExecutionResult,
  index: number,
): LearnEvidence | null {
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  if (text.trim().length === 0) return null
  const args = exec.arguments as Record<string, unknown> | null | undefined
  const path = typeof args?.path === 'string' ? args.path : undefined
  const url = typeof args?.url === 'string' ? args.url : undefined
  return {
    id: `e${String(index + 1)}`,
    kind: path === undefined ? url === undefined ? 'call' : 'url' : 'path',
    label: path ?? url ?? `${exec.name}#${String(exec.callId)}`,
    digest: createHash('sha256').update(text).digest('hex').slice(0, 12),
    excerpt: text.length <= EVIDENCE_EXCERPT_MAX ? text : `${text.slice(0, EVIDENCE_EXCERPT_MAX)}…`,
  }
}

/**
 * The evidence entry one self-evaluation cites, if any. A citation names either
 * the entry id or the source it recorded, so the model rewrites nothing.
 * @param text - the self-evaluation's evidence text.
 * @param entries - the evidence recorded for the open round.
 * @returns the cited entry, or undefined when the text cites no recorded knowledge.
 */
export function citedEvidence(text: string, entries: readonly LearnEvidence[]): LearnEvidence | undefined {
  return entries.find(entry => text.includes(entry.id) || text.includes(entry.label))
}

/**
 * In the learn phase, allow a configured learning tool (recording the knowledge
 * it produced) or block any other tool with the allowlist notice. Outside the
 * learn phase this is a no-op.
 * @param agent - the owning agent.
 * @param exec - the executed tool call.
 * @param result - the call's result, whose text becomes citable evidence.
 * @param deps - state, bridge, and config the gate closes over.
 * @returns `'pass'` for a learning tool, a block decision for a gated tool, or
 *   undefined when no learning round is open.
 */
export function gateLearnPhaseTool(
  agent: Agent,
  exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
  result: ToolExecutionResult,
  deps: LearnGateDeps,
): PostToolDecision | 'pass' | undefined {
  const learningState = deps.state.learning.get(agent)
  if (learningState === undefined || learningState.phase !== 'learn') return undefined
  const { ensureFlow, flush, recordTool } = deps.bridge
  if (deps.learningToolSet.has(exec.name)) {
    const entry = learningState.evidence.length < EVIDENCE_MAX
      ? learnEvidence(exec, result, learningState.evidence.length)
      : null
    if (entry !== null) learningState.evidence.push(entry)
    recordTool(agent, exec)
    ensureFlow(agent).log(`[LCRD] learn tool: ${exec.name} passed${entry === null ? '' : ` evidence=${entry.id} ${entry.label} digest=${entry.digest}`}`)
    flush(agent)
    return 'pass'
  }
  ensureFlow(agent).log(`[LCRD] learn phase: tool=${exec.name} blocked (not a learning tool)`)
  recordTool(agent, exec)
  ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: `${exec.name} during learn phase` })
  flush(agent)
  return blockNotice(
    `[LCRD] 学习阶段仅允许学习工具(${[...deps.learningToolSet].join(', ')})。请使用它们获取知识,然后调用 lcrd_learn_verify 自评;禁止执行任务工具。`,
    `[LCRD] 工具 ${exec.name} 被拦截:学习阶段仅允许学习工具。先完成学习与自评,再重解任务。`,
    'lcrd learn phase tool blocked',
  )
}

/**
 * After a passing verification, complete any open learning round: record the
 * success and clear the learning budget.
 * @param agent - the owning agent.
 * @param verdict - the passing verifier outcome.
 * @param deps - state and bridge the transition uses.
 */
export function onVerifyPassLearning(agent: Agent, verdict: Verdict, deps: LearnGateDeps): void {
  const passedState = deps.state.learning.get(agent)
  if (!passedState) return
  const { ensureFlow } = deps.bridge
  ensureFlow(agent).push({ type: 'learn-verify', learned: true, evidence: `重解通过: ${verdict.reason}`, count: passedState.attempts })
  ensureFlow(agent).markLearningSuccess()
  ensureFlow(agent).log(`[LCRD] learning success: re-solve PASS after ${passedState.attempts} learning attempt(s), learning budget reset`)
  deps.state.learning.delete(agent)
}

/**
 * After a failing verification, enter learning mode when the threshold is
 * reached, or consume one round of an open learning budget. Plain-rollback
 * failures (learning off, or below the threshold with no open round) return
 * undefined so the caller applies the task-retry path.
 * @param agent - the owning agent.
 * @param count - the agent's consecutive verifier failures after this record.
 * @param verdict - the failing verifier outcome.
 * @param deps - state, bridge, and config the transition uses.
 * @returns the block decision for a learning transition; otherwise undefined.
 */
export function onVerifyFailLearning(
  agent: Agent,
  count: number,
  verdict: Verdict,
  deps: LearnGateDeps,
): PostToolDecision | undefined {
  const { learning, terminated } = deps.state
  const { ensureFlow, flush } = deps.bridge
  if (deps.learningEnabled && !learning.has(agent) && count >= deps.learningThreshold) {
    learning.set(agent, { attempts: 0, phase: 'learn', evidence: [] })
    const notice = `[LCRD] 连续 ${count} 次校验失败,达到学习阈值(${deps.learningThreshold}),进入学习模式(最多 ${deps.maxLearningAttempts} 轮)。停止直接重试:先调用 lcrd_learn 分析问题与所需知识,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后重新声明 lcrd_plan 重解任务。`
    flush(agent)
    return blockNotice(notice, notice, 'lcrd learning mode entered')
  }
  const activeLearning = learning.get(agent)
  if (!activeLearning) return undefined
  activeLearning.attempts += 1
  ensureFlow(agent).push({ type: 'learn-verify', learned: false, evidence: verdict.reason, count: activeLearning.attempts })
  ensureFlow(agent).log(`[LCRD] learning round FAIL (${activeLearning.attempts}/${deps.maxLearningAttempts}): ${verdict.reason}`)
  if (activeLearning.attempts >= deps.maxLearningAttempts) {
    terminated.add(agent)
    return learningExhausted(deps.maxLearningAttempts, verdict.reason)
  }
  activeLearning.phase = 'learn'
  activeLearning.evidence = []
  return blockNotice(
    `[LCRD] 学习后重解仍失败(第 ${activeLearning.attempts}/${deps.maxLearningAttempts} 轮): ${verdict.reason}。回到学习模式:调用 lcrd_learn 结合本次失败原因重新分析,继续学习并重新自评。`,
    `[LCRD] 重解失败原因(供新一轮学习分析): ${verdict.reason}`,
    'lcrd learning round failed',
  )
}
