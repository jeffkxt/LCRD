import z from "@deepseek-ai/schemastery";
import { createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
//#region lib/types/anchor.js
const PROTOCOL_SECTION_NAME = "lcrd-hard-isolation";
/** The protocol text; also injected into LLM verifier prompts as the anchor against which results are judged. */
const PROTOCOL_TEXT = `[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result,必须引用 result 且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
5. 根锚内部存在矛盾时,你可以在顶层边界之内权衡;任何输出不得违背根锚约束。`;
/**
* Register the protocol section in the calling context's scope. Order 200
* places it after tool guidance (100-199) and before later context.
* @param ctx - plugin context; the registration is disposed with it.
*/
function registerAnchorSection(ctx) {
	ctx.systemPrompt.section({
		name: PROTOCOL_SECTION_NAME,
		order: 200,
		text: PROTOCOL_TEXT
	});
}
//#endregion
//#region lib/types/flow.js
/**
* LCRD execution-flow recorder: every protocol event (plan, tool, verdict,
* intercept) is appended in order, and the flow artifacts — a Mermaid
* flowchart (viewable in VS Code, GitHub, mermaid.live), a Markdown report,
* and a raw JSON transcript — are rewritten after every completed turn, on
* agent disposal, and on process exit, so they stay fresh while the agent
* lives.
*/
/** Walk up from this module to the nearest directory owning a `package.json`. */
function packageRoot() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return dir;
		dir = parent;
	}
}
/** Default log directory: a `lcrd-flow` folder inside the plugin package. */
function defaultLogDir() {
	return join(packageRoot(), "lcrd-flow");
}
/** Make a filesystem-safe, human-readable task slug. */
function slugify(text) {
	const cleaned = text.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim();
	return cleaned.length === 0 ? "" : cleaned.slice(0, 60);
}
/** Stable 8-hex suffix from an agent id, disambiguating same-slug task folders. */
function shortAgentId(id) {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i += 1) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
/** Escape node text for Mermaid syntax. */
function mermaidEscape(text) {
	return text.replace(/"/g, "#quot;").replace(/\(/g, "#40;").replace(/\)/g, "#41;").replace(/\[/g, "#91;").replace(/\]/g, "#93;").replace(/\|/g, "#124;").replace(/</g, "#60;").replace(/>/g, "#62;");
}
/** Clip long event text to keep the flowchart readable. */
function clip(text, max) {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
/** In-order recorder for one agent's whole session (one task), one subfolder per agent. */
var FlowRecorder = class {
	events = [];
	agentId;
	maxRetries;
	outDir;
	interaction;
	tbFinalReward;
	rootCauseHint;
	taskSlug;
	taskLabeled = false;
	logOpened = false;
	taskDirName;
	goalChanged = 0;
	stopChanged = 0;
	verifierChanged = 0;
	askIntercepted = false;
	verifierException = false;
	retryConsumed = 0;
	hasAnyVerdict = false;
	lastPass = false;
	/** @param agent - the session owner; its id disambiguates the output files. */
	/** @param maxRetries - the configured failure budget, shown on FAIL verdicts. */
	/** @param options - artifact directory (defaults to the plugin folder), task slug, and meta inputs. */
	constructor(agent, maxRetries, options) {
		this.agentId = String(agent.id);
		this.maxRetries = maxRetries;
		this.outDir = options?.outDir ?? defaultLogDir();
		this.taskSlug = options?.taskSlug ?? this.agentId;
		this.interaction = options?.interaction ?? "manual";
		this.tbFinalReward = options?.tbFinalReward ?? null;
		this.rootCauseHint = options?.rootCauseHint ?? null;
	}
	/**
	* The per-task artifact subfolder. Named after the goal slug plus a stable
	* agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
	* agents with the same goal never collide; without a goal it falls back to
	* the agent id. Fixed at the first write so early events and later events
	* always land in the same folder.
	*/
	taskDir() {
		if (this.taskDirName === void 0) this.taskDirName = this.taskSlug !== this.agentId ? `${this.taskSlug}-${shortAgentId(this.agentId)}` : this.agentId;
		return join(this.outDir, this.taskDirName);
	}
	/** Append one event; artifacts are rewritten per turn, on disposal, and on process exit. */
	push(event) {
		if (event.type === "plan") {
			if (!this.taskLabeled) {
				const slug = slugify(event.goal);
				if (slug) {
					this.taskSlug = slug;
					this.taskLabeled = true;
				}
			}
			this.trackPlanChange(event);
		} else if (event.type === "verdict") {
			this.hasAnyVerdict = true;
			this.lastPass = event.pass;
			if (event.count !== void 0) this.retryConsumed = event.count;
		} else if (event.type === "intercept" && event.kind === "terminated") this.retryConsumed = this.maxRetries;
		this.events.push(event);
	}
	/** Compare a newly declared plan against the previous one, counting contract drift. */
	trackPlanChange(event) {
		let previous;
		for (let i = this.events.length - 1; i >= 0; i -= 1) {
			const candidate = this.events[i];
			if (candidate !== void 0 && candidate.type === "plan") {
				previous = candidate;
				break;
			}
		}
		if (!previous || previous.type !== "plan") return;
		if (previous.goal !== event.goal) this.goalChanged += 1;
		if (previous.stop !== event.stop) this.stopChanged += 1;
		const specA = previous.verifierSpec ?? previous.verifier;
		const specB = event.verifierSpec ?? event.verifier;
		if (JSON.stringify(specA) !== JSON.stringify(specB)) this.verifierChanged += 1;
	}
	/** Record that an `ask_user_question` was auto-intercepted in unattended mode. */
	markAskIntercepted() {
		this.askIntercepted = true;
	}
	/** Record that a verifier failure was an exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
	markVerifierException() {
		this.verifierException = true;
	}
	/** Compute the machine-readable summary from the recorded state. */
	computeMeta() {
		const finalVerdict = this.events.some((event) => event.type === "intercept" && event.kind === "terminated") ? "terminated" : this.hasAnyVerdict ? this.lastPass ? "pass" : "fail" : "fail";
		return {
			session_id: this.agentId,
			task_id: this.taskSlug,
			md_file: "lcrd-flow.md",
			human_interaction_mode: this.interaction,
			hit_ask_intercepted: this.askIntercepted,
			lcrd_retry_consumed: this.retryConsumed,
			lcrd_retry_max: this.maxRetries,
			goal_changed_times: this.goalChanged,
			stop_changed_times: this.stopChanged,
			verifier_changed_times: this.verifierChanged,
			has_verifier_exception: this.verifierException,
			final_verdict: finalVerdict,
			tb_final_reward: this.tbFinalReward,
			root_cause_hint: this.rootCauseHint
		};
	}
	/** Append one line to this task's live `.log` file (and keep echoing to console). */
	log(line) {
		console.log(line);
		try {
			mkdirSync(this.taskDir(), { recursive: true });
			if (!this.logOpened) {
				appendFileSync(join(this.taskDir(), "lcrd-flow.log"), `# LCRD 任务日志 — Agent ${this.agentId} — 起始 ${(/* @__PURE__ */ new Date()).toISOString()}\n`, "utf8");
				this.logOpened = true;
			}
			appendFileSync(join(this.taskDir(), "lcrd-flow.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, "utf8");
		} catch {}
	}
	/** Render the Mermaid flowchart source. */
	renderMermaid() {
		const lines = ["flowchart TD"];
		let index = 0;
		let previous;
		for (const event of this.events) {
			index += 1;
			let id;
			switch (event.type) {
				case "plan":
					id = `P${index}`;
					lines.push(`${id}["lcrd_plan: ${mermaidEscape(clip(event.goal, 40))}<br/>verifier=${event.verifier}"]`);
					break;
				case "tool":
					id = `T${index}`;
					lines.push(`${id}["tool: ${mermaidEscape(event.name)}"]`);
					break;
				case "verdict": {
					id = `V${index}`;
					const label = event.pass ? "verify PASS" : `verify FAIL${event.count === void 0 ? "" : ` ${event.count}/${this.maxRetries}`}`;
					lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.reason, 60))}"}`);
					break;
				}
				case "intercept": {
					id = `I${index}`;
					const label = event.kind === "missing-plan" ? "拦截: 未声明计划" : event.kind === "infeasible" ? "拦截: 计划不可行" : "终止: 连续失败转人工";
					lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.detail, 60))}"}`);
					break;
				}
			}
			if (previous !== void 0) lines.push(`${previous} --> ${id}`);
			previous = id;
		}
		const terminal = this.events.some((event) => event.type === "intercept" && event.kind === "terminated");
		lines.push(`F["${terminal ? "任务终止转人工" : "会话结束"}"]`);
		if (previous !== void 0) lines.push(`${previous} --> F`);
		return lines.join("\n");
	}
	/** Render the Markdown report embedding the flowchart. */
	renderMarkdown() {
		const terminal = this.events.some((event) => event.type === "intercept" && event.kind === "terminated");
		const rows = this.events.map((event, i) => {
			const detail = event.type === "plan" ? `goal=${event.goal} / stop=${event.stop} / feasible=${String(event.feasibility)} / verifier=${event.verifier}` : event.type === "tool" ? event.name : event.type === "verdict" ? `${event.pass ? "PASS" : "FAIL"}${event.count === void 0 ? "" : ` (${event.count}/${this.maxRetries})`}: ${event.reason}` : `${event.kind}: ${event.detail}`;
			return `| ${i + 1} | \`${event.type}\` | ${detail.replaceAll("|", "\\|")} |`;
		}).join("\n");
		return `# LCRD 执行流程

- Agent: \`${this.agentId}\`
- 时间: ${(/* @__PURE__ */ new Date()).toISOString()}
- 结果: ${terminal ? "任务终止转人工" : "会话正常结束"}

\`\`\`mermaid
${this.renderMermaid()}
\`\`\`

## 事件时间线

| # | 类型 | 详情 |
|---|---|---|
${rows}
`;
	}
	/**
	* Write the flowchart, report, and JSON transcript into the task subfolder.
	* Re-runnable: every call rewrites the current snapshot, so per-turn dumps
	* stay fresh until the final disposal or process-exit flush. Synchronous so
	* it also runs from a process-exit handler; never throws.
	*/
	dump() {
		mkdirSync(this.taskDir(), { recursive: true });
		const base = join(this.taskDir(), "lcrd-flow");
		writeFileSync(`${base}.md`, this.renderMarkdown(), "utf8");
		writeFileSync(`${base}.mmd`, this.renderMermaid(), "utf8");
		writeFileSync(`${base}.json`, JSON.stringify({
			...this.computeMeta(),
			events: this.events
		}, null, 2), "utf8");
	}
};
//#endregion
//#region lib/types/verifiers.js
/**
* The three verifier implementations the model may choose. Verification
* programs are plugin-owned: the model supplies only expressions over
* `result` (code verifiers) or nothing (LLM verifier), never the pass
* criterion itself. Expressions must reference `result` and hold on at least
* one probe input while failing on another — a condition true for every probe
* ("missing discrimination") is rejected, closing the self-pass attack.
*/
/** Probe inputs for discrimination detection: a condition true on every probe cannot verify anything. */
const JS_PROBE_VARIANTS = [
	void 0,
	null,
	0,
	1,
	-1,
	"",
	"x",
	false,
	true,
	[],
	{},
	{ content: "x" }
];
/** JSON-safe probe inputs for the Python template script. */
const PYTHON_PROBE_VARIANTS = [
	null,
	0,
	1,
	-1,
	"",
	"x",
	false,
	true,
	[],
	{},
	{ content: "x" }
];
/** Render one tool result into the verifier payload. */
function resultPayload(result) {
	return {
		isError: result.isError,
		value: result.isError ? void 0 : result.value,
		content: result.content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n")
	};
}
/** Whether the model-written expression actually uses the result. */
function referencesResult(expression) {
	return /\bresult\b/.test(expression);
}
/** Structured assertions: every condition is a JS expression over `result`; all must hold and none may be trivially true. */
function verifyAssert(conditions, payload) {
	for (const condition of conditions) {
		if (!referencesResult(condition)) return {
			pass: false,
			reason: `断言必须引用 result: ${condition}`,
			exception: true
		};
		let holdsOnEveryProbe = true;
		for (const variant of JS_PROBE_VARIANTS) try {
			if (!Boolean(new Function("result", `return (${condition})`)(variant))) {
				holdsOnEveryProbe = false;
				break;
			}
		} catch {
			holdsOnEveryProbe = false;
			break;
		}
		if (holdsOnEveryProbe) return {
			pass: false,
			reason: `断言对所有探测输入都为真,缺少区分度,请改用引用 result 具体内容的条件: ${condition}`,
			exception: true
		};
		let holds = false;
		try {
			holds = Boolean(new Function("result", `return (${condition})`)(payload.isError ? void 0 : payload.value));
		} catch (error) {
			return {
				pass: false,
				reason: `断言求值失败: ${error instanceof Error ? error.message : String(error)} (条件: ${condition})`,
				exception: true
			};
		}
		if (!holds) return {
			pass: false,
			reason: `断言不成立: ${condition}`
		};
	}
	return {
		pass: true,
		reason: "全部断言通过"
	};
}
/**
* Python verifier: the plugin-owned template script embeds the model's
* expression list as data, performs the same discrimination probe, then
* evaluates every expression against the result. A script that hangs past the
* timeout is killed and counts as a failure.
*/
async function verifyPython(command, timeoutMs, checks, payload) {
	for (const check of checks) if (!referencesResult(check)) return {
		pass: false,
		reason: `Python 检查必须引用 result: ${check}`
	};
	const template = `import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
result = None if data.get('isError') else data.get('value')
checks = json.loads('''${JSON.stringify(checks)}''')
variants = json.loads('''${JSON.stringify(PYTHON_PROBE_VARIANTS)}''')
for expr in checks:
    all_true = True
    for v in variants:
        try:
            if not eval(expr, {'result': v}):
                all_true = False
                break
        except Exception:
            all_true = False
            break
    if all_true:
        print('FAIL: 检查对所有探测输入都为真,缺少区分度: ' + expr)
        sys.exit(0)
for expr in checks:
    try:
        ok = bool(eval(expr, {'result': result}))
    except Exception as e:
        print('FAIL: 检查求值失败: ' + str(e) + ': ' + expr)
        sys.exit(0)
    if not ok:
        print('FAIL: ' + expr)
        sys.exit(0)
print('PASS')
`;
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const scriptPath = join(tmpdir(), `lcrd-verify-${suffix}.py`);
	const payloadPath = join(tmpdir(), `lcrd-result-${suffix}.json`);
	await writeFile(scriptPath, template, "utf8");
	await writeFile(payloadPath, JSON.stringify(payload), "utf8");
	try {
		return await new Promise((resolve) => {
			const proc = spawn(command, [scriptPath, payloadPath], {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true,
				env: {
					...process.env,
					PYTHONIOENCODING: "utf-8"
				}
			});
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve({
					pass: false,
					reason: `Python 校验脚本超时(>${timeoutMs}ms)`,
					exception: true
				});
			}, timeoutMs);
			proc.stdout.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				resolve({
					pass: false,
					reason: `无法启动校验脚本: ${error.message}`,
					exception: true
				});
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				const output = stdout.trim();
				if (code !== 0) {
					resolve({
						pass: false,
						reason: `校验脚本退出码 ${String(code)}: ${stderr.trim() || output || "(无输出)"}`,
						exception: true
					});
					return;
				}
				if (output.startsWith("PASS")) {
					resolve({
						pass: true,
						reason: output.slice(4).replace(/^[:：]/, "").trim() || "脚本通过"
					});
					return;
				}
				const reason = output.replace(/^FAIL[:：]/, "").trim() || "(脚本未输出 PASS/FAIL)";
				resolve({
					pass: false,
					reason,
					exception: /求值失败|缺少区分度|必须引用/.test(reason)
				});
			});
		});
	} finally {
		await unlink(scriptPath).catch(() => {});
		await unlink(payloadPath).catch(() => {});
	}
}
/**
* LLM verifier: an independent session with a plugin-owned prompt that pins
* the protocol and the model's own goal/stop-condition, and no conversation
* history. The model cannot supply or alter the verifier prompt, so it cannot
* instruct the verifier to pass. Non-JSON or non-PASS output counts as a
* failure (strict by design).
*/
async function verifyLlm(ctx, agent, verifierModel, anchorText, plan, payload, signal) {
	if (agent.options.provider === void 0 || agent.options.model === void 0) return {
		pass: false,
		reason: "LLM 校验器无法运行: agent 未配置 provider/model"
	};
	const options = {
		provider: agent.options.provider,
		model: verifierModel ?? agent.options.model,
		system: `你是 LCRD 独立校验器,与执行主任务的主模型完全隔离,不得放水。
主任务根锚协议(不可违背):
${anchorText}

主模型声明的本步子任务:
目标: ${plan.goal}
停止条件: ${plan.stop_condition}

判定: 工具执行结果是否使停止条件得到满足,且不违背主任务根锚?结果为空、无法客观判定或违背根锚时判 FAIL。
只输出一个 JSON 对象,不要输出其他任何内容: {"verdict": "PASS" 或 "FAIL", "reason": "简短理由"}`,
		messages: [createMessage({
			role: "user",
			content: [{
				type: "text",
				text: `需要校验的工具执行结果:\n${JSON.stringify(payload)}`
			}],
			source: {
				kind: "plugin",
				plugin: "lcrd-hard-isolation"
			}
		})],
		temperature: 0,
		maxTokens: 1024,
		signal
	};
	let text = "";
	for await (const chunk of ctx.llm.stream(options)) if (chunk.type === "text-delta") text += chunk.text;
	const match = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
	if (!match) return {
		pass: false,
		reason: `校验器未返回 JSON 判定: ${text.slice(0, 200)}`,
		exception: true
	};
	try {
		const parsed = JSON.parse(match[0]);
		const verdictRaw = parsed.verdict;
		const verdict = (typeof verdictRaw === "string" ? verdictRaw : "").toUpperCase();
		const reason = typeof parsed.reason === "string" ? parsed.reason : "(无理由)";
		return verdict === "PASS" ? {
			pass: true,
			reason
		} : {
			pass: false,
			reason: reason || "LLM 校验器判定 FAIL"
		};
	} catch {
		return {
			pass: false,
			reason: `校验器 JSON 解析失败: ${text.slice(0, 200)}`,
			exception: true
		};
	}
}
/** Run the verifier declared in the step plan. */
async function runVerifier(ctx, agent, verifier, result, options, plan, signal) {
	const payload = resultPayload(result);
	switch (verifier.kind) {
		case "assert": return verifyAssert(verifier.conditions, payload);
		case "python": return verifyPython(options.pythonCommand, options.pythonTimeoutMs, verifier.checks, payload);
		case "llm": return verifyLlm(ctx, agent, options.verifierModel, options.anchorText, plan, payload, signal);
	}
}
//#endregion
//#region lib/types/index.js
const name = "lcrd-hard-isolation";
const inject = [
	"systemPrompt",
	"tools",
	"llm"
];
const Config = z.object({
	maxRetries: z.number().default(3),
	pythonCommand: z.string().default("python"),
	pythonTimeoutMs: z.number().default(3e4),
	verifierModel: z.string().default(void 0),
	logDir: z.string().default(void 0),
	interaction: z.union([
		"auto",
		"auth",
		"manual"
	]).default("manual")
});
/** The `{kind:'plugin'}` source stamped on every injected context. */
const PLUGIN_SOURCE = {
	kind: "plugin",
	plugin: "lcrd-hard-isolation"
};
/** Model-facing text of one content block. */
function textBlock(text) {
	return {
		type: "text",
		text
	};
}
/** Narrow one tool-argument value to a string, rejecting anything else. */
function parseString(raw, field) {
	if (typeof raw !== "string" || raw.length === 0) throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`);
	return raw;
}
/** Narrow one tool-argument value to a boolean, rejecting anything else. */
function parseBoolean(raw, field) {
	if (typeof raw !== "boolean") throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`);
	return raw;
}
/** Validate the model-supplied verifier object against the declared protocol. */
function parseVerifier(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("lcrd_plan: 参数 verifier 必须是对象");
	const record = raw;
	if (record.kind === "assert") {
		const conditions = record.conditions;
		if (!Array.isArray(conditions) || !conditions.every((item) => typeof item === "string")) throw new Error("lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组");
		return {
			kind: "assert",
			conditions
		};
	}
	if (record.kind === "python") {
		const checks = record.checks;
		if (!Array.isArray(checks) || !checks.every((item) => typeof item === "string")) throw new Error("lcrd_plan: verifier.kind=python 需要 checks 为字符串数组");
		return {
			kind: "python",
			checks
		};
	}
	if (record.kind === "llm") return { kind: "llm" };
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
function apply(ctx, config) {
	const maxRetries = config.maxRetries;
	const pythonCommand = config.pythonCommand;
	const pythonTimeoutMs = config.pythonTimeoutMs;
	const verifierModel = config.verifierModel;
	const logDir = config.logDir;
	const interaction = config.interaction;
	if (!Number.isInteger(maxRetries) || maxRetries < 1) throw new Error("lcrd-hard-isolation: `maxRetries` must be an integer >= 1");
	if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1e3) throw new Error("lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000");
	const plans = /* @__PURE__ */ new WeakMap();
	const failures = /* @__PURE__ */ new WeakMap();
	const terminated = /* @__PURE__ */ new WeakSet();
	const flows = /* @__PURE__ */ new WeakMap();
	const sessionRecorders = /* @__PURE__ */ new WeakMap();
	const policySet = /* @__PURE__ */ new WeakSet();
	const allRecorders = /* @__PURE__ */ new Set();
	/** The approval policy the interaction mode maps to (`'never'` auto-rejects; `'ask'` delegates). */
	const approvalPolicy = interaction === "auto" ? "never" : "ask";
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
				interaction
			});
			flows.set(agent, recorder);
			sessionRecorders.set(agent.session, recorder);
			allRecorders.add(recorder);
			try {
				if (!policySet.has(agent)) {
					setApprovalPolicy(agent.session, approvalPolicy);
					policySet.add(agent);
				}
			} catch {}
		}
		return recorder;
	}
	/** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
	function flush(agent) {
		const recorder = flows.get(agent);
		if (recorder) try {
			recorder.dump();
		} catch {}
	}
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const recorder = sessionRecorders.get(session);
		if (recorder) try {
			recorder.dump();
		} catch {}
	});
	ctx.on("agent/disposed", ({ agent }) => {
		const recorder = flows.get(agent);
		if (recorder) try {
			recorder.dump();
		} catch {}
	});
	process.once("exit", () => {
		for (const recorder of allRecorders) try {
			recorder.dump();
		} catch {}
	});
	registerAnchorSection(ctx);
	ctx.tools.register(defineTool({
		name: "lcrd_plan",
		description: "Declare the next subtask plan before executing tools: the subtask goal, a stop condition an external verifier can check, a feasibility flag, and the verifier to run on the next tool result (assert / python / llm). The external engine verifies every tool result against the declared stop condition; a failed verification rejects the result. The model supplies only data, never the pass criterion: assert/python take expressions over `result` that must reference it and must not be true for every input; the llm verifier uses a plugin-fixed prompt checked against the root anchor.",
		parameters: {
			goal: {
				type: "string",
				required: true,
				description: "本步子任务目标,服务于主任务根锚"
			},
			stop_condition: {
				type: "string",
				required: true,
				description: "本步局部停止条件,必须可被外部校验器客观检查"
			},
			feasibility: {
				type: "boolean",
				required: true,
				description: "本步子任务是否可行的自检标记"
			},
			verifier: {
				type: "object",
				required: true,
				additionalProperties: false,
				description: "校验方式,三选一: assert(JS 表达式列表)/ python(Python 表达式列表)/ llm(插件固定提示词的独立会话)",
				properties: {
					kind: {
						type: "string",
						required: true,
						enum: [
							"assert",
							"python",
							"llm"
						]
					},
					conditions: {
						type: "array",
						items: { type: "string" },
						description: "kind=assert: 每条断言是作用于 result 的 JS 表达式,必须引用 result,全部为真才通过"
					},
					checks: {
						type: "array",
						items: { type: "string" },
						description: "kind=python: 每条检查是作用于 result 的 Python 表达式,必须引用 result,全部为真才通过"
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (!agent) throw new Error("lcrd_plan requires an agent-scoped execution");
			const plan = {
				goal: parseString(args.goal, "goal"),
				stop_condition: parseString(args.stop_condition, "stop_condition"),
				feasibility: parseBoolean(args.feasibility, "feasibility"),
				verifier: parseVerifier(args.verifier)
			};
			plans.set(agent, plan);
			const recorder = ensureFlow(agent);
			recorder.push({
				type: "plan",
				goal: plan.goal,
				stop: plan.stop_condition,
				feasibility: plan.feasibility,
				verifier: plan.verifier.kind,
				verifierSpec: plan.verifier
			});
			recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`);
			flush(agent);
			return `计划已记录: 目标="${plan.goal}"。下一步工具结果将由 ${plan.verifier.kind} 校验器独立验证。`;
		}
	}));
	ctx.on("tools/post-execute", async (exec, result, next) => {
		if (!exec.agent) return next();
		const agent = exec.agent;
		if (terminated.has(agent)) {
			ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`);
			ensureFlow(agent).push({
				type: "tool",
				name: exec.name
			});
			ensureFlow(agent).push({
				type: "intercept",
				kind: "terminated",
				detail: "任务已终止,后续工具调用被拦截"
			});
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock("[LCRD] 任务已因连续校验失败终止,等待人工介入。停止所有工具调用,向用户报告失败情况。")]
			};
		}
		if (exec.name === "lcrd_plan") return next();
		if (interaction === "auto" && exec.name === "ask_user_question") {
			const recorder = ensureFlow(agent);
			recorder.markAskIntercepted();
			recorder.log("[LCRD] auto-answer: tool=ask_user_question blocked (unattended)");
			recorder.push({
				type: "tool",
				name: exec.name
			});
			recorder.push({
				type: "intercept",
				kind: "missing-plan",
				detail: "ask_user_question (auto mode)"
			});
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock("[LCRD] 自动模式无法人工应答。请基于已有信息自主判断并继续,不要等待用户输入;若必须确认,请按 stop_condition 校验现有结果。")],
				additionalContexts: [createUserMessage({
					content: [textBlock("[LCRD] 自动模式: 无法人工应答 ask_user_question,请自主决策继续。")],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd auto-answer"
					}
				})]
			};
		}
		const plan = plans.get(agent);
		if (!plan) {
			ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`);
			ensureFlow(agent).push({
				type: "tool",
				name: exec.name
			});
			ensureFlow(agent).push({
				type: "intercept",
				kind: "missing-plan",
				detail: exec.name
			});
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock("[LCRD] 未声明子任务计划: 执行任何工具前必须先调用 lcrd_plan 工具声明 goal、stop_condition、feasibility 与 verifier。")],
				additionalContexts: [createUserMessage({
					content: [textBlock("[LCRD] 工具结果被拒绝,原因: 缺少子任务计划声明。请先调用 lcrd_plan 再重试工具。")],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd missing plan"
					}
				})]
			};
		}
		if (!plan.feasibility) {
			ensureFlow(agent).log(`[LCRD] infeasible: tool=${exec.name} blocked`);
			ensureFlow(agent).push({
				type: "tool",
				name: exec.name
			});
			ensureFlow(agent).push({
				type: "intercept",
				kind: "infeasible",
				detail: exec.name
			});
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock(`[LCRD] 计划声明 feasibility=false,子任务被外部引擎拒绝: ${plan.goal}`)],
				additionalContexts: [createUserMessage({
					content: [textBlock("[LCRD] 请重新调用 lcrd_plan 声明可行的子任务,或直接向用户说明无法继续。")],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd infeasible plan"
					}
				})]
			};
		}
		const verdict = await runVerifier(ctx, agent, plan.verifier, result, {
			pythonCommand,
			pythonTimeoutMs,
			verifierModel,
			anchorText: PROTOCOL_TEXT
		}, plan, exec.signal);
		ensureFlow(agent).push({
			type: "tool",
			name: exec.name
		});
		if (verdict.pass) {
			ensureFlow(agent).push({
				type: "verdict",
				pass: true,
				reason: verdict.reason
			});
			failures.delete(agent);
			ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
			flush(agent);
			return next();
		}
		const count = (failures.get(agent) ?? 0) + 1;
		failures.set(agent, count);
		ensureFlow(agent).push({
			type: "verdict",
			pass: false,
			reason: verdict.reason,
			count
		});
		if (verdict.exception === true) ensureFlow(agent).markVerifierException();
		ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
		if (count >= maxRetries) {
			terminated.add(agent);
			const terminal = `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock(terminal)],
				additionalContexts: [createUserMessage({
					content: [textBlock(terminal)],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd terminated"
					}
				})]
			};
		}
		const rollback = `[LCRD] 校验失败(第 ${count}/${maxRetries} 次): ${verdict.reason}。工具结果已被外部引擎拒绝。请重新设计一套不同的子任务方法(更换策略或参数)并再次声明 lcrd_plan;禁止原样重试。`;
		flush(agent);
		return {
			kind: "block",
			feedback: [textBlock(rollback)],
			additionalContexts: [createUserMessage({
				content: [textBlock(`[LCRD] 上次校验失败: ${verdict.reason}`)],
				source: {
					...PLUGIN_SOURCE,
					form: "notice",
					summary: "lcrd verify fail"
				}
			})]
		};
	});
}
//#endregion
export { Config, FlowRecorder, apply, defaultLogDir, inject, name, resultPayload, shortAgentId, verifyAssert };
