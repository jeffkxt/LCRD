/**
 * The rollback symbol: `tools/post-execute` verifies each governed tool result
 * against the declared plan, runs the policy hook, and routes failures through
 * the learning transition or the task-retry / termination notices. Takes state,
 * the recorder bridge, and config once so this module never imports the wiring
 * root.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { PROTOCOL_TEXT } from './anchor.ts'
import { acceptNotice, blockNotice } from './notice.ts'
import { planFingerprint } from './flow.ts'
import type { LcrdHooks, ResultCheckDecision } from './hooks.ts'
import type { LcrdState } from './state.ts'
import { runVerifier } from './verifiers.ts'
import type { RecorderBridge } from './recorder-bridge.ts'
import {
  hookBlockedExhausted,
  hookErrorExhausted,
  invalidChecksExhausted,
  maxRetriesTerminated,
  runBudgetExhausted,
  terminatedToolBlocked,
  terminateWith,
} from './step-terminate.ts'
import {
  gateLearnPhaseTool,
  learnPhasePlanBlocked,
  onVerifyFailLearning,
  onVerifyPassLearning,
  type LearnGateDeps,
} from './step-learn.ts'

/**
 * The recorder operations the verify path uses — a structural subset of the
 * full bridge, typed as a Pick so method signatures stay single-sourced.
 */
export type StepVerifyBridge = Pick<
  RecorderBridge,
  'ensureFlow' | 'flush' | 'recordTool' | 'recordHookInterception' | 'noteVerdict'
>

/** State and configuration the verify path closes over. */
export interface StepVerifyDeps {
  /** Mutable containers the path mutates (plans, budgets, learning, termination). */
  state: Pick<LcrdState,
    | 'guardDenied' | 'terminalExecutions' | 'terminated' | 'learning'
    | 'plans' | 'failures' | 'failedPlanKeys' | 'invalidChecks'>
  /** Shared recorder operations (ensureFlow / flush / recordTool / hook / verdict). */
  bridge: StepVerifyBridge
  /** Plugin context for the LLM verifier session. */
  ctx: Context
  /** Interaction mode (`'auto'` auto-answers `ask_user_question`). */
  interaction: 'auto' | 'auth' | 'manual'
  /** Whether learning mode is enabled. */
  learningEnabled: boolean
  /** Consecutive verifier failures that enter learning mode. */
  learningThreshold: number
  /** Learning rounds before human review. */
  maxLearningAttempts: number
  /** Consecutive failures / hook interceptions that terminate the task. */
  maxRetries: number
  /** Command used to launch Python verifier scripts. */
  pythonCommand: string
  /** Kill a Python verifier script after this many milliseconds. */
  pythonTimeoutMs: number
  /** Optional dedicated model id for the LLM verifier. */
  verifierModel: string | undefined
  /** Whether a failed engine-rejected check consumes the task retry budget. */
  failedCheckConsumesRetry: boolean
  /** Per-run token ceiling; a gate child terminates itself once this is reached. */
  runMaxTokens: number | undefined
  /** The configured knowledge-acquisition tool names (allowed during the learn phase). */
  learningToolSet: Set<string>
  /** The policy hook, or none (plain protocol). */
  hooks: LcrdHooks | undefined
}

/**
 * Register the `tools/post-execute` verify listener.
 * @param ctx - the plugin context whose event bus receives the listener.
 * @param deps - state, bridge, and config the path closes over.
 */
