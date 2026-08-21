import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { registerAnchorSection, PROTOCOL_TEXT } from "./anchor.js";
import { FlowRecorder } from "./flow.js";
import { runVerifier } from "./verifiers.js";
/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, shortAgentId } from "./flow.js";
/** The exogenous verifier API: payload rendering and the code verifier. */
export { resultPayload, verifyAssert } from "./verifiers.js";
export const name = 'lcrd-hard-isolation';
export const inject = ['systemPrompt', 'tools', 'llm'];
export const Config = z.object({
    maxRetries: z.number().default(3),
    pythonCommand: z.string().default('python'),
    pythonTimeoutMs: z.number().default(30000),
    verifierModel: z.string().default(undefined),
    logDir: z.string().default(undefined),
    interaction: z.union(['auto', 'auth', 'manual']).default('manual'),
});
/** The `{kind:'plugin'}` source stamped on every injected context. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'lcrd-hard-isolation' };
/** Model-facing text of one content block. */
function textBlock(text) {
    return { type: 'text', text };
}
/** Narrow one tool-argument value to a string, rejecting anything else. */
function parseString(raw, field) {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`);
    }
    return raw;
}
/** Narrow one tool-argument value to a boolean, rejecting anything else. */
function parseBoolean(raw, field) {
    if (typeof raw !== 'boolean') {
        throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`);
    }
    return raw;
}
/** Validate the model-supplied verifier object against the declared protocol. */
function parseVerifier(raw) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('lcrd_plan: 参数 verifier 必须是对象');
    }
    const record = raw;
    if (record.kind === 'assert') {
        const conditions = record.conditions;
        if (!Array.isArray(conditions) || !conditions.every(item => typeof item === 'string')) {
            throw new Error('lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组');
        }
        return { kind: 'assert', conditions };
    }
    if (record.kind === 'python') {
        const checks = record.checks;
        if (!Array.isArray(checks) || !checks.every(item => typeof item === 'string')) {
            throw new Error('lcrd_plan: verifier.kind=python 需要 checks 为字符串数组');
        }
        return { kind: 'python', checks };
    }
    if (record.kind === 'llm') {
        return { kind: 'llm' };
    }
    throw new Error(`lcrd_plan: 未知的 verifier kind: ${String(record.kind)}`);
}
/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
    const maxRetries = config.maxRetries;
    const pythonCommand = config.pythonCommand;
    const pythonTimeoutMs = config.pythonTimeoutMs;
    const verifierModel = config.verifierModel;
    const logDir = config.logDir;
    const interaction = config.interaction;
    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
        throw new Error('lcrd-hard-isolation: `maxRetries` must be an integer >= 1');
    }
    if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1000) {
        throw new Error('lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000');
    }
    const plans = new WeakMap();
    const failures = new WeakMap();
    const terminated = new WeakSet();
    const flows = new WeakMap();
    const sessionRecorders = new WeakMap();
    const policySet = new WeakSet();
    const allRecorders = new Set();
    /** The approval policy the interaction mode maps to (`'never'` auto-rejects; `'ask'` delegates). */
    const approvalPolicy = interaction === 'auto' ? 'never' : 'ask';
    /**
     * Lazily create the recorder and pin the approval policy once per agent.
     * Artifacts are refreshed by the per-turn `session/event` listener below
     * and final-flushed by the global `agent/disposed` listener (more reliable
     * than a per-agent scoped listener for multi-session runs).
     */
    function ensureFlow(agent) {
        let recorder = flows.get(agent);
        if (!recorder) {
            recorder = new FlowRecorder(agent, maxRetries, { outDir: logDir, interaction });
            flows.set(agent, recorder);
            sessionRecorders.set(agent.session, recorder);
            allRecorders.add(recorder);
            try {
                if (!policySet.has(agent)) {
                    setApprovalPolicy(agent.session, approvalPolicy);
                    policySet.add(agent);
                }
            }
            catch { /* approval service absent — leave the default policy */ }
        }
        return recorder;
    }
    /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
    function flush(agent) {
        const recorder = flows.get(agent);
        if (recorder) {
            try {
                recorder.dump();
            }
            catch { /* dump must not break the session */ }
        }
    }
    // Rewrite the flow artifacts at every protocol step (plan declaration and
    // each verified tool result) so the exports stay current mid-turn, and
    // again after every completed turn — a long-lived surface must not wait for
    // disposal to materialize them.
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end')
            return;
        const recorder = sessionRecorders.get(session);
        if (recorder) {
            try {
                recorder.dump();
            }
            catch { /* dump must not break the session */ }
        }
    });
    // Final flush as soon as the agent is disposed, whichever session/scope it
    // lives in. The global event carries the agent in its payload, so this
    // fires reliably for every session in a long-running process (unlike the
    // per-agent scoped listener). dump() rewrites the latest snapshot.
    ctx.on('agent/disposed', ({ agent }) => {
        const recorder = flows.get(agent);
        if (recorder) {
            try {
                recorder.dump();
            }
            catch { /* dump must not break disposal */ }
        }
    });
    // Long-running surfaces dispose the agent (agent/disposed above); the
    // one-shot headless profile exits the process instead, so exit flushes too.
    process.once('exit', () => {
        for (const recorder of allRecorders) {
            try {
                recorder.dump();
            }
            catch { /* exit must not fail the session */ }
        }
    });
    registerAnchorSection(ctx);
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
            const agent = exec.agent;
            if (!agent)
                throw new Error('lcrd_plan requires an agent-scoped execution');
            const plan = {
                goal: parseString(args.goal, 'goal'),
                stop_condition: parseString(args.stop_condition, 'stop_condition'),
                feasibility: parseBoolean(args.feasibility, 'feasibility'),
                verifier: parseVerifier(args.verifier),
            };
            plans.set(agent, plan);
            const recorder = ensureFlow(agent);
            recorder.push({ type: 'plan', goal: plan.goal, stop: plan.stop_condition, feasibility: plan.feasibility, verifier: plan.verifier.kind, verifierSpec: plan.verifier });
            recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`);
            flush(agent);
            return `计划已记录: 目标="${plan.goal}"。下一步工具结果将由 ${plan.verifier.kind} 校验器独立验证。`;
        },
    }));
    // The rollback symbol: after every tool execution, verify the result against
    // the declared plan and reject it with corrective feedback on failure.
    ctx.on('tools/post-execute', async (exec, result, next) => {
        if (!exec.agent)
            return next();
        const agent = exec.agent;
        if (terminated.has(agent)) {
            ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`);
            ensureFlow(agent).push({ type: 'tool', name: exec.name });
            ensureFlow(agent).push({ type: 'intercept', kind: 'terminated', detail: '任务已终止,后续工具调用被拦截' });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock('[LCRD] 任务已因连续校验失败终止,等待人工介入。停止所有工具调用,向用户报告失败情况。')],
            };
        }
        if (exec.name === 'lcrd_plan')
            return next();
        // In unattended ('auto') mode no human is available: auto-answer an agent
        // that tries to ask the user, instead of blocking on a plan or waiting.
        if (interaction === 'auto' && exec.name === 'ask_user_question') {
            const recorder = ensureFlow(agent);
            recorder.markAskIntercepted();
            recorder.log('[LCRD] auto-answer: tool=ask_user_question blocked (unattended)');
            recorder.push({ type: 'tool', name: exec.name });
            recorder.push({ type: 'intercept', kind: 'missing-plan', detail: 'ask_user_question (auto mode)' });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock('[LCRD] 自动模式无法人工应答。请基于已有信息自主判断并继续,不要等待用户输入;若必须确认,请按 stop_condition 校验现有结果。')],
                additionalContexts: [createUserMessage({
                        content: [textBlock('[LCRD] 自动模式: 无法人工应答 ask_user_question,请自主决策继续。')],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd auto-answer' },
                    })],
            };
        }
        const plan = plans.get(agent);
        if (!plan) {
            ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`);
            ensureFlow(agent).push({ type: 'tool', name: exec.name });
            ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: exec.name });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock('[LCRD] 未声明子任务计划: 执行任何工具前必须先调用 lcrd_plan 工具声明 goal、stop_condition、feasibility 与 verifier。')],
                additionalContexts: [createUserMessage({
                        content: [textBlock('[LCRD] 工具结果被拒绝,原因: 缺少子任务计划声明。请先调用 lcrd_plan 再重试工具。')],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd missing plan' },
                    })],
            };
        }
        if (!plan.feasibility) {
            ensureFlow(agent).log(`[LCRD] infeasible: tool=${exec.name} blocked`);
            ensureFlow(agent).push({ type: 'tool', name: exec.name });
            ensureFlow(agent).push({ type: 'intercept', kind: 'infeasible', detail: exec.name });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock(`[LCRD] 计划声明 feasibility=false,子任务被外部引擎拒绝: ${plan.goal}`)],
                additionalContexts: [createUserMessage({
                        content: [textBlock('[LCRD] 请重新调用 lcrd_plan 声明可行的子任务,或直接向用户说明无法继续。')],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd infeasible plan' },
                    })],
            };
        }
        const verdict = await runVerifier(ctx, agent, plan.verifier, result, { pythonCommand, pythonTimeoutMs, verifierModel, anchorText: PROTOCOL_TEXT }, plan, exec.signal);
        ensureFlow(agent).push({ type: 'tool', name: exec.name });
        if (verdict.pass) {
            ensureFlow(agent).push({ type: 'verdict', pass: true, reason: verdict.reason });
            failures.delete(agent);
            ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
            flush(agent);
            return next();
        }
        const count = (failures.get(agent) ?? 0) + 1;
        failures.set(agent, count);
        ensureFlow(agent).push({ type: 'verdict', pass: false, reason: verdict.reason, count });
        if (verdict.exception === true)
            ensureFlow(agent).markVerifierException();
        ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
        if (count >= maxRetries) {
            terminated.add(agent);
            const terminal = `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock(terminal)],
                additionalContexts: [createUserMessage({
                        content: [textBlock(terminal)],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd terminated' },
                    })],
            };
        }
        const rollback = `[LCRD] 校验失败(第 ${count}/${maxRetries} 次): ${verdict.reason}。工具结果已被外部引擎拒绝。请重新设计一套不同的子任务方法(更换策略或参数)并再次声明 lcrd_plan;禁止原样重试。`;
        flush(agent);
        return {
            kind: 'block',
            feedback: [textBlock(rollback)],
            additionalContexts: [createUserMessage({
                    content: [textBlock(`[LCRD] 上次校验失败: ${verdict.reason}`)],
                    source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd verify fail' },
                })],
        };
    });
}
//# sourceMappingURL=index.js.map