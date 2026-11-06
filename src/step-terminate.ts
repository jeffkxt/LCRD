/**
 * Termination notices for the post-execute path: every budget that exhausts
 * (task retries, hook interceptions, invalid checks, learning rounds) builds
 * its model-facing block here so the wording stays in one place. Pure builders
 * plus the `terminated` set mutation they own — no recorder or plan state.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { blockFeedback, blockNotice } from './notice.ts'
import type { LcrdState } from './state.ts'

/** The generic post-termination block: the agent is already marked terminated.
 * @returns the block decision telling the model to stop and report failure.
 */
export function terminatedToolBlocked(): PostToolDecision {
  return blockFeedback('[LCRD] 任务已终止,等待人工介入。停止所有工具调用,向用户报告失败情况。')
}

/**
 * Mark the agent terminated and return the matching model-facing notice.
 * @param terminated - the plugin's terminated set.
 * @param agent - the agent whose budget is exhausted.
 * @param decision - the terminal notice already built by a budget-exhausted helper.
 * @returns the same block decision, after recording termination.
 */
export function terminateWith(
  terminated: LcrdState['terminated'],
  agent: Agent,
  decision: PostToolDecision,
): PostToolDecision {
  terminated.add(agent)
  return decision
}

/**
 * A run-level token budget exhausted: the gate child stops itself so one
 * runaway task cannot consume the whole gate budget.
 * @param used - tokens the run accounted for.
 * @param max - the configured per-run ceiling.
 * @returns the terminal notice.
 */
export function runBudgetExhausted(used: number, max: number): PostToolDecision {
  const message = `[LCRD] 本次运行 token 预算已用尽(${used}/${max}),任务终止。停止所有工具调用,向用户报告已完成与未完成的部分。`
  return blockNotice(message, message, 'lcrd run budget exhausted')
}

/**
 * A policy-hook `checkResult` that threw: count the interception, terminate
 * when the bound is reached, otherwise the caller rethrows the original error.
 * @param count - the agent's hook-interception count after this record.
 * @param maxRetries - the bound that terminates the task.
 * @param reason - the hook error message.
 * @returns the terminal notice when the bound is reached; otherwise undefined.
 */
export function hookErrorExhausted(count: number, maxRetries: number, reason: string): PostToolDecision | undefined {
  if (count < maxRetries) return undefined
  return blockNotice(
    `[LCRD] 策略检查连续异常 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`,
    `[LCRD] 策略检查连续异常 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`,
    'lcrd hook error exhausted',
  )
}

/**
 * A policy-hook block that reached the interception bound: terminal notice.
 * @param count - the agent's hook-interception count after this record.
 * @param maxRetries - the bound that terminates the task.
 * @param reason - the hook's rejection reason.
 * @returns the terminal notice when the bound is reached; otherwise undefined.
 */
export function hookBlockedExhausted(count: number, maxRetries: number, reason: string): PostToolDecision | undefined {
  if (count < maxRetries) return undefined
  return blockNotice(
    `[LCRD] 工具结果连续被外部策略拒绝 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`,
    `[LCRD] 工具结果连续被外部策略拒绝 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`,
    'lcrd hook blocked exhausted',
  )
}

/**
 * Invalid-check budget exhausted: consecutive engine rejections of the model's
 * own assertion terminate the task.
 * @param maxRetries - the invalid-check bound.
 * @param reason - the verifier's rejection reason.
 * @returns the terminal notice.
 */
export function invalidChecksExhausted(maxRetries: number, reason: string): PostToolDecision {
  return blockNotice(
    `[LCRD] 连续 ${maxRetries} 次断言被引擎判为无效,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    `[LCRD] 连续 ${maxRetries} 次断言被引擎判为无效,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    'lcrd invalid checks exhausted',
  )
}

/**
 * Learning-round budget exhausted after a post-learning re-solve failure.
 * @param maxLearningAttempts - the learning-round bound.
 * @param reason - the verifier's failure reason.
 * @returns the terminal notice.
 */
export function learningExhausted(maxLearningAttempts: number, reason: string): PostToolDecision {
  return blockNotice(
    `[LCRD] 学习后重解仍失败,学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    `[LCRD] 学习后重解仍失败,学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    'lcrd learning exhausted',
  )
}

/**
 * Task retry budget exhausted by consecutive verifier failures.
 * @param maxRetries - the task retry bound.
 * @param reason - the verifier's failure reason.
 * @returns the terminal notice.
 */
export function maxRetriesTerminated(maxRetries: number, reason: string): PostToolDecision {
  return blockNotice(
    `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
    'lcrd terminated',
  )
}