export function registerStepVerify(ctx: Context, deps: StepVerifyDeps): void {
  const {
    state, bridge, interaction, learningEnabled, learningThreshold,
    maxLearningAttempts, maxRetries, pythonCommand, pythonTimeoutMs,
    verifierModel, failedCheckConsumesRetry, learningToolSet, hooks, runMaxTokens,
  } = deps
  const { guardDenied, terminalExecutions, terminated, learning, plans, failures, failedPlanKeys } = state
  const { ensureFlow, flush, recordTool, recordHookInterception, noteVerdict } = bridge
  const learnGate: LearnGateDeps = {
    state: { learning, terminated },
    bridge: { ensureFlow, flush, recordTool },
    learningEnabled,
    learningThreshold,
    maxLearningAttempts,
    learningToolSet,
  }

  // The rollback symbol: after every tool execution, verify the result against
  // the declared plan and reject it with corrective feedback on failure. When
  // learning is enabled, consecutive failures at or above the threshold enter
  // learning mode instead of plain rollback, and a failed post-learning
  // re-solve consumes one learning attempt.
  ctx.on('tools/post-execute', async (exec, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    const agent = exec.agent

    // A result already denied by the file-flow guard is final: accept it as-is
    // so the denial reason reaches the model, and no verifier retry is
    // consumed (the denial already counted against the path-violation cap).
    if (guardDenied.has(exec)) return next()

    // A policy hook terminated the task from inside this call's own body, so its
    // specific terminal message is the result: do not replace it with the guard.
    if (terminalExecutions.has(exec)) return next()

    if (terminated.has(agent)) {
      ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`)
      recordTool(agent, exec)
      ensureFlow(agent).push({ type: 'intercept', kind: 'terminated', detail: '任务已终止,后续工具调用被拦截' })
      flush(agent)
      return terminatedToolBlocked()
    }

    const learningState = learning.get(agent)

    // A gate child enforces its own run budget: once the session's accounted
    // tokens reach the ceiling, the task terminates instead of spending the
    // whole gate budget on one runaway run.
    if (runMaxTokens !== undefined) {
      const used = ensureFlow(agent).tokenTotal()
      if (used >= runMaxTokens) {
        ensureFlow(agent).push({ type: 'intercept', kind: 'terminated', detail: `run token budget exhausted (${used}/${runMaxTokens})` })
        flush(agent)
        return terminateWith(terminated, agent, runBudgetExhausted(used, runMaxTokens))
      }
    }

    // Protocol tools are managed by their own execute handlers; they never
    // run the verifier. In the learn phase, declaring a task plan is blocked
    // until a learning round is declared and self-evaluated.
    if (exec.name === 'lcrd_plan' || exec.name === 'lcrd_learn' || exec.name === 'lcrd_learn_verify') {
      if (learningState && learningState.phase === 'learn' && exec.name === 'lcrd_plan') {
        ensureFlow(agent).log('[LCRD] learn phase: tool=lcrd_plan blocked (must declare learning first)')
        recordTool(agent, exec)
        ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: 'lcrd_plan during learn phase' })
        flush(agent)
        return learnPhasePlanBlocked()
      }
      return next()
    }

    // In unattended ('auto') mode no human is available: auto-answer an agent
    // that tries to ask the user, instead of blocking on a plan or waiting.
    // Checked before the learning gate so a learn-phase question keeps the
    // existing auto-answer semantics instead of a new interception.
    if (interaction === 'auto' && exec.name === 'ask_user_question') {
      const recorder = ensureFlow(agent)
      recorder.markAskIntercepted()
      recorder.log('[LCRD] auto-answer: tool=ask_user_question blocked (unattended)')
      recordTool(agent, exec)
      recorder.push({ type: 'intercept', kind: 'missing-plan', detail: 'ask_user_question (auto mode)' })
      flush(agent)
      return blockNotice(
        '[LCRD] 自动模式无法人工应答。请基于已有信息自主判断并继续,不要等待用户输入;若必须确认,请按 stop_condition 校验现有结果。',
        '[LCRD] 自动模式: 无法人工应答 ask_user_question,请自主决策继续。',
        'lcrd auto-answer',
      )
    }

    // Learn phase: knowledge-acquisition tools pass without a plan or verifier;
    // every other tool is blocked until the round is self-evaluated.
    const learnGateDecision = gateLearnPhaseTool(agent, exec, result, learnGate)
    if (learnGateDecision === 'pass') return next()
    if (learnGateDecision !== undefined) return learnGateDecision

    const plan = plans.get(agent)
    if (!plan) {
      ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`)
      recordTool(agent, exec)
      ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: exec.name })
      flush(agent)
      return blockNotice(
        '[LCRD] 未声明子任务计划: 执行任何工具前必须先调用 lcrd_plan 工具声明 goal、stop_condition、feasibility 与 verifier。',
        '[LCRD] 工具结果被拒绝,原因: 缺少子任务计划声明。请先调用 lcrd_plan 再重试工具。',
        'lcrd missing plan',
      )
    }

    if (!plan.feasibility) {
      ensureFlow(agent).log(`[LCRD] infeasible: tool=${exec.name} blocked`)
      recordTool(agent, exec)
      ensureFlow(agent).push({ type: 'intercept', kind: 'infeasible', detail: exec.name })
      flush(agent)
      return blockNotice(
        `[LCRD] 计划声明 feasibility=false,子任务被外部引擎拒绝: ${plan.goal}`,
        '[LCRD] 请重新调用 lcrd_plan 声明可行的子任务,或直接向用户说明无法继续。',
        'lcrd infeasible plan',
      )
    }

    const verdict = await runVerifier(
      deps.ctx, agent, plan.verifier, result,
      { pythonCommand, pythonTimeoutMs, verifierModel, anchorText: PROTOCOL_TEXT },
      plan,
      exec.signal,
    )
    recordTool(agent, exec, result)

    // The policy hook inspects the verified result. It may reject the result
    // with corrective feedback or terminate the task; neither consumes the task
    // retry budget, and both are bounded by `maxRetries` interceptions.
    if (hooks?.checkResult) {
      let decision: ResultCheckDecision
      try {
        decision = await hooks.checkResult({
          agent,
          plan,
          tool: exec.name,
          callId: String(exec.callId),
          result,
          verdict,
          signal: exec.signal,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const count = recordHookInterception(agent, 'hook-error', `checkResult: ${reason}`)
        const exhausted = hookErrorExhausted(count, maxRetries, reason)
        if (exhausted) return terminateWith(terminated, agent, exhausted)
        throw error
      }
      if (decision.kind === 'block') {
        const count = recordHookInterception(agent, 'hook-blocked', decision.reason)
        const exhausted = hookBlockedExhausted(count, maxRetries, decision.reason)
        if (exhausted) return terminateWith(terminated, agent, exhausted)
        return blockNotice(
          `[LCRD] 工具结果被外部策略拒绝(第 ${count}/${maxRetries} 次,不消耗任务重试预算): ${decision.reason}。请调整方法或参数后重新声明 lcrd_plan。`,
          `[LCRD] 外部策略拒绝工具结果: ${decision.reason}`,
          'lcrd hook result blocked',
        )
      }
      if (decision.kind === 'terminate') {
        recordHookInterception(agent, 'hook-terminated', decision.reason)
        terminated.add(agent)
        return blockNotice(
          `[LCRD] 任务被外部策略终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`,
          `[LCRD] 任务被外部策略终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`,
          'lcrd hook terminated',
        )
      }
    }

    if (verdict.pass) {
      noteVerdict(agent, verdict, plan.verifier.kind)
      ensureFlow(agent).push({
        type: 'verdict',
        pass: true,
        reason: verdict.reason,
        verifierKind: plan.verifier.kind,
        callId: String(exec.callId),
        tool: exec.name,
        ...(verdict.predictionMissed === undefined ? {} : { predictionMissed: verdict.predictionMissed }),
      })
      failures.delete(agent)
      // The pass clears the repeated-failed-declaration fingerprint: the next
      // declaration may legitimately match an older failed method.
      failedPlanKeys.delete(agent)
      // A post-learning re-solve that passes completes the task and resets the
      // learning budget; the plain path stays untouched.
      onVerifyPassLearning(agent, verdict, learnGate)
      if (verdict.predictionMissed === true) {
        // The result stays accepted: a probe grants no pass, so a miss says
        // nothing about the work. The notice keeps the observation visible
        // without touching the retry budget.
        ensureFlow(agent).log(`[LCRD] prediction missed (accepted): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`)
        flush(agent)
        return acceptNotice(
          `[LCRD] 预测未命中,结果已接受(probe 模式不消耗重试预算): ${verdict.reason}。本步没有外部校验绑定;若该步骤的结果必须被外部校验,请用 oracle 模式重新声明可验证的停止条件。`,
          'lcrd prediction missed',
        )
      }
      ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`)
      flush(agent)
      return next()
    }

    // Any failed verification pins the governing plan's fingerprint, so an
    // identical redeclaration is rejected at the next lcrd_plan before any
    // early return (check-only, learning entry, termination) can skip it.
    failedPlanKeys.set(agent, planFingerprint({
      goal: plan.goal,
      stop: plan.stop_condition,
      verifier: plan.verifier.kind,
      verifierSpec: plan.verifier,
    }))

    const failedCheck = verdict.exceptionKind === 'invalid-condition' || verdict.exceptionKind === 'eval-error'
    // A failed check is the engine rejecting the model's own verification, not a
    // failed task step. Which budget it consumes is a deployment choice: the
    // default keeps the historical behaviour (the task budget), and switching it
    // off bounds the invalid checks by their own count instead.
    const checkOnly = failedCheck && !failedCheckConsumesRetry
    const count = checkOnly ? (failures.get(agent) ?? 0) : (failures.get(agent) ?? 0) + 1
    if (!checkOnly) failures.set(agent, count)
    const invalidCount = noteVerdict(agent, verdict, plan.verifier.kind)
    ensureFlow(agent).push({
      type: 'verdict',
      pass: false,
      reason: verdict.reason,
      count,
      verifierKind: plan.verifier.kind,
      callId: String(exec.callId),
      tool: exec.name,
      ...(verdict.exceptionKind === undefined ? {} : { exceptionKind: verdict.exceptionKind }),
    })
    if (verdict.exception === true) ensureFlow(agent).markVerifierException()
    ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`)

    if (checkOnly) {
      if (invalidCount >= maxRetries) {
        return terminateWith(terminated, agent, invalidChecksExhausted(maxRetries, verdict.reason))
      }
      return blockNotice(
        `[LCRD] 断言被引擎判为无效(第 ${invalidCount}/${maxRetries} 次,不消耗任务重试预算): ${verdict.reason}。请修正检查本身(类型引用、区分度),再声明计划重试。`,
        `[LCRD] 无效断言: ${verdict.reason}`,
        'lcrd invalid check',
      )
    }

    // Learning trigger / open-round failure take the learning path when they
    // apply; plain-rollback failures fall through to the task-retry notices.
    const learningDecision = onVerifyFailLearning(agent, count, verdict, learnGate)
    if (learningDecision) return learningDecision

    if (count >= maxRetries) {
      return terminateWith(terminated, agent, maxRetriesTerminated(maxRetries, verdict.reason))
    }

    return blockNotice(
      `[LCRD] 校验失败(第 ${count}/${maxRetries} 次): ${verdict.reason}。工具结果已被外部引擎拒绝。请重新设计一套不同的子任务方法(更换策略或参数)并再次声明 lcrd_plan;禁止原样重试。`,
      `[LCRD] 上次校验失败: ${verdict.reason}`,
      'lcrd verify fail',
    )
  })
}
