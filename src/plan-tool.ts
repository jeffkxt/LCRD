/**
 * The `lcrd_plan` stop-symbol tool: parse and gate the declaration, run the
 * policy hook, reject identical redeclarations of a failed plan, store the
 * effective plan, and record it on the flow. Takes state and the recorder
 * bridge once so this module never imports the wiring root.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { planFingerprint, type PlanContext } from './flow.ts'
import { isStepPlan, type LcrdHooks, type PlanCheckDecision } from './hooks.ts'
import { parseBoolean, parseString, parseVerifier, validateDeclaration, type DeclarationPolicy } from './declaration.ts'
import type { FlowRecorder } from './flow.ts'
import type { LcrdState } from './state.ts'
import type { StepPlan } from './types.ts'

/**
 * The recorder operations the plan tool uses — a structural subset of the
 * full bridge, so callers may pass the whole bridge or a narrowed object.
 */
export interface PlanToolBridge {
  /** Lazily create (or fetch) the agent's flow recorder. */
  ensureFlow: (agent: Agent) => FlowRecorder
  /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
  flush: (agent: Agent) => void
  /** Record one policy-hook interception and return the agent's count after this record. */
  recordHookInterception: (
    owner: Agent,
    kind: 'hook-denied' | 'hook-blocked' | 'hook-terminated' | 'hook-error',
    detail: string,
  ) => number
  /** The decision context to stamp on the recorded plan. */
  planContext: (owner: Agent) => PlanContext
}

/** State and configuration the plan tool closes over; a subset of the plugin instance. */
export interface PlanToolDeps {
  /** Mutable containers the declaration mutates (plans, failures, termination, task dirs). */
  state: Pick<LcrdState, 'plans' | 'failures' | 'failedPlanKeys' | 'terminated' | 'terminalExecutions' | 'taskDirs'>
  /** Shared recorder operations (ensureFlow / flush / recordHookInterception / planContext). */
  bridge: PlanToolBridge
  /** The declaration-time gates (presence-only rejection and hold-rate ceiling). */
  declarationPolicy: DeclarationPolicy
  /** The policy hook, or none (plain protocol). */
  hooks: LcrdHooks | undefined
  /** Consecutive failures / hook interceptions that terminate the task. */
  maxRetries: number
  /** Whether file-backed task flow is on (auto-creates the task dir on first plan). */
  fileFlowEnabled: boolean
  /** Create and pin the agent's task-flow directory (plugin-owned, bypasses tool sandboxes). */
  ensureTaskDir: (agent: Agent) => Promise<string>
}

/**
 * Register the `lcrd_plan` tool on the plugin's tool registry.
 * @param ctx - the plugin context whose tool registry receives the tool.
 * @param deps - state, bridge, and config the tool closes over.
 */
