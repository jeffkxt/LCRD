import z from '@deepseek-ai/schemastery';
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { registerAnchorSection, PROTOCOL_TEXT, PROTOCOL_VERSION } from "./anchor.js";
import { classifyFlowPath, registerFileFlowSection, FILE_FLOW_DIR } from "./file-flow.js";
import { FlowRecorder, defaultLogDir } from "./flow.js";
import { appendDatasetRows, dpoPairsForRun, defaultAttribution, ensureDatasetFiles } from "./dataset.js";
import { loadAttribution } from "./attribution.js";
import { loadHooks, isStepPlan } from "./hooks.js";
import { clipSummary, summarizeArguments, summarizeResult } from "./instrumentation.js";
import { runVerifier } from "./verifiers.js";
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, pluginVersion, shortAgentId } from "./flow.js";
/** The recorded-event vocabulary: envelope, schema version, stream and run-meta file names. */
export { FLOW_SCHEMA_VERSION, FLOW_STREAM_FILE, RUN_META_FILE } from "./flow.js";
/** The version of the injected protocol text and corrective notices. */
export { PROTOCOL_VERSION } from "./anchor.js";
/** The exogenous verifier API: payload rendering, the code verifier, and the plan-time probes. */
export { probeExpression, probeHoldRate, resultPayload, verifyAssert } from "./verifiers.js";
/** The record-resolution instrumentation API: assertion strictness, relaxation axes, and tool summaries. */
export { clipSummary, describeStrictness, relaxationAxes, specExpressions, summarizeArguments, summarizeResult } from "./instrumentation.js";
/** The dataset API: the failure taxonomy, per-run row construction, and the append path. */
export { DATASET_FILES, appendDatasetRows, classifyFailure, classifyRelaxationCause, classifyTrainability, datasetRowsForRun, dpoPairsForRun, ensureDatasetFiles, expressionsOf, renderTranscriptEntry, withExpressions, } from "./dataset.js";
/** The attribution hook: the replaceable failure/relaxation/trainability classifier bundle and its loader. */
export { defaultAttribution } from "./dataset.js";
export { isAttribution, loadAttribution } from "./attribution.js";
/** The policy-hook seam: the deployment module inspecting LCRD's own plan and verified results. */
export { isLcrdHooks, loadHooks } from "./hooks.js";
/** The file-flow path classifier: hard isolation applies only to task-context paths under `task-flow/`. */
export { classifyFlowPath, fileFlowSectionText } from "./file-flow.js";
export const name = 'lcrd-hard-isolation';
export const inject = ['systemPrompt', 'tools', 'llm', 'fs'];
export const Config = z.object({
    maxRetries: z.number().default(3),
    pythonCommand: z.string().default('python'),
    pythonTimeoutMs: z.number().default(30000),
    verifierModel: z.string().default(undefined),
    logDir: z.string().default(undefined),
    interaction: z.union(['auto', 'auth', 'manual']).default('manual'),
    learningEnabled: z.boolean().default(false),
    learningThreshold: z.number().default(5),
    maxLearningAttempts: z.number().default(3),
    learningTools: z.array(z.string()).default([
        'web_search', 'read', 'glob', 'grep', 'skill', 'subagent', 'web_fetch',
    ]),
    fileFlowEnabled: z.boolean().default(false),
    fileFlowPathViolationsMax: z.number().default(3),
    workspaceRoot: z.string().default(undefined),
    fileFlowTools: z.array(z.string()).default(['str_replace_editor', 'write', 'edit']),
    failedCheckConsumesRetry: z.boolean().default(true),
    datasetExport: z.union(['off', 'run']).default('off'),
    datasetDir: z.string().default(undefined),
    attributionModule: z.string().default(undefined),
    hooksModule: z.string().default(undefined),
});
/** The `{kind:'plugin'}` source stamped on every injected context, concretely typed so spreads never widen to the MessageSource union. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'lcrd-hard-isolation' };
/** Clip length of the recorded anchor excerpt, in characters. */
const ANCHOR_EXCERPT_MAX = 500;
/**
 * The payload of one session event: durable logs wrap it under `data`, while an
 * in-process event carries the payload directly.
 * @param event - the session event as delivered.
 * @returns the payload to read fields from.
 */
function sessionPayloadOf(event) {
    const candidate = event;
    return (typeof candidate.data === 'object' && candidate.data !== null ? candidate.data : event);
}
/**
 * Append one session event to the run's transcript, so the exported DPO prompt
 * carries what the model actually saw.
 * @param state - the session's transcript state.
 * @param event - the session event as delivered.
 */
function trackTranscript(state, event) {
    const type = event.type;
    const payload = sessionPayloadOf(event);
    if (type === 'user/message') {
        const message = payload['message'];
        state.entries.push({
            role: 'user',
            text: textOfContent(message?.content),
            ...(message?.source?.kind === undefined ? {} : { source: message.source.kind }),
        });
    }
    else if (type === 'assistant/message') {
        const message = payload['message'];
        state.entries.push({ role: 'assistant', text: textOfContent(message?.content) });
    }
    else if (type === 'tool/call') {
        const callId = asPayloadString(payload['callId']);
        const name = asPayloadString(payload['name']);
        const args = asPayloadString(payload['arguments']);
        state.entries.push({ role: 'assistant', text: '', toolCalls: [{ name, arguments: args, callId }] });
        if (name === 'lcrd_plan')
            state.planIndexByCallId.set(callId, state.entries.length - 1);
    }
    else if (type === 'tool/result') {
        const message = payload['message'];
        state.entries.push({
            role: 'tool',
            text: textOfContent(message?.content),
            callId: asPayloadString(message?.toolCallId),
            isError: message?.isError === true,
        });
    }
}
/**
 * Read one session payload field as a string, ignoring any non-string value.
 * @param value - the payload field.
 * @returns the string value, or an empty string.
 */
