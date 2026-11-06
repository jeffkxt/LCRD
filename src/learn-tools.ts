/**
 * The learning-symbol tools (`lcrd_learn` and `lcrd_learn_verify`): declare a
 * learning round, then self-evaluate it against the model-authored criteria.
 * Takes state and the recorder bridge once so this module never imports the
 * wiring root.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseBoolean, parseString } from './declaration.ts'
import type { FlowRecorder } from './flow.ts'
import { citedEvidence } from './step-learn.ts'
import type { LearnEvidence, LcrdState } from './state.ts'
import type { LearnDeclaration, LearnVerdict } from './types.ts'

/** Model-facing name of each evidence source kind. */
const KIND_LABEL: Record<LearnEvidence['kind'], string> = { path: '文件', url: 'URL', call: '调用' }

/** The recorder operations the learning tools use — a structural subset of the full bridge. */
export interface LearnToolsBridge {
  /** Lazily create (or fetch) the agent's flow recorder. */
  ensureFlow: (agent: Agent) => FlowRecorder
  /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
  flush: (agent: Agent) => void
}

/** State and configuration the learning tools close over; a subset of the plugin instance. */
export interface LearnToolsDeps {
  /** Mutable containers the tools mutate (learning phase / attempts, termination). */
  state: Pick<LcrdState, 'learning' | 'terminated'>
  /** Shared recorder operations (ensureFlow / flush). */
  bridge: LearnToolsBridge
  /** Learning rounds before human review. */
  maxLearningAttempts: number
  /** The configured knowledge-acquisition tool names (allowed during the learn phase). */
  learningToolSet: Set<string>
}

/**
 * Register `lcrd_learn` and `lcrd_learn_verify` when learning mode is enabled.
 * @param ctx - the plugin context whose tool registry receives the tools.
 * @param deps - state, bridge, and config the tools close over.
 */
export function registerLearnTools(ctx: Context, deps: LearnToolsDeps): void {
  const { state, bridge, maxLearningAttempts, learningToolSet } = deps
  const { learning, terminated } = state
  const { ensureFlow, flush } = bridge

  ctx.tools.register(defineTool({
    name: 'lcrd_learn',
    description: 'Declare one learning round before acquiring knowledge: analyze why the current task cannot be solved, what knowledge is needed, how it will be learned (web search / reading files / reflection / delegation), and the self-evaluation criteria. After declaring, use the configured learning tools to acquire knowledge, then call lcrd_learn_verify to self-evaluate. A failed self-evaluation consumes one learning attempt; a passed one resumes re-solving the original task.',
    parameters: {
      problem_analysis: { type: 'string', required: true, description: '当前无法解决问题的拆解与根因分析' },
      knowledge_needed: { type: 'string', required: true, description: '需要学习的具体知识' },
      learning_method: { type: 'string', required: true, description: '学习方法:web_search / 读文件 / 反思 / 子代理等' },
      eval_criteria: { type: 'string', required: true, description: '自评是否学会的评价标准(模型自己编写)' },
    },
    /* jscpd:ignore-start -- the protocol tools share the same output/render/execute-head shape */
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
      /* jscpd:ignore-end */
      const learnState = learning.get(agent)
      if (!learnState) throw new Error('lcrd_learn 只能在学习模式(连续校验失败达到阈值)下调用')
      const declaration: LearnDeclaration = {
        problem_analysis: parseString(args.problem_analysis, 'problem_analysis'),
        knowledge_needed: parseString(args.knowledge_needed, 'knowledge_needed'),
        learning_method: parseString(args.learning_method, 'learning_method'),
        eval_criteria: parseString(args.eval_criteria, 'eval_criteria'),
      }
      learnState.phase = 'learn'
      learnState.evidence = []
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
      evidence: { type: 'string', required: true, description: '自评依据:写入本轮登记的证据 id(如 e1)或来源路径/URL,并说明它如何满足评价标准;未引用任何已登记证据时自评不通过且不消耗轮次' },
    },
    /* jscpd:ignore-start -- the protocol tools share the same output/render/execute-head shape */
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
      /* jscpd:ignore-end */
      const learnState = learning.get(agent)
      if (!learnState) throw new Error('lcrd_learn_verify 只能在学习模式(连续校验失败达到阈值)下调用')
      const verdict: LearnVerdict = {
        learned: parseBoolean(args.learned, 'learned'),
        evidence: parseString(args.evidence, 'evidence'),
      }
      const recorder = ensureFlow(agent)
      if (!verdict.learned) {
        learnState.attempts += 1
        recorder.push({ type: 'learn-verify', learned: false, evidence: verdict.evidence, count: learnState.attempts })
        recorder.log(`[LCRD] learn FAIL (${learnState.attempts}/${maxLearningAttempts}): ${verdict.evidence}`)
        flush(agent)
        if (learnState.attempts >= maxLearningAttempts) {
          terminated.add(agent)
          const terminal = `[LCRD] 自评未通过且学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.evidence}。停止所有工具调用,向用户报告失败原因,等待人工指令。`
          return terminal
        }
        return `自评未通过(第 ${learnState.attempts}/${maxLearningAttempts} 轮): ${verdict.evidence}。请再次调用 lcrd_learn 分析问题,继续学习并重新自评。`
      }
      if (learnState.evidence.length === 0) {
        return `自评不能通过:本轮尚未调用任何学习工具(${[...learningToolSet].join(', ')})。请先使用学习工具获取知识,再重新自评。`
      }
      // The round must cite the knowledge it acquired: an uncited self-evaluation
      // is unproven rather than failed, so it consumes no learning attempt.
      if (citedEvidence(verdict.evidence, learnState.evidence) === undefined) {
        const available = learnState.evidence
          .map(entry => `- ${entry.id} (${KIND_LABEL[entry.kind]}) ${entry.label} · digest ${entry.digest}`)
          .join('\n')
        return `自评不能通过:evidence 未引用本轮登记的任何知识,因此不消耗学习轮次。请在 evidence 中写入下列 id 或来源之一,并说明它如何满足评价标准:\n${available}`
      }
      learnState.phase = 'resolve'
      recorder.push({ type: 'learn-verify', learned: true, evidence: verdict.evidence })
      recorder.log(`[LCRD] learn PASS: ${verdict.evidence} → 进入重解阶段`)
      flush(agent)
      return '自评通过。请重新声明 lcrd_plan 并执行工具解决原任务;重解结果仍由外生校验器验证,通过即任务完成并重置学习次数。'
    },
  }))
}
