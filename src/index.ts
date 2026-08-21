/**
 * LCRD hard-isolation minimal sample: the three-symbol protocol (root anchor,
 * stop symbol, rollback symbol) implemented over the harness extension points.
 * The root anchor is pinned in the system prompt, the model declares each
 * subtask plan through the `lcrd_plan` tool, and every tool result is verified
 * after execution by an exogenous verifier the model chose; failures roll back
 * with corrective feedback and terminate after a configured retry budget.
 *
 * @module lcrd-hard-isolation
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { defineTool, type PostToolDecision, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy, type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { registerAnchorSection, PROTOCOL_TEXT } from './anchor.ts'
import { FlowRecorder } from './flow.ts'
import type { LearnDeclaration, LearnVerdict, StepPlan } from './types.ts'
import { runVerifier } from './verifiers.ts'

/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, shortAgentId } from './flow.ts'
/** The exogenous verifier API: payload rendering and the code verifier. */
export { resultPayload, verifyAssert } from './verifiers.ts'
export type { VerifyPayload } from './verifiers.ts'

export const name = 'lcrd-hard-isolation'
export const inject = ['systemPrompt', 'tools', 'llm']

/** Plugin config, validated by the same-named schemastery schema. */
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
}

export const Config = z.object({
  maxRetries: z.number().default(3),
  pythonCommand: z.string().default('python'),
  pythonTimeoutMs: z.number().default(30000),
  verifierModel: z.string().default(undefined as unknown as string),
  logDir: z.string().default(undefined as unknown as string),
  interaction: z.union(['auto', 'auth', 'manual'] as const).default('manual'),
  learningEnabled: z.boolean().default(false),
  learningThreshold: z.number().default(5),
  maxLearningAttempts: z.number().default(3),
  learningTools: z.array(z.string()).default([
    'web_search', 'read', 'glob', 'grep', 'skill', 'subagent', 'web_fetch',
  ]),
})

/** The `{kind:'plugin'}` source stamped on every injected context. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'lcrd-hard-isolation' }

/** Model-facing text of one content block. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** Narrow one tool-argument value to a string, rejecting anything else. */
function parseString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`)
  }
  return raw
}

/** Narrow one tool-argument value to a boolean, rejecting anything else. */
function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') {
    throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`)
  }
  return raw
}

/** Validate the model-supplied verifier object against the declared protocol. */
function parseVerifier(raw: unknown): StepPlan['verifier'] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('lcrd_plan: 参数 verifier 必须是对象')
  }
  const record = raw as Record<string, unknown>
  if (record.kind === 'assert') {
    const conditions = record.conditions
    if (!Array.isArray(conditions) || !conditions.every(item => typeof item === 'string')) {
      throw new Error('lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组')
    }
    return { kind: 'assert', conditions }
  }
  if (record.kind === 'python') {
    const checks = record.checks
    if (!Array.isArray(checks) || !checks.every(item => typeof item === 'string')) {
      throw new Error('lcrd_plan: verifier.kind=python 需要 checks 为字符串数组')
    }
    return { kind: 'python', checks }
  }
  if (record.kind === 'llm') {
    return { kind: 'llm' }
  }
  throw new Error(`lcrd_plan: 未知的 verifier kind: ${String(record.kind)}`)
}

/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const maxRetries = config.maxRetries as number
  const pythonCommand = config.pythonCommand as string
  const pythonTimeoutMs = config.pythonTimeoutMs as number
  const verifierModel = config.verifierModel
  const logDir = config.logDir
  const interaction = config.interaction as 'auto' | 'auth' | 'manual'
  const learningEnabled = config.learningEnabled as boolean
  const learningThreshold = config.learningThreshold as number
  const maxLearningAttempts = config.maxLearningAttempts as number
  const learningToolSet = new Set(config.learningTools as string[])
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error('lcrd-hard-isolation: `maxRetries` must be an integer >= 1')
  }
  if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1000) {
    throw new Error('lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000')
  }
  if (!Number.isInteger(learningThreshold) || learningThreshold < 1) {
    throw new Error('lcrd-hard-isolation: `learningThreshold` must be an integer >= 1')
  }
  if (!Number.isInteger(maxLearningAttempts) || maxLearningAttempts < 1) {
    throw new Error('lcrd-hard-isolation: `maxLearningAttempts` must be an integer >= 1')
  }

  const plans = new WeakMap<Agent, StepPlan>()
  const failures = new WeakMap<Agent, number>()
  const terminated = new WeakSet<Agent>()
  /** Per-agent learning-mode state: consumed rounds, the current phase, and whether a learning tool ran this round. */
  const learning = new WeakMap<Agent, { attempts: number; phase: 'learn' | 'resolve'; evidence: boolean }>()
  const flows = new WeakMap<Agent, FlowRecorder>()
  const sessionRecorders = new WeakMap<Session, FlowRecorder>()
  const policySet = new WeakSet<Agent>()
  const allRecorders = new Set<FlowRecorder>()

  /** The approval policy the interaction mode maps to (`'never'` auto-rejects; `'ask'` delegates). */
  const approvalPolicy: ApprovalPolicy = interaction === 'auto' ? 'never' : 'ask'

  /**
   * Lazily create the recorder and pin the approval policy once per agent.
   * Artifacts are refreshed by the per-turn `session/event` listener below
   * and final-flushed by the global `agent/disposed` listener (more reliable
   * than a per-agent scoped listener for multi-session runs).
   */
  function ensureFlow(agent: Agent): FlowRecorder {
    let recorder = flows.get(agent)
    if (!recorder) {
      recorder = new FlowRecorder(agent, maxRetries, {
        outDir: logDir,
        interaction,
        learningEnabled,
        learningThreshold,
        maxLearningAttempts,
      })
      flows.set(agent, recorder)
      sessionRecorders.set(agent.session, recorder)
      allRecorders.add(recorder)
      try {
        if (!policySet.has(agent)) {
          setApprovalPolicy(agent.session, approvalPolicy)
          policySet.add(agent)
        }
      } catch { /* approval service absent — leave the default policy */ }
    }
    return recorder
  }

  /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
  function flush(agent: Agent): void {
    const recorder = flows.get(agent)
    if (recorder) {
      try { recorder.dump() } catch { /* dump must not break the session */ }
    }
  }

  // Rewrite the flow artifacts at every protocol step (plan declaration and
  // each verified tool result) so the exports stay current mid-turn, and
  // again after every completed turn — a long-lived surface must not wait for
  // disposal to materialize them.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const recorder = sessionRecorders.get(session)
    if (recorder) {
      try { recorder.dump() } catch { /* dump must not break the session */ }
    }
  })

  // Final flush as soon as the agent is disposed, whichever session/scope it
  // lives in. The global event carries the agent in its payload, so this
  // fires reliably for every session in a long-running process (unlike the
  // per-agent scoped listener). dump() rewrites the latest snapshot.
  ctx.on('agent/disposed', ({ agent }) => {
    const recorder = flows.get(agent)
    if (recorder) {
      try { recorder.dump() } catch { /* dump must not break disposal */ }
    }
  })

  // Long-running surfaces dispose the agent (agent/disposed above); the
  // one-shot headless profile exits the process instead, so exit flushes too.
  process.once('exit', () => {
    for (const recorder of allRecorders) {
      try { recorder.dump() } catch { /* exit must not fail the session */ }
    }
  })

  registerAnchorSection(ctx)

  // The stop symbol's declaration point: the model states its subtask goal,
  // its local stop condition, and the verifier before executing any tool.
  ctx.tools.register(defineTool({
    name: 'lcrd_plan',
    description: 'Declare the next subtask plan before executing tools: the subtask goal, a stop condition an external verifier can check, a feasibility flag, and the verifier to run on the next tool result (assert / python / llm). The external engine verifies every tool result against the declared stop condition; a failed verification rejects the result. The model supplies only data, never the pass criterion: assert/python take expressions over `result` that must reference it and must not be true for every input; the llm verifier uses a plugin-fixed prompt checked against the root anchor.',
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
          conditions: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind=assert: 每条断言是作用于 result 的 JS 表达式,必须引用 result,全部为真才通过',
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind=python: 每条检查是作用于 result 的 Python 表达式,必须引用 result,全部为真才通过',
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    /* oxlint-disable-next-line typescript/require-await --
     * The tool-execute interface mandates an async signature; this plan
     * declaration is synchronous by design.
     */
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('lcrd_plan requires an agent-scoped execution')
      const plan: StepPlan = {
        goal: parseString(args.goal, 'goal'),
        stop_condition: parseString(args.stop_condition, 'stop_condition'),
        feasibility: parseBoolean(args.feasibility, 'feasibility'),
        verifier: parseVerifier(args.verifier),
      }
      plans.set(agent, plan)
      const recorder = ensureFlow(agent)
      recorder.push({ type: 'plan', goal: plan.goal, stop: plan.stop_condition, feasibility: plan.feasibility, verifier: plan.verifier.kind, verifierSpec: plan.verifier })
      recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`)
      flush(agent)
      return `计划已记录: 目标="${plan.goal}"。下一步工具结果将由 ${plan.verifier.kind} 校验器独立验证。`
    },
  }))

  // The learning symbol: after consecutive verifier failures reach the
  // configured threshold, direct retries pause and the model must declare
  // learning rounds through lcrd_learn / lcrd_learn_verify. The declaration
  // and the self-evaluation are model-authored data; the re-solve still runs
  // the exogenous verifier, which is the only check that can complete the
  // task and reset the learning budget.
  if (learningEnabled) {
    ctx.tools.register(defineTool({
      name: 'lcrd_learn',
      description: 'Declare one learning round before acquiring knowledge: analyze why the current task cannot be solved, what knowledge is needed, how it will be learned (web search / reading files / reflection / delegation), and the self-evaluation criteria. After declaring, use the configured learning tools to acquire knowledge, then call lcrd_learn_verify to self-evaluate. A failed self-evaluation consumes one learning attempt; a passed one resumes re-solving the original task.',
      parameters: {
        problem_analysis: { type: 'string', required: true, description: '当前无法解决问题的拆解与根因分析' },
        knowledge_needed: { type: 'string', required: true, description: '需要学习的具体知识' },
        learning_method: { type: 'string', required: true, description: '学习方法:web_search / 读文件 / 反思 / 子代理等' },
        eval_criteria: { type: 'string', required: true, description: '自评是否学会的评价标准(模型自己编写)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      /* oxlint-disable-next-line typescript/require-await --
       * The tool-execute interface mandates an async signature; this learning
       * declaration is synchronous by design.
       */
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('lcrd_learn requires an agent-scoped execution')
        const state = learning.get(agent)
        if (!state) throw new Error('lcrd_learn 只能在学习模式(连续校验失败达到阈值)下调用')
        const declaration: LearnDeclaration = {
          problem_analysis: parseString(args.problem_analysis, 'problem_analysis'),
          knowledge_needed: parseString(args.knowledge_needed, 'knowledge_needed'),
          learning_method: parseString(args.learning_method, 'learning_method'),
          eval_criteria: parseString(args.eval_criteria, 'eval_criteria'),
        }
        state.phase = 'learn'
        state.evidence = false
        const recorder = ensureFlow(agent)
        recorder.push({
          type: 'learn',
          analysis: declaration.problem_analysis,
          knowledge: declaration.knowledge_needed,
          method: declaration.learning_method,
          criteria: declaration.eval_criteria,
        })
        recorder.log(`[LCRD] learn: problem="${declaration.problem_analysis}" knowledge="${declaration.knowledge_needed}" method="${declaration.learning_method}"`)
        flush(agent)
        return `学习轮次已记录: 问题="${declaration.problem_analysis}"。现在使用学习工具获取知识,完成后调用 lcrd_learn_verify 自评。`
      },
    }))

    ctx.tools.register(defineTool({
      name: 'lcrd_learn_verify',
      description: 'Self-evaluate one learning round against the criteria declared in lcrd_learn: whether the knowledge has been acquired and the evidence. A failed self-evaluation consumes one learning attempt; when attempts are exhausted the task terminates for human review. A passed one switches to re-solving the original task, whose tool results still run the exogenous verifier.',
      parameters: {
        learned: { type: 'boolean', required: true, description: '是否认为自己已学会所需知识' },
        evidence: { type: 'string', required: true, description: '自评依据:如何用声明的评价标准判断' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      /* oxlint-disable-next-line typescript/require-await --
       * The tool-execute interface mandates an async signature; this
       * self-evaluation is synchronous by design.
       */
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('lcrd_learn_verify requires an agent-scoped execution')
        const state = learning.get(agent)
        if (!state) throw new Error('lcrd_learn_verify 只能在学习模式(连续校验失败达到阈值)下调用')
        const verdict: LearnVerdict = {
          learned: parseBoolean(args.learned, 'learned'),
          evidence: parseString(args.evidence, 'evidence'),
        }
        const recorder = ensureFlow(agent)
        if (!verdict.learned) {
          state.attempts += 1
          recorder.push({ type: 'learn-verify', learned: false, evidence: verdict.evidence, count: state.attempts })
          recorder.log(`[LCRD] learn FAIL (${state.attempts}/${maxLearningAttempts}): ${verdict.evidence}`)
          flush(agent)
          if (state.attempts >= maxLearningAttempts) {
            terminated.add(agent)
            const terminal = `[LCRD] 自评未通过且学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.evidence}。停止所有工具调用,向用户报告失败原因,等待人工指令。`
            flush(agent)
            return terminal
          }
          return `自评未通过(第 ${state.attempts}/${maxLearningAttempts} 轮): ${verdict.evidence}。请再次调用 lcrd_learn 分析问题,继续学习并重新自评。`
        }
        if (!state.evidence) {
          return `自评不能通过:本轮尚未调用任何学习工具(${[...learningToolSet].join(', ')})。请先使用学习工具获取知识,再重新自评。`
        }
        state.phase = 'resolve'
        recorder.push({ type: 'learn-verify', learned: true, evidence: verdict.evidence })
        recorder.log(`[LCRD] learn PASS: ${verdict.evidence} → 进入重解阶段`)
        flush(agent)
        return '自评通过。请重新声明 lcrd_plan 并执行工具解决原任务;重解结果仍由外生校验器验证,通过即任务完成并重置学习次数。'
      },
    }))
  }

  // A new user command is a fresh task boundary: reset the failure count, the
  // learning budget, and any termination so the model may retry the new task
  // from scratch. Plugin-injected notices carry `source.kind: 'plugin'` and
  // never reset; only real user input does.
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      // A fresh task must re-declare its plan: a stale plan from an earlier
      // command would otherwise gate the new task's first tool result.
      plans.delete(agent)
      failures.delete(agent)
      learning.delete(agent)
      if (terminated.has(agent)) {
        ensureFlow(agent).log('[LCRD] user command: termination reset for a new task')
        terminated.delete(agent)
      }
    }
    return next()
  })

  // The rollback symbol: after every tool execution, verify the result against
  // the declared plan and reject it with corrective feedback on failure. When
  // learning is enabled, consecutive failures at or above the threshold enter
  // learning mode instead of plain rollback, and a failed post-learning
  // re-solve consumes one learning attempt.
  ctx.on('tools/post-execute', async (exec, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    const agent = exec.agent

    if (terminated.has(agent)) {
      ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`)
      ensureFlow(agent).push({ type: 'tool', name: exec.name })
      ensureFlow(agent).push({ type: 'intercept', kind: 'terminated', detail: '任务已终止,后续工具调用被拦截' })
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock('[LCRD] 任务已因连续校验失败终止,等待人工介入。停止所有工具调用,向用户报告失败情况。')],
      }
    }

    const learningState = learning.get(agent)

    // Protocol tools are managed by their own execute handlers; they never
    // run the verifier. In the learn phase, declaring a task plan is blocked
    // until a learning round is declared and self-evaluated.
    if (exec.name === 'lcrd_plan' || exec.name === 'lcrd_learn' || exec.name === 'lcrd_learn_verify') {
      if (learningState && learningState.phase === 'learn' && exec.name === 'lcrd_plan') {
        ensureFlow(agent).log(`[LCRD] learn phase: tool=lcrd_plan blocked (must declare learning first)`)
        ensureFlow(agent).push({ type: 'tool', name: exec.name })
        ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: 'lcrd_plan during learn phase' })
        flush(agent)
        return {
          kind: 'block',
          feedback: [textBlock('[LCRD] 学习阶段禁止声明任务计划。请先调用 lcrd_learn 声明学习轮次,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后才能重新声明 lcrd_plan 重解任务。')],
          additionalContexts: [createUserMessage({
            content: [textBlock('[LCRD] 当前处于学习阶段:先完成 lcrd_learn → 学习工具 → lcrd_learn_verify,再重解任务。')],
            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learn phase plan blocked' },
          })],
        }
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
      recorder.push({ type: 'tool', name: exec.name })
      recorder.push({ type: 'intercept', kind: 'missing-plan', detail: 'ask_user_question (auto mode)' })
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock('[LCRD] 自动模式无法人工应答。请基于已有信息自主判断并继续,不要等待用户输入;若必须确认,请按 stop_condition 校验现有结果。')],
        additionalContexts: [createUserMessage({
          content: [textBlock('[LCRD] 自动模式: 无法人工应答 ask_user_question,请自主决策继续。')],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd auto-answer' },
        })],
      }
    }

    // Learn phase: knowledge-acquisition tools pass without a plan or verifier;
    // every other tool is blocked until the round is self-evaluated.
    if (learningState && learningState.phase === 'learn') {
      if (learningToolSet.has(exec.name)) {
        learningState.evidence = true
        ensureFlow(agent).push({ type: 'tool', name: exec.name })
        ensureFlow(agent).log(`[LCRD] learn tool: ${exec.name} passed`)
        flush(agent)
        return next()
      }
      ensureFlow(agent).log(`[LCRD] learn phase: tool=${exec.name} blocked (not a learning tool)`)
      ensureFlow(agent).push({ type: 'tool', name: exec.name })
      ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: `${exec.name} during learn phase` })
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock(`[LCRD] 学习阶段仅允许学习工具(${[...learningToolSet].join(', ')})。请使用它们获取知识,然后调用 lcrd_learn_verify 自评;禁止执行任务工具。`)],
        additionalContexts: [createUserMessage({
          content: [textBlock(`[LCRD] 工具 ${exec.name} 被拦截:学习阶段仅允许学习工具。先完成学习与自评,再重解任务。`)],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learn phase tool blocked' },
        })],
      }
    }

    const plan = plans.get(agent)
    if (!plan) {
      ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`)
      ensureFlow(agent).push({ type: 'tool', name: exec.name })
      ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: exec.name })
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock('[LCRD] 未声明子任务计划: 执行任何工具前必须先调用 lcrd_plan 工具声明 goal、stop_condition、feasibility 与 verifier。')],
        additionalContexts: [createUserMessage({
          content: [textBlock('[LCRD] 工具结果被拒绝,原因: 缺少子任务计划声明。请先调用 lcrd_plan 再重试工具。')],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd missing plan' },
        })],
      }
    }

    if (!plan.feasibility) {
      ensureFlow(agent).log(`[LCRD] infeasible: tool=${exec.name} blocked`)
      ensureFlow(agent).push({ type: 'tool', name: exec.name })
      ensureFlow(agent).push({ type: 'intercept', kind: 'infeasible', detail: exec.name })
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock(`[LCRD] 计划声明 feasibility=false,子任务被外部引擎拒绝: ${plan.goal}`)],
        additionalContexts: [createUserMessage({
          content: [textBlock('[LCRD] 请重新调用 lcrd_plan 声明可行的子任务,或直接向用户说明无法继续。')],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd infeasible plan' },
        })],
      }
    }

    const verdict = await runVerifier(
      ctx, agent, plan.verifier, result,
      { pythonCommand, pythonTimeoutMs, verifierModel, anchorText: PROTOCOL_TEXT },
      plan,
      exec.signal,
    )
    ensureFlow(agent).push({ type: 'tool', name: exec.name })

    if (verdict.pass) {
      ensureFlow(agent).push({ type: 'verdict', pass: true, reason: verdict.reason })
      failures.delete(agent)
      // A post-learning re-solve that passes completes the task and resets the
      // learning budget; the plain path stays untouched.
      const passedState = learning.get(agent)
      if (passedState) {
        ensureFlow(agent).push({ type: 'learn-verify', learned: true, evidence: `重解通过: ${verdict.reason}`, count: passedState.attempts })
        ensureFlow(agent).markLearningSuccess()
        ensureFlow(agent).log(`[LCRD] learning success: re-solve PASS after ${passedState.attempts} learning attempt(s), learning budget reset`)
        learning.delete(agent)
      }
      ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`)
      flush(agent)
      return next()
    }

    const count = (failures.get(agent) ?? 0) + 1
    failures.set(agent, count)
    ensureFlow(agent).push({ type: 'verdict', pass: false, reason: verdict.reason, count })
    if (verdict.exception === true) ensureFlow(agent).markVerifierException()
    ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`)

    // Learning trigger: consecutive failures reach the threshold while
    // learning is enabled and no round is open yet. Direct retries pause in
    // favor of the learning protocol; maxRetries termination is suspended
    // until the learning budget is exhausted.
    if (learningEnabled && !learning.has(agent) && count >= learningThreshold) {
      learning.set(agent, { attempts: 0, phase: 'learn', evidence: false })
      const notice = `[LCRD] 连续 ${count} 次校验失败,达到学习阈值(${learningThreshold}),进入学习模式(最多 ${maxLearningAttempts} 轮)。停止直接重试:先调用 lcrd_learn 分析问题与所需知识,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后重新声明 lcrd_plan 重解任务。`
      ensureFlow(agent).log(`[LCRD] learning mode entered: threshold=${learningThreshold} attempts=0/${maxLearningAttempts}`)
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock(notice)],
        additionalContexts: [createUserMessage({
          content: [textBlock(notice)],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning mode entered' },
        })],
      }
    }

    // A post-learning re-solve failure consumes one learning attempt and
    // returns to the learn phase with the verifier reason injected for the
    // next round's analysis; exhausted attempts terminate to human.
    const activeLearning = learning.get(agent)
    if (activeLearning) {
      activeLearning.attempts += 1
      ensureFlow(agent).push({ type: 'learn-verify', learned: false, evidence: verdict.reason, count: activeLearning.attempts })
      ensureFlow(agent).log(`[LCRD] learning round FAIL (${activeLearning.attempts}/${maxLearningAttempts}): ${verdict.reason}`)
      if (activeLearning.attempts >= maxLearningAttempts) {
        terminated.add(agent)
        const terminal = `[LCRD] 学习后重解仍失败,学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`
        flush(agent)
        return {
          kind: 'block',
          feedback: [textBlock(terminal)],
          additionalContexts: [createUserMessage({
            content: [textBlock(terminal)],
            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning exhausted' },
          })],
        }
      }
      activeLearning.phase = 'learn'
      activeLearning.evidence = false
      const notice = `[LCRD] 学习后重解仍失败(第 ${activeLearning.attempts}/${maxLearningAttempts} 轮): ${verdict.reason}。回到学习模式:调用 lcrd_learn 结合本次失败原因重新分析,继续学习并重新自评。`
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock(notice)],
        additionalContexts: [createUserMessage({
          content: [textBlock(`[LCRD] 重解失败原因(供新一轮学习分析): ${verdict.reason}`)],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning round failed' },
        })],
      }
    }

    if (count >= maxRetries) {
      terminated.add(agent)
      const terminal = `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`
      flush(agent)
      return {
        kind: 'block',
        feedback: [textBlock(terminal)],
        additionalContexts: [createUserMessage({
          content: [textBlock(terminal)],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd terminated' },
        })],
      }
    }

    const rollback = `[LCRD] 校验失败(第 ${count}/${maxRetries} 次): ${verdict.reason}。工具结果已被外部引擎拒绝。请重新设计一套不同的子任务方法(更换策略或参数)并再次声明 lcrd_plan;禁止原样重试。`
    flush(agent)
    return {
      kind: 'block',
      feedback: [textBlock(rollback)],
      additionalContexts: [createUserMessage({
        content: [textBlock(`[LCRD] 上次校验失败: ${verdict.reason}`)],
        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd verify fail' },
      })],
    }
  })
}