export function registerPlanTool(ctx: Context, deps: PlanToolDeps): void {
  const { state, bridge, declarationPolicy, hooks, maxRetries, fileFlowEnabled, ensureTaskDir } = deps
  const { plans, failures, failedPlanKeys, terminated, terminalExecutions, taskDirs } = state
  const { ensureFlow, flush, recordHookInterception, planContext } = bridge

  // The stop symbol's declaration point: the model states its subtask goal,
  // its local stop condition, and the verifier before executing any tool.
  ctx.tools.register(defineTool({
    name: 'lcrd_plan',
    description: 'Declare the next subtask plan before executing tools: the subtask goal, a stop condition an external verifier can check, a feasibility flag, and the verifier to run on the next tool result (assert / python / llm). The external engine verifies every tool result against the declared stop condition; a failed verification rejects the result. The model supplies only data, never the pass criterion: assert/python take expressions over `result` (the structured tool value), `content` (the rendered text), or `isError` that must reference at least one and must not be true for every probe input; the llm verifier uses a plugin-fixed prompt checked against the root anchor. A failed tool result always fails assert/python outright.',
    parameters: {
      goal: { type: 'string', required: true, description: '本步子任务目标,服务于主任务根锚' },
      stop_condition: { type: 'string', required: true, description: '本步局部停止条件,必须可被外部校验器客观检查' },
      feasibility: { type: 'boolean', required: true, description: '本步子任务是否可行的自检标记' },
      verifier: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: '校验方式,三选一: assert(JS 表达式列表)/ python(Python 表达式列表)/ llm(插件固定提示词的独立会话)',
        properties: {
          kind: { type: 'string', required: true, enum: ['assert', 'python', 'llm'] },
          mode: {
            type: 'string',
            enum: ['oracle', 'probe'],
            description: 'kind=assert 可选: oracle(默认,断言绑定本步,不成立即拒绝结果并按退回符回滚)或 probe(断言是对结果的预测,未命中只记录并附提示,不拒绝结果、不消耗重试预算;用于结果无法预先知道的探索步骤)',
          },
          conditions: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind=assert: 每条断言是一个受限表达式,可作用于 result(结构化值)/content(渲染文本)/isError,至少引用其一;只支持比较、逻辑、typeof/in、属性读取与只读方法(includes/startsWith/endsWith/get/some/every 等),不支持 this、函数构造、正则字面量、动态 import 与循环;对所有探测输入恒真判"缺少区分度"失败;工具执行失败直接判 FAIL;全部为真才通过;列表不得为空',
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind=python: 每条检查是 Python 表达式,可作用于 result/content/isError(环境注入 json 模块),至少引用其一;规则同 assert;全部为真才通过;列表不得为空',
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('lcrd_plan requires an agent-scoped execution')
      const declared: StepPlan = {
        goal: parseString(args.goal, 'goal'),
        stop_condition: parseString(args.stop_condition, 'stop_condition'),
        feasibility: parseBoolean(args.feasibility, 'feasibility'),
        verifier: parseVerifier(args.verifier),
      }
      const callId = String(exec.callId)
      // Declaration-time gates first: the model's own declaration must clear
      // the discrimination and form checks before any hook sees it.
      try {
        validateDeclaration(declared, declarationPolicy)
      } catch (error) {
        plans.delete(agent)
        /* v8 ignore next -- validateDeclaration throws only Error */
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`lcrd_plan: ${message}`)
      }
      // The policy hook runs on the completed declaration. A replacement plan is
      // silent to the model — the result text below still echoes the declaration —
      // while LCRD stores and verifies with the effective plan.
      let plan = declared
      if (hooks?.checkPlan) {
        let decision: PlanCheckDecision
        try {
          decision = await hooks.checkPlan({ agent, plan: declared, callId, signal: exec.signal })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const count = recordHookInterception(agent, 'hook-error', `checkPlan: ${reason}`)
          if (count >= maxRetries) {
            terminated.add(agent)
            terminalExecutions.add(exec)
            throw new Error(`[LCRD] 策略检查连续异常 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`)
          }
          throw error
        }
        if (decision.kind === 'deny') {
          const count = recordHookInterception(agent, 'hook-denied', decision.reason)
          // The denial must invalidate any earlier plan: otherwise the previous
          // declaration would keep governing the next tool result.
          plans.delete(agent)
          if (count >= maxRetries) {
            terminated.add(agent)
            terminalExecutions.add(exec)
            throw new Error(`[LCRD] 子任务声明连续被外部策略拒绝 ${count} 次,任务已终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`)
          }
          throw new Error(`[LCRD] 子任务声明被外部策略拒绝: ${decision.reason}。请调整目标或方法后重新调用 lcrd_plan。`)
        }
        if (decision.kind === 'modify') {
          if (!isStepPlan(decision.plan)) {
            plans.delete(agent)
            throw new Error('hooks module checkPlan returned a malformed plan: goal, stop_condition, feasibility, and a verifier with a non-empty expression list are required')
          }
          // A hook replacement crosses the same declaration gates: policy may
          // rewrite the plan, but it cannot install a check the engine rejects.
          try {
            validateDeclaration(decision.plan, declarationPolicy)
          } catch (error) {
            plans.delete(agent)
            /* v8 ignore next -- validateDeclaration throws only Error */
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`hooks module checkPlan returned a declaration the engine rejects: ${message}`)
          }
          plan = decision.plan
        }
      }
      // L4: reject an identical redeclaration of the plan whose last
      // verification failed — the rollback forbids retrying the same method
      // unchanged. Runs after the hook so policy sees the declaration first.
      const fingerprint = planFingerprint({
        goal: plan.goal,
        stop: plan.stop_condition,
        verifier: plan.verifier.kind,
        verifierSpec: plan.verifier,
      })
      if (failedPlanKeys.get(agent) === fingerprint) {
        plans.delete(agent)
        const count = (failures.get(agent) ?? 0) + 1
        failures.set(agent, count)
        const recorder = ensureFlow(agent)
        if (count >= maxRetries) {
          terminated.add(agent)
          terminalExecutions.add(exec)
          recorder.push({ type: 'intercept', kind: 'terminated', detail: '原样重复上次失败的子任务声明' })
          recorder.log(`[LCRD] repeat-failed declaration terminated (${count}/${maxRetries}): ${plan.goal}`)
          flush(agent)
          throw new Error(`[LCRD] 连续 ${count} 次原样重复上次失败的子任务声明,任务已终止转人工: ${plan.goal}。停止所有工具调用,向用户报告失败原因,等待人工指令。`)
        }
        recorder.log(`[LCRD] repeat-failed declaration rejected (${count}/${maxRetries}): ${plan.goal}`)
        throw new Error(`[LCRD] 子任务声明与上次失败的声明原样相同(第 ${count}/${maxRetries} 次): ${plan.goal}。禁止原样重试,请更换策略或参数后重新声明 lcrd_plan。`)
      }
      plans.set(agent, plan)
      const recorder = ensureFlow(agent)
      recorder.push({ type: 'plan', goal: plan.goal, stop: plan.stop_condition, feasibility: plan.feasibility, verifier: plan.verifier.kind, verifierSpec: plan.verifier, context: planContext(agent), callId })
      recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`)
      if (fileFlowEnabled && taskDirs.get(agent) === undefined) {
        /* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
        try {
          const taskDir = await ensureTaskDir(agent)
          recorder.log(`[LCRD] task dir auto-created: ${taskDir}`)
          flush(agent)
          return `计划已记录: 目标="${declared.goal}"。任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。下一步工具结果将由 ${declared.verifier.kind} 校验器独立验证。`
        } catch {
          // Task-dir creation failed; continue on the plain rollback flow.
        }
        /* v8 ignore stop */
      }
      flush(agent)
      return `计划已记录: 目标="${declared.goal}"。下一步工具结果将由 ${declared.verifier.kind} 校验器独立验证。`
    },
  }))
}