function asPayloadString(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Join the text blocks of one message's content.
 * @param content - the message content from the session event.
 * @returns the concatenated text blocks.
 */
function textOfContent(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => {
        const candidate = block;
        return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
        .filter(text => text.length > 0)
        .join('\n');
}
/**
 * Digest and excerpt of the anchoring user message text. The anchor is the
 * conversation's first user message: the digest groups runs that share one root
 * anchor, and the excerpt lets an offline judge label conformance against it.
 * @param message - the user message that opened the task.
 * @returns the 16-hex digest and the clipped message text.
 */
function anchorIdentityOf(message) {
    const text = message.content
        .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
        .join('\n');
    return {
        digest: createHash('sha256').update(text).digest('hex').slice(0, 16),
        excerpt: text.length <= ANCHOR_EXCERPT_MAX ? text : `${text.slice(0, ANCHOR_EXCERPT_MAX)}…`,
    };
}
/** Model-facing text of one content block. */
function textBlock(text) {
    return { type: 'text', text };
}
/** Narrow one tool-argument value to a string, rejecting anything else. */
function parseString(raw, field) {
    /* v8 ignore next 2 -- the tool schema rejects non-string arguments before execute runs */
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`);
    }
    return raw;
}
/** Narrow one tool-argument value to a boolean, rejecting anything else. */
function parseBoolean(raw, field) {
    /* v8 ignore next 2 -- the tool schema rejects non-boolean arguments before execute runs */
    if (typeof raw !== 'boolean') {
        throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`);
    }
    return raw;
}
/** Validate the model-supplied verifier object against the declared protocol. */
function parseVerifier(raw) {
    /* v8 ignore next 2 -- the tool schema rejects a non-object verifier before execute runs */
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('lcrd_plan: 参数 verifier 必须是对象');
    }
    const record = raw;
    if (record.kind === 'assert') {
        const conditions = record.conditions;
        /* v8 ignore next 2 -- the tool schema rejects non-string-array conditions before execute runs */
        if (!Array.isArray(conditions) || !conditions.every(item => typeof item === 'string')) {
            throw new Error('lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组');
        }
        if (conditions.length === 0) {
            throw new Error('lcrd_plan: verifier.kind=assert 的 conditions 不能为空,至少需要一条断言表达式');
        }
        return { kind: 'assert', conditions };
    }
    if (record.kind === 'python') {
        const checks = record.checks;
        /* v8 ignore next 2 -- the tool schema rejects non-string-array checks before execute runs */
        if (!Array.isArray(checks) || !checks.every(item => typeof item === 'string')) {
            throw new Error('lcrd_plan: verifier.kind=python 需要 checks 为字符串数组');
        }
        if (checks.length === 0) {
            throw new Error('lcrd_plan: verifier.kind=python 的 checks 不能为空,至少需要一条检查表达式');
        }
        return { kind: 'python', checks };
    }
    /* v8 ignore start -- the tool schema rejects unknown verifier kinds before execute runs */
    if (record.kind === 'llm') {
        return { kind: 'llm' };
    }
    throw new Error(`lcrd_plan: 未知的 verifier kind: ${String(record.kind)}`);
    /* v8 ignore stop */
}
/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx, config) {
    const maxRetries = config.maxRetries;
    const pythonCommand = config.pythonCommand;
    const pythonTimeoutMs = config.pythonTimeoutMs;
    const verifierModel = config.verifierModel;
    const logDir = config.logDir;
    const interaction = config.interaction;
    const learningEnabled = config.learningEnabled;
    const learningThreshold = config.learningThreshold;
    const maxLearningAttempts = config.maxLearningAttempts;
    const learningToolSet = new Set(config.learningTools);
    const fileFlowEnabled = config.fileFlowEnabled;
    const fileFlowPathViolationsMax = config.fileFlowPathViolationsMax;
    const workspaceRoot = config.workspaceRoot;
    const fileFlowToolSet = new Set(config.fileFlowTools);
    const failedCheckConsumesRetry = config.failedCheckConsumesRetry;
    const datasetExport = config.datasetExport;
    const datasetDir = config.datasetDir ?? join(dirname(logDir ?? defaultLogDir()), 'dataset');
    /** The task-flow root: a sibling of the flow-log directory, so task context persists beside the logs. */
    const taskFlowRoot = join(dirname(config.logDir ?? defaultLogDir()), FILE_FLOW_DIR);
    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
        throw new Error('lcrd-hard-isolation: `maxRetries` must be an integer >= 1');
    }
    if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1000) {
        throw new Error('lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000');
    }
    if (!Number.isInteger(learningThreshold) || learningThreshold < 1) {
        throw new Error('lcrd-hard-isolation: `learningThreshold` must be an integer >= 1');
    }
    if (!Number.isInteger(maxLearningAttempts) || maxLearningAttempts < 1) {
        throw new Error('lcrd-hard-isolation: `maxLearningAttempts` must be an integer >= 1');
    }
    if (!Number.isInteger(fileFlowPathViolationsMax) || fileFlowPathViolationsMax < 1) {
        throw new Error('lcrd-hard-isolation: `fileFlowPathViolationsMax` must be an integer >= 1');
    }
    /** The attribution bundle: a configured module, or the log-heuristic default. */
    const attribution = config.attributionModule === undefined
        ? defaultAttribution
        : await loadAttribution(config.attributionModule);
    /** The policy hook: a configured module, or none (plain protocol). */
    const hooks = config.hooksModule === undefined
        ? undefined
        : await loadHooks(config.hooksModule);
    const plans = new WeakMap();
    const failures = new WeakMap();
    /** Policy-hook interceptions (deny / block / failing hook), bounded by `maxRetries` independently of the task budget. */
    const hookInterceptions = new WeakMap();
    /**
     * Executions whose own result already states a hook termination decided during
     * the tool body. The terminated guard must leave that specific message intact
     * on the terminating call; only later calls get the generic notice.
     */
    const hookTerminalExecutions = new WeakSet();
    /** The verdict the model last saw, so the next declaration records its decision context. */
    const lastVerdict = new WeakMap();
    /** Runs whose dataset export already happened, so disposal and exit never double-append. */
    const exportedAgents = new WeakSet();
    /** The model-visible transcript per session, for the exported DPO prompts. */
    const transcripts = new WeakMap();
    /** Failures in which the engine rejected the model's own check rather than the work. */
    const invalidChecks = new WeakMap();
    const terminated = new WeakSet();
    /** Per-agent learning-mode state: consumed rounds, the current phase, and whether a learning tool ran this round. */
    const learning = new WeakMap();
    /** Per-agent consecutive task-context path denials under the file-flow guard. */
    const pathViolations = new WeakMap();
    /** Per-agent file-flow launch gate: the pinned `task-flow/<task-slug>` directory, set by the first task-context access. */
    const taskDirs = new WeakMap();
    /** Executions denied by the file-flow guard; their results are final and never run the verifier. */
    const guardDenied = new WeakSet();
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
            recorder = new FlowRecorder(agent, maxRetries, {
                outDir: logDir,
                interaction,
                learningEnabled,
                learningThreshold,
                maxLearningAttempts,
                protocolVersion: PROTOCOL_VERSION,
                config,
                attribution,
            });
            flows.set(agent, recorder);
            sessionRecorders.set(agent.session, recorder);
            allRecorders.add(recorder);
            try {
                /* v8 ignore start -- repeated ensureFlow with a live approval service already set the policy */
                if (!policySet.has(agent)) {
                    setApprovalPolicy(agent.session, approvalPolicy);
                    policySet.add(agent);
                }
                /* v8 ignore stop */
            }
            catch { /* approval service absent — leave the default policy */ }
        }
        return recorder;
    }
    /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
    function flush(agent) {
        const recorder = flows.get(agent);
        /* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
        if (recorder) {
            try {
                recorder.dump();
            }
            catch { /* dump must not break the session */ }
        }
        /* v8 ignore stop */
    }
    /**
     * Append one tool event carrying the call identity, the argument summary, and
     * — when the call produced a result — the structured result projection, so an
     * assertion's referent is recorded beside the assertion's verdict.
     * @param owner - the executing agent that owns the recorder.
     * @param exec - the executing tool call.
     * @param result - the canonical result; omitted by the gate branches that
     *   decide before or without running a verifier.
     */
    function recordTool(owner, exec, result) {
        const summary = result === undefined ? undefined : summarizeResult(result);
        ensureFlow(owner).push({
            type: 'tool',
            name: exec.name,
            callId: String(exec.callId),
            argsSummary: summarizeArguments(exec.arguments),
            ...(summary === undefined ? {} : { resultKind: summary.kind, resultSummary: summary.summary }),
            ...(summary?.error === undefined ? {} : { errorMessage: summary.error }),
            ...(summary?.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
        });
    }
    /**
     * Record one policy-hook interception and count it. Hook interceptions are
     * bounded by `maxRetries` but never consume the task retry budget: they
     * measure the policy hook's decisions (and failures), not how the work met
     * its stop condition.
     * @param owner - the agent whose execution was intercepted.
     * @param kind - which hook interception the flow records.
     * @param detail - the hook's reason, recorded verbatim.
     * @returns the agent's interception count after this record.
     */
    function recordHookInterception(owner, kind, detail) {
        const count = (hookInterceptions.get(owner) ?? 0) + 1;
        hookInterceptions.set(owner, count);
        const recorder = ensureFlow(owner);
        recorder.push({ type: 'intercept', kind, detail });
        recorder.log(`[LCRD] ${kind} (${count}/${maxRetries}): ${detail}`);
        flush(owner);
        return count;
    }
    /**
     * Record the verdict the model will see next, and count the failures where
     * the engine rejected the model's own check rather than the work: those
     * measure the model's understanding of its own verification, not its success
     * at the task, so they are labeled apart from ordinary failures.
     * @param owner - the agent the verdict belongs to.
     * @param verdict - the normalized verifier outcome.
     * @param verifierKind - which verifier produced it.
     */
    function noteVerdict(owner, verdict, verifierKind) {
        lastVerdict.set(owner, { pass: verdict.pass, reason: verdict.reason, verifierKind });
        if (verdict.exceptionKind === 'invalid-condition' || verdict.exceptionKind === 'eval-error') {
            invalidChecks.set(owner, (invalidChecks.get(owner) ?? 0) + 1);
        }
        return invalidChecks.get(owner) ?? 0;
    }
    /**
     * What the model had just seen when it declared a plan: the failure count,
     * learning phase, the preceding verdict, and how often the engine had already
     * rejected its checks. Recorded so a declaration is a trainable sample on its
     * own, without joining the session log.
     * @param owner - the declaring agent.
     * @returns the recorded decision context.
     */
    function planContext(owner) {
        const previous = lastVerdict.get(owner);
        return {
            failures: failures.get(owner) ?? 0,
            phase: learning.get(owner)?.phase ?? 'normal',
            lastReason: previous === undefined ? null : clipSummary(previous.reason),
            lastPass: previous?.pass ?? null,
            lastVerifierKind: previous?.verifierKind ?? null,
            invalidChecks: invalidChecks.get(owner) ?? 0,
        };
    }
    /**
     * Create the agent's task-flow context directory directly (bypassing tool
     * sandboxes) and pin it. Named `taskflow-<uuid>` (the agent id without its
     * `session-` prefix) — deliberately different from the flow-log folder
     * naming, so the model never confuses the two; on collision an entropy
     * suffix disambiguates so tasks never overwrite each other. The directory
     * starts EMPTY: the model must create task.md / subtasks / progress.md in
     * it.
     * @param agent - the owning agent.
     * @returns the canonical pinned task directory.
     */
    async function ensureTaskDir(agent) {
        const agentUuid = agent.id.startsWith('session-') ? agent.id.slice('session-'.length) : agent.id;
        let dirName = `taskflow-${agentUuid}`;
        let dir = join(taskFlowRoot, dirName);
        if (existsSync(dir)) {
            dirName += `-${Date.now().toString(36).slice(-4)}`;
            dir = join(taskFlowRoot, dirName);
        }
        mkdirSync(dir, { recursive: true });
        const pinned = ctx.fs.processPath(await ctx.fs.resolve(dir));
        taskDirs.set(agent, pinned);
        return pinned;
    }
    // Rewrite the flow artifacts at every protocol step (plan declaration and
    // each verified tool result) so the exports stay current mid-turn, and
    // again after every completed turn — a long-lived surface must not wait for
    // disposal to materialize them.
    ctx.on('session/event', (session, event) => {
        // The transcript feeds the exported DPO prompts; it tracks every session
        // event, not only the turn boundary the dump uses.
        const state = transcripts.get(session) ?? { entries: [], planIndexByCallId: new Map() };
        trackTranscript(state, event);
        transcripts.set(session, state);
        if (event.type !== 'turn/end')
            return;
        const recorder = sessionRecorders.get(session);
        if (recorder) {
            /* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
            try {
                recorder.dump();
            }
            catch { /* dump must not break the session */ }
            /* v8 ignore stop */
        }
    });
    /**
     * Export one finished run into the dataset files: its rows plus the DPO pairs
     * built from the recorded declarations and the transcribed prompt. Runs once
     * per agent, after the final dump, and never throws into disposal.
     * @param agent - the agent whose run finished.
     */
    function exportRun(agent) {
        if (datasetExport !== 'run' || exportedAgents.has(agent))
            return;
        exportedAgents.add(agent);
        const recorder = flows.get(agent);
        if (recorder === undefined)
            return;
        /* v8 ignore start -- the export only fails on filesystem errors, which must not break disposal */
        try {
            const rows = recorder.datasetRows();
            const transcript = transcripts.get(agent.session);
            // The row carries the plan's `lcrd_plan` call id; the transcript maps that
            // call to its message, which is where the DPO prompt must stop.
            const planIndexByStep = new Map();
            if (transcript !== undefined) {
                for (const record of rows.records) {
                    if (record.type !== 'plan' || record.callId === undefined)
                        continue;
                    const index = transcript.planIndexByCallId.get(record.callId);
                    if (index !== undefined)
                        planIndexByStep.set(record.step, index);
                }
            }
            const pairs = transcript === undefined || planIndexByStep.size === 0
                ? []
                : dpoPairsForRun({
                    rows,
                    transcript: transcript.entries,
                    planIndexByStep,
                    runId: String(agent.id),
                });
            appendDatasetRows(datasetDir, rows, pairs);
            ensureDatasetFiles(datasetDir);
            recorder.log(`[LCRD] dataset export: ${rows.records.length} rows, ${pairs.length} DPO pairs -> ${datasetDir}`);
        }
        catch { /* the export must never break disposal */ }
        /* v8 ignore stop */
    }
    // Final flush as soon as the agent is disposed, whichever session/scope it
    // lives in. The global event carries the agent in its payload, so this
    // fires reliably for every session in a long-running process (unlike the
    // per-agent scoped listener). dump() rewrites the latest snapshot.
    ctx.on('agent/disposed', ({ agent }) => {
        const recorder = flows.get(agent);
        if (recorder) {
            /* v8 ignore start -- dump fails only on filesystem errors, which must not break disposal */
            try {
                recorder.dump();
            }
            catch { /* dump must not break disposal */ }
            /* v8 ignore stop */
        }
        // After the final dump, so the exported rows see the same events as the artifacts.
        exportRun(agent);
    });
    // Long-running surfaces dispose the agent (agent/disposed above); the
    // one-shot headless profile exits the process instead, so exit flushes too.
    /* v8 ignore next -- a process-exit handler cannot be driven from an in-process test */
    process.once('exit', () => {
        for (const recorder of allRecorders) {
            try {
                recorder.dump();
            }
            catch { /* exit must not fail the session */ }
        }
    });
    registerAnchorSection(ctx);
    // File-backed task flow is opt-in for minimal deployments: the model keeps
    // the task breakdown and progress on disk through bash/str_replace_editor.
    // Standard deployments leave it off and keep the plain in-context flow.
    let fsWorkRoot = '';
    /**
     * The workspace root for one agent: explicit config, the session's
     * validated cwd, the deployment's sandbox workspace root (the authoritative
     * workspace-write boundary), DSH_CWD, then the fs root.
     */
    const resolveWorkRoot = (agent) => {
        const sandboxRoot = ctx.get('sandboxPolicy')?.workspaceRoot;
        return workspaceRoot ?? agent?.session.header.cwd ?? sandboxRoot ?? process.env.DSH_CWD ?? fsWorkRoot;
    };
    if (fileFlowEnabled) {
        // Resolve the fs backend's own working root once as the final fallback;
        // the harness's validated session cwd takes precedence via the
        // per-agent provider, so the model places task products in the chosen
        // workspace instead of a guessed alias such as /repo.
        void ctx.fs.resolve('.').then((target) => { fsWorkRoot = ctx.fs.processPath(target); }, 
        /* v8 ignore next 2 -- the fs root is unresolvable only when the backend fails */
        () => { });
        registerFileFlowSection(ctx, taskFlowRoot, resolveWorkRoot);
    }
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
                    conditions: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'kind=assert: 每条断言是 JS 表达式,可作用于 result(结构化值)/content(渲染文本)/isError,至少引用其一;对所有探测输入恒真判"缺少区分度"失败;工具执行失败直接判 FAIL;全部为真才通过;列表不得为空',
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
            const agent = exec.agent;
            if (!agent)
                throw new Error('lcrd_plan requires an agent-scoped execution');
            const declared = {
                goal: parseString(args.goal, 'goal'),
                stop_condition: parseString(args.stop_condition, 'stop_condition'),
                feasibility: parseBoolean(args.feasibility, 'feasibility'),
                verifier: parseVerifier(args.verifier),
            };
            const callId = String(exec.callId);
            // The policy hook runs on the completed declaration. A replacement plan is
            // silent to the model — the result text below still echoes the declaration —
            // while LCRD stores and verifies with the effective plan.
            let plan = declared;
            if (hooks?.checkPlan) {
                let decision;
                try {
                    decision = await hooks.checkPlan({ agent, plan: declared, callId, signal: exec.signal });
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    const count = recordHookInterception(agent, 'hook-error', `checkPlan: ${reason}`);
                    if (count >= maxRetries) {
                        terminated.add(agent);
                        hookTerminalExecutions.add(exec);
                        throw new Error(`[LCRD] 策略检查连续异常 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`);
                    }
                    throw error;
                }
                if (decision.kind === 'deny') {
                    const count = recordHookInterception(agent, 'hook-denied', decision.reason);
                    // The denial must invalidate any earlier plan: otherwise the previous
                    // declaration would keep governing the next tool result.
                    plans.delete(agent);
                    if (count >= maxRetries) {
                        terminated.add(agent);
                        hookTerminalExecutions.add(exec);
                        throw new Error(`[LCRD] 子任务声明连续被外部策略拒绝 ${count} 次,任务已终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`);
                    }
                    throw new Error(`[LCRD] 子任务声明被外部策略拒绝: ${decision.reason}。请调整目标或方法后重新调用 lcrd_plan。`);
                }
                if (decision.kind === 'modify') {
                    if (!isStepPlan(decision.plan)) {
                        plans.delete(agent);
                        throw new Error('hooks module checkPlan returned a malformed plan: goal, stop_condition, feasibility, and a verifier with a non-empty expression list are required');
                    }
                    plan = decision.plan;
                }
            }
            plans.set(agent, plan);
            const recorder = ensureFlow(agent);
            recorder.push({ type: 'plan', goal: plan.goal, stop: plan.stop_condition, feasibility: plan.feasibility, verifier: plan.verifier.kind, verifierSpec: plan.verifier, context: planContext(agent), callId });
            recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`);
            if (fileFlowEnabled && taskDirs.get(agent) === undefined) {
                /* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
                try {
                    const taskDir = await ensureTaskDir(agent);
                    recorder.log(`[LCRD] task dir auto-created: ${taskDir}`);
                    flush(agent);
                    return `计划已记录: 目标="${declared.goal}"。任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。下一步工具结果将由 ${declared.verifier.kind} 校验器独立验证。`;
                }
                catch {
                    // Task-dir creation failed; continue on the plain rollback flow.
                }
                /* v8 ignore stop */
            }
            flush(agent);
            return `计划已记录: 目标="${declared.goal}"。下一步工具结果将由 ${declared.verifier.kind} 校验器独立验证。`;
        },
    }));
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
                const agent = exec.agent;
                if (!agent)
                    throw new Error('lcrd_learn requires an agent-scoped execution');
                /* jscpd:ignore-end */
                const state = learning.get(agent);
                if (!state)
                    throw new Error('lcrd_learn 只能在学习模式(连续校验失败达到阈值)下调用');
                const declaration = {
                    problem_analysis: parseString(args.problem_analysis, 'problem_analysis'),
                    knowledge_needed: parseString(args.knowledge_needed, 'knowledge_needed'),
                    learning_method: parseString(args.learning_method, 'learning_method'),
                    eval_criteria: parseString(args.eval_criteria, 'eval_criteria'),
                };
                state.phase = 'learn';
                state.evidence = false;
                const recorder = ensureFlow(agent);
                recorder.push({
                    type: 'learn',
                    analysis: declaration.problem_analysis,
                    knowledge: declaration.knowledge_needed,
                    method: declaration.learning_method,
                    criteria: declaration.eval_criteria,
                });
                recorder.log(`[LCRD] learn: problem="${declaration.problem_analysis}" knowledge="${declaration.knowledge_needed}" method="${declaration.learning_method}"`);
                flush(agent);
                return `学习轮次已记录: 问题="${declaration.problem_analysis}"。现在使用学习工具获取知识,完成后调用 lcrd_learn_verify 自评。`;
            },
        }));
        ctx.tools.register(defineTool({
            name: 'lcrd_learn_verify',
            description: 'Self-evaluate one learning round against the criteria declared in lcrd_learn: whether the knowledge has been acquired and the evidence. A failed self-evaluation consumes one learning attempt; when attempts are exhausted the task terminates for human review. A passed one switches to re-solving the original task, whose tool results still run the exogenous verifier.',
            parameters: {
                learned: { type: 'boolean', required: true, description: '是否认为自己已学会所需知识' },
                evidence: { type: 'string', required: true, description: '自评依据:如何用声明的评价标准判断' },
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
                const agent = exec.agent;
                if (!agent)
                    throw new Error('lcrd_learn_verify requires an agent-scoped execution');
                /* jscpd:ignore-end */
                const state = learning.get(agent);
                if (!state)
                    throw new Error('lcrd_learn_verify 只能在学习模式(连续校验失败达到阈值)下调用');
                const verdict = {
                    learned: parseBoolean(args.learned, 'learned'),
                    evidence: parseString(args.evidence, 'evidence'),
                };
                const recorder = ensureFlow(agent);
                if (!verdict.learned) {
                    state.attempts += 1;
                    recorder.push({ type: 'learn-verify', learned: false, evidence: verdict.evidence, count: state.attempts });
                    recorder.log(`[LCRD] learn FAIL (${state.attempts}/${maxLearningAttempts}): ${verdict.evidence}`);
                    flush(agent);
                    if (state.attempts >= maxLearningAttempts) {
                        terminated.add(agent);
                        const terminal = `[LCRD] 自评未通过且学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.evidence}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
                        return terminal;
                    }
                    return `自评未通过(第 ${state.attempts}/${maxLearningAttempts} 轮): ${verdict.evidence}。请再次调用 lcrd_learn 分析问题,继续学习并重新自评。`;
                }
                if (!state.evidence) {
                    return `自评不能通过:本轮尚未调用任何学习工具(${[...learningToolSet].join(', ')})。请先使用学习工具获取知识,再重新自评。`;
                }
                state.phase = 'resolve';
                recorder.push({ type: 'learn-verify', learned: true, evidence: verdict.evidence });
                recorder.log(`[LCRD] learn PASS: ${verdict.evidence} → 进入重解阶段`);
                flush(agent);
                return '自评通过。请重新声明 lcrd_plan 并执行工具解决原任务;重解结果仍由外生校验器验证,通过即任务完成并重置学习次数。';
            },
        }));
    }
    // A new user command is a fresh task boundary: reset the failure count, the
    // learning budget, and any termination so the model may retry the new task
    // from scratch. Plugin-injected notices carry `source.kind: 'plugin'` and
    // never reset; only real user input does.
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
        const userMessage = messages.find(message => message.source.kind === 'user');
        if (userMessage !== undefined) {
            // A fresh task must re-declare its plan: a stale plan from an earlier
            // command would otherwise gate the new task's first tool result.
            const anchor = anchorIdentityOf(userMessage);
            ensureFlow(agent).markAnchorDigest(anchor.digest, anchor.excerpt);
            plans.delete(agent);
            failures.delete(agent);
            learning.delete(agent);
            lastVerdict.delete(agent);
            invalidChecks.delete(agent);
            hookInterceptions.delete(agent);
            pathViolations.delete(agent);
            taskDirs.delete(agent);
            if (terminated.has(agent)) {
                ensureFlow(agent).log('[LCRD] user command: termination reset for a new task');
                terminated.delete(agent);
            }
        }
        return next();
    });
    // File-flow guard: while `fileFlowEnabled` is on, hard isolation applies
    // only to the task context under `<task-flow root>/task-flow/`, a sibling
    // of the flow-log directory. The plugin creates the task directory itself
    // (log-style name, bypassing tool sandboxes) and pins it: the first file
    // operation of a guarded tool triggers creation and is denied with
    // guidance naming the directory, so the model creates task.md / subtasks /
    // progress.md there first. Afterwards every path under task-flow/ must stay
    // inside the pinned directory — reading or writing another task’s context
    // or the bare flow root is denied and counted, and reaching
    // `fileFlowPathViolationsMax` terminates the task as severe hallucination.
    // Paths outside task-flow/ pass through unguarded. Paths are canonicalized
    // through the fs seam itself (realpath ancestors, Windows drive-letter
    // case, symlinks, not-yet-created files), so the guard and the file tools
    // always compare the same resolved identity. Guarded tools are the
    // `fileFlowTools` set (default `str_replace_editor`, `write`, `edit`);
    // shell commands are not checked.
    ctx.on('tools/pre-execute', async (exec, next) => {
        const agent = exec.agent;
        if (!agent || !fileFlowEnabled || !fileFlowToolSet.has(exec.name))
            return next();
        const rawPath = exec.arguments.path;
        if (typeof rawPath !== 'string' || rawPath.length === 0)
            return next();
        /* v8 ignore start -- a path both the guard and the file tool resolve through the same fs seam, which surfaces its own errors */
        let flowRoot;
        let target;
        try {
            const fs = ctx.fs;
            flowRoot = fs.processPath(await fs.resolve(taskFlowRoot, { signal: exec.signal }));
            target = fs.processPath(await fs.resolve(rawPath, { signal: exec.signal }));
        }
        catch {
            // Unresolvable path: let the tool surface the real error.
            return next();
        }
        /* v8 ignore stop */
        // Launch gate: before the task directory is pinned, create it directly
        // (plugin-owned, so sandboxes and model naming cannot block it) and deny
        // this first file operation with guidance. The denial is guidance, not a
        // counted violation.
        const pinned = taskDirs.get(agent);
        if (pinned === undefined) {
            let taskDir;
            /* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
            try {
                taskDir = await ensureTaskDir(agent);
            }
            catch {
                // Task-dir creation failed: let the tool surface its own error.
                return next();
            }
            /* v8 ignore stop */
            guardDenied.add(exec);
            const recorder = ensureFlow(agent);
            recorder.log(`[LCRD] file-flow launch gate: tool=${exec.name} path=${rawPath} denied (task dir auto-created: ${taskDir})`);
            flush(agent);
            const workRoot = resolveWorkRoot(agent);
            /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
            return {
                kind: 'deny',
                reason: `[LCRD] 任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在本任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。当前路径 ${rawPath} 不在任务目录内;当前工作目录为 ${workRoot.length > 0 ? workRoot : '(未解析)'}。`,
            };
        }
        const classification = classifyFlowPath(flowRoot, pinned, target);
        /* v8 ignore next -- flowRoot, bootstrap, and the exhaustive default are unreachable once pinned */
        switch (classification.kind) {
            case 'outside': {
                // Product containment: after the bootstrap, mutations of the guarded
                // file tools must land inside the workspace — the model’s instructions
                // are all workspace-relative, so a product elsewhere is misplaced.
                // Reads (view) stay free anywhere. Flow files are never here (they
                // live in the pinned task directory).
                const isMutation = exec.name === 'write' || exec.name === 'edit'
                    || (exec.name === 'str_replace_editor'
                        && exec.arguments.command !== 'view');
                const workRoot = resolveWorkRoot(agent);
                /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
                if (isMutation && workRoot.length > 0) {
                    let workRootKey = '';
                    try {
                        workRootKey = ctx.fs.processPath(await ctx.fs.resolve(workRoot, { signal: exec.signal }));
                    }
                    catch {
                        // Unresolvable workspace root: skip containment for this call.
                    }
                    const inside = workRootKey.length > 0
                        && (target === workRootKey || target.startsWith(`${workRootKey}${sep}`));
                    if (!inside) {
                        guardDenied.add(exec);
                        const recorder = ensureFlow(agent);
                        recorder.log(`[LCRD] file-flow workspace containment denied: tool=${exec.name} path=${rawPath} (outside workspace)`);
                        flush(agent);
                        return {
                            kind: 'deny',
                            reason: `[LCRD] 任务产物必须写入工作区: ${workRoot}。当前路径 ${rawPath} 在工作区之外。请将任务产物(脚本、代码、数据文件)创建在工作区内,使用绝对路径;工作区之外的文件写入会被外部引擎拒绝。`,
                        };
                    }
                }
                // 任务上下文之外不拦截
                return next();
            }
            case 'own': {
                // Flow-file whitelist: the task directory holds only the context
                // files; task products (scripts, code, data) belong in the workspace.
                const relative = target.slice(pinned.length + sep.length);
                const isFlowFile = relative === ''
                    || relative === 'task.md'
                    || relative === 'progress.md'
                    || relative === 'subtasks'
                    || relative.startsWith(`subtasks${sep}`);
                if (!isFlowFile) {
                    guardDenied.add(exec);
                    const recorder = ensureFlow(agent);
                    recorder.log(`[LCRD] file-flow product-in-task-dir denied: tool=${exec.name} path=${rawPath} (task dir holds flow files only)`);
                    flush(agent);
                    const workRoot = resolveWorkRoot(agent);
                    /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
                    return {
                        kind: 'deny',
                        reason: `[LCRD] 任务目录只存放流程文件(task.md、subtasks/*.md、progress.md);任务产物(脚本、代码、数据文件)必须创建在工作区 ${workRoot.length > 0 ? workRoot : '(见工作目录行)'},不得写入任务目录。`,
                    };
                }
                return next();
            }
            case 'flowRoot':
            case 'foreign':
            case 'bootstrap': {
                // Unreachable with a pinned task directory: the classifier only
                // reports bootstrap before pinning. Kept for exhaustiveness; denied
                // like foreign if it ever fires.
                guardDenied.add(exec);
                const count = (pathViolations.get(agent) ?? 0) + 1;
                pathViolations.set(agent, count);
                const recorder = ensureFlow(agent);
                recorder.log(`[LCRD] file-flow path violation (${count}/${fileFlowPathViolationsMax}): tool=${exec.name} path=${rawPath}`);
                recordTool(agent, exec);
                recorder.push({ type: 'intercept', kind: 'missing-plan', detail: `path outside the task context: ${rawPath}` });
                flush(agent);
                if (count >= fileFlowPathViolationsMax) {
                    terminated.add(agent);
                    const terminal = `[LCRD] 任务上下文路径连续越界 ${count} 次,幻觉严重,任务已终止转人工: ${rawPath}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
                    return {
                        kind: 'deny',
                        reason: terminal,
                    };
                }
                return {
                    kind: 'deny',
                    reason: `[LCRD] 任务上下文越界(第 ${count}/${fileFlowPathViolationsMax} 次): ${rawPath}。${FILE_FLOW_DIR}/ 内只能读写引擎自动创建的本任务目录;其他任务的目录与 ${FILE_FLOW_DIR}/ 根目录均禁止访问。需要读写 ${FILE_FLOW_DIR}/ 之外的文件不受此限制。请重新使用正确路径。`,
                };
            }
            default:
                return assertNever(classification);
        }
    });
    // The rollback symbol: after every tool execution, verify the result against
    // the declared plan and reject it with corrective feedback on failure. When
    // learning is enabled, consecutive failures at or above the threshold enter
    // learning mode instead of plain rollback, and a failed post-learning
    // re-solve consumes one learning attempt.
    ctx.on('tools/post-execute', async (exec, result, next) => {
        if (!exec.agent)
            return next();
        const agent = exec.agent;
        // A result already denied by the file-flow guard is final: accept it as-is
        // so the denial reason reaches the model, and no verifier retry is
        // consumed (the denial already counted against the path-violation cap).
        if (guardDenied.has(exec))
            return next();
        // A policy hook terminated the task from inside this call's own body, so its
        // specific terminal message is the result: do not replace it with the guard.
        if (hookTerminalExecutions.has(exec))
            return next();
        if (terminated.has(agent)) {
            ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`);
            recordTool(agent, exec);
            ensureFlow(agent).push({ type: 'intercept', kind: 'terminated', detail: '任务已终止,后续工具调用被拦截' });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock('[LCRD] 任务已终止,等待人工介入。停止所有工具调用,向用户报告失败情况。')],
            };
        }
        const learningState = learning.get(agent);
        // Protocol tools are managed by their own execute handlers; they never
        // run the verifier. In the learn phase, declaring a task plan is blocked
        // until a learning round is declared and self-evaluated.
        if (exec.name === 'lcrd_plan' || exec.name === 'lcrd_learn' || exec.name === 'lcrd_learn_verify') {
            if (learningState && learningState.phase === 'learn' && exec.name === 'lcrd_plan') {
                ensureFlow(agent).log('[LCRD] learn phase: tool=lcrd_plan blocked (must declare learning first)');
                recordTool(agent, exec);
                ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: 'lcrd_plan during learn phase' });
                flush(agent);
                return {
                    kind: 'block',
                    feedback: [textBlock('[LCRD] 学习阶段禁止声明任务计划。请先调用 lcrd_learn 声明学习轮次,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后才能重新声明 lcrd_plan 重解任务。')],
                    additionalContexts: [createUserMessage({
                            content: [textBlock('[LCRD] 当前处于学习阶段:先完成 lcrd_learn → 学习工具 → lcrd_learn_verify,再重解任务。')],
                            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learn phase plan blocked' },
                        })],
                };
            }
            return next();
        }
        // In unattended ('auto') mode no human is available: auto-answer an agent
        // that tries to ask the user, instead of blocking on a plan or waiting.
        // Checked before the learning gate so a learn-phase question keeps the
        // existing auto-answer semantics instead of a new interception.
        if (interaction === 'auto' && exec.name === 'ask_user_question') {
            const recorder = ensureFlow(agent);
            recorder.markAskIntercepted();
            recorder.log('[LCRD] auto-answer: tool=ask_user_question blocked (unattended)');
            recordTool(agent, exec);
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
        // Learn phase: knowledge-acquisition tools pass without a plan or verifier;
        // every other tool is blocked until the round is self-evaluated.
        if (learningState && learningState.phase === 'learn') {
            if (learningToolSet.has(exec.name)) {
                learningState.evidence = true;
                recordTool(agent, exec);
                ensureFlow(agent).log(`[LCRD] learn tool: ${exec.name} passed`);
                flush(agent);
                return next();
            }
            ensureFlow(agent).log(`[LCRD] learn phase: tool=${exec.name} blocked (not a learning tool)`);
            recordTool(agent, exec);
            ensureFlow(agent).push({ type: 'intercept', kind: 'missing-plan', detail: `${exec.name} during learn phase` });
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock(`[LCRD] 学习阶段仅允许学习工具(${[...learningToolSet].join(', ')})。请使用它们获取知识,然后调用 lcrd_learn_verify 自评;禁止执行任务工具。`)],
                additionalContexts: [createUserMessage({
                        content: [textBlock(`[LCRD] 工具 ${exec.name} 被拦截:学习阶段仅允许学习工具。先完成学习与自评,再重解任务。`)],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learn phase tool blocked' },
                    })],
            };
        }
        const plan = plans.get(agent);
        if (!plan) {
            ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`);
            recordTool(agent, exec);
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
            recordTool(agent, exec);
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
        recordTool(agent, exec, result);
        // The policy hook inspects the verified result. It may reject the result
        // with corrective feedback or terminate the task; neither consumes the task
        // retry budget, and both are bounded by `maxRetries` interceptions.
        if (hooks?.checkResult) {
            let decision;
            try {
                decision = await hooks.checkResult({
                    agent,
                    plan,
                    tool: exec.name,
                    callId: String(exec.callId),
                    result,
                    verdict,
                    signal: exec.signal,
                });
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                const count = recordHookInterception(agent, 'hook-error', `checkResult: ${reason}`);
                if (count >= maxRetries) {
                    terminated.add(agent);
                    const terminal = `[LCRD] 策略检查连续异常 ${count} 次,任务已终止转人工: ${reason}。停止所有工具调用,向用户报告失败原因。`;
                    return {
                        kind: 'block',
                        feedback: [textBlock(terminal)],
                        additionalContexts: [createUserMessage({
                                content: [textBlock(terminal)],
                                source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd hook error exhausted' },
                            })],
                    };
                }
                throw error;
            }
            if (decision.kind === 'block') {
                const count = recordHookInterception(agent, 'hook-blocked', decision.reason);
                if (count >= maxRetries) {
                    terminated.add(agent);
                    const terminal = `[LCRD] 工具结果连续被外部策略拒绝 ${count} 次,任务已终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`;
                    return {
                        kind: 'block',
                        feedback: [textBlock(terminal)],
                        additionalContexts: [createUserMessage({
                                content: [textBlock(terminal)],
                                source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd hook blocked exhausted' },
                            })],
                    };
                }
                const notice = `[LCRD] 工具结果被外部策略拒绝(第 ${count}/${maxRetries} 次,不消耗任务重试预算): ${decision.reason}。请调整方法或参数后重新声明 lcrd_plan。`;
                return {
                    kind: 'block',
                    feedback: [textBlock(notice)],
                    additionalContexts: [createUserMessage({
                            content: [textBlock(`[LCRD] 外部策略拒绝工具结果: ${decision.reason}`)],
                            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd hook result blocked' },
                        })],
                };
            }
            if (decision.kind === 'terminate') {
                recordHookInterception(agent, 'hook-terminated', decision.reason);
                terminated.add(agent);
                const terminal = `[LCRD] 任务被外部策略终止转人工: ${decision.reason}。停止所有工具调用,向用户报告失败原因。`;
                return {
                    kind: 'block',
                    feedback: [textBlock(terminal)],
                    additionalContexts: [createUserMessage({
                            content: [textBlock(terminal)],
                            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd hook terminated' },
                        })],
                };
            }
        }
        if (verdict.pass) {
            noteVerdict(agent, verdict, plan.verifier.kind);
            ensureFlow(agent).push({
                type: 'verdict',
                pass: true,
                reason: verdict.reason,
                verifierKind: plan.verifier.kind,
                callId: String(exec.callId),
                tool: exec.name,
            });
            failures.delete(agent);
            // A post-learning re-solve that passes completes the task and resets the
            // learning budget; the plain path stays untouched.
            const passedState = learning.get(agent);
            if (passedState) {
                ensureFlow(agent).push({ type: 'learn-verify', learned: true, evidence: `重解通过: ${verdict.reason}`, count: passedState.attempts });
                ensureFlow(agent).markLearningSuccess();
                ensureFlow(agent).log(`[LCRD] learning success: re-solve PASS after ${passedState.attempts} learning attempt(s), learning budget reset`);
                learning.delete(agent);
            }
            ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
            flush(agent);
            return next();
        }
        const failedCheck = verdict.exceptionKind === 'invalid-condition' || verdict.exceptionKind === 'eval-error';
        // A failed check is the engine rejecting the model's own verification, not a
        // failed task step. Which budget it consumes is a deployment choice: the
        // default keeps the historical behaviour (the task budget), and switching it
        // off bounds the invalid checks by their own count instead.
        const checkOnly = failedCheck && !failedCheckConsumesRetry;
        const count = checkOnly ? (failures.get(agent) ?? 0) : (failures.get(agent) ?? 0) + 1;
        if (!checkOnly)
            failures.set(agent, count);
        const invalidCount = noteVerdict(agent, verdict, plan.verifier.kind);
        ensureFlow(agent).push({
            type: 'verdict',
            pass: false,
            reason: verdict.reason,
            count,
            verifierKind: plan.verifier.kind,
            callId: String(exec.callId),
            tool: exec.name,
            ...(verdict.exceptionKind === undefined ? {} : { exceptionKind: verdict.exceptionKind }),
        });
        if (verdict.exception === true)
            ensureFlow(agent).markVerifierException();
        ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
        if (checkOnly) {
            if (invalidCount >= maxRetries) {
                terminated.add(agent);
                const terminal = `[LCRD] 连续 ${maxRetries} 次断言被引擎判为无效,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
                return {
                    kind: 'block',
                    feedback: [textBlock(terminal)],
                    additionalContexts: [createUserMessage({
                            content: [textBlock(terminal)],
                            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd invalid checks exhausted' },
                        })],
                };
            }
            const notice = `[LCRD] 断言被引擎判为无效(第 ${invalidCount}/${maxRetries} 次,不消耗任务重试预算): ${verdict.reason}。请修正检查本身(类型引用、区分度),再声明计划重试。`;
            return {
                kind: 'block',
                feedback: [textBlock(notice)],
                additionalContexts: [createUserMessage({
                        content: [textBlock(`[LCRD] 无效断言: ${verdict.reason}`)],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd invalid check' },
                    })],
            };
        }
        // Learning trigger: consecutive failures reach the threshold while
        // learning is enabled and no round is open yet. Direct retries pause in
        // favor of the learning protocol; maxRetries termination is suspended
        // until the learning budget is exhausted.
        if (learningEnabled && !learning.has(agent) && count >= learningThreshold) {
            learning.set(agent, { attempts: 0, phase: 'learn', evidence: false });
            const notice = `[LCRD] 连续 ${count} 次校验失败,达到学习阈值(${learningThreshold}),进入学习模式(最多 ${maxLearningAttempts} 轮)。停止直接重试:先调用 lcrd_learn 分析问题与所需知识,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后重新声明 lcrd_plan 重解任务。`;
            flush(agent);
            return {
                kind: 'block',
                feedback: [textBlock(notice)],
                additionalContexts: [createUserMessage({
                        content: [textBlock(notice)],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning mode entered' },
                    })],
            };
        }
        // A post-learning re-solve failure consumes one learning attempt and
        // returns to the learn phase with the verifier reason injected for the
        // next round's analysis; exhausted attempts terminate to human.
        const activeLearning = learning.get(agent);
        if (activeLearning) {
            activeLearning.attempts += 1;
            ensureFlow(agent).push({ type: 'learn-verify', learned: false, evidence: verdict.reason, count: activeLearning.attempts });
            ensureFlow(agent).log(`[LCRD] learning round FAIL (${activeLearning.attempts}/${maxLearningAttempts}): ${verdict.reason}`);
            if (activeLearning.attempts >= maxLearningAttempts) {
                terminated.add(agent);
                const terminal = `[LCRD] 学习后重解仍失败,学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
                return {
                    kind: 'block',
                    feedback: [textBlock(terminal)],
                    additionalContexts: [createUserMessage({
                            content: [textBlock(terminal)],
                            source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning exhausted' },
                        })],
                };
            }
            activeLearning.phase = 'learn';
            activeLearning.evidence = false;
            const notice = `[LCRD] 学习后重解仍失败(第 ${activeLearning.attempts}/${maxLearningAttempts} 轮): ${verdict.reason}。回到学习模式:调用 lcrd_learn 结合本次失败原因重新分析,继续学习并重新自评。`;
            return {
                kind: 'block',
                feedback: [textBlock(notice)],
                additionalContexts: [createUserMessage({
                        content: [textBlock(`[LCRD] 重解失败原因(供新一轮学习分析): ${verdict.reason}`)],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'lcrd learning round failed' },
                    })],
            };
        }
        if (count >= maxRetries) {
            terminated.add(agent);
            const terminal = `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
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