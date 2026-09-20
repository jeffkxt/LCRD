import z from "@deepseek-ai/schemastery";
import { assertNever, createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { dirname, join, sep } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
//#region lib/types/anchor.js
/** The system-prompt section name the root-anchor protocol registers under. */
const PROTOCOL_SECTION_NAME = "lcrd-hard-isolation";
/**
* Version of the injected protocol: the anchor section text below plus the
* corrective notices the rollback path sends. Bump it whenever either changes,
* so runs recorded under different instruction sets stay distinguishable.
*/
const PROTOCOL_VERSION = 1;
/** The protocol text; also injected into LLM verifier prompts as the anchor against which results are judged. */
const PROTOCOL_TEXT = `[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result(工具的结构化值)/content(渲染文本)/isError(错误标记),至少引用其一,且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过;工具执行失败时校验直接判 FAIL);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert,额外注入 json 模块);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
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
//#region lib/types/file-flow.js
/** The system-prompt section name the file-flow protocol registers under. */
const FILE_FLOW_SECTION_NAME = "lcrd-file-flow";
/** The file-flow directory name, a sibling of the plugin's lcrd-flow log dir (distinct from it). */
const FILE_FLOW_DIR = "task-flow";
/**
* The file-flow protocol text with the real absolute flow root and workspace
* root substituted, so the model knows exactly where to create its task
* directory and where task products belong.
* @param flowRoot - the absolute task-flow root (a sibling of the flow-log directory).
* @param workRoot - the absolute workspace root for task products; empty when unresolvable.
* @returns the fixed section text.
*/
function fileFlowSectionText(flowRoot, workRoot) {
	return `${workRoot.length > 0 ? `0. 工作目录:当前工作目录绝对路径为 ${workRoot},任务产物(脚本、代码、数据文件)只能创建在工作区内,工作区之外的文件写入会被外部引擎拒绝;执行 shell 命令前必须先 cd 切换到工作区(Windows: cd /d ${workRoot}),确保命令的当前目录就是工作区;使用绝对路径,不要使用相对路径或环境提示的别名(如 /repo)。\n` : ""}[LCRD 文件化任务流程] 本协议由外部引擎强制注入,任务开始即生效。
1. 目录:任务目录由外部引擎自动创建,路径为 ${flowRoot}/taskflow-<uuid>/(与流程日志目录的命名不同,勿混淆),你无需自行创建或命名目录;引擎消息会告知确切路径。目录初始为空,流程文件必须由你创建,禁止以读取日志或目录列表代替创建文件。task.md 中记录一行"当前任务 task-slug: <task-slug>",需要确认自己任务目录时读取它。
2. 强制第一步:任何文件操作之前,必须先在本任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending);未创建流程文件就编辑其他文件会被外部引擎拒绝。
3. 文件布局:
   - task.md:主任务描述与验收标准(任务开始时创建,之后只读,不得修改)。
   - subtasks/:每个子任务一个文件,如 01_xxx.md、02_xxx.md,内容含子任务目标与验收条件。
   - progress.md:每个子任务的状态(completed/in_progress/failed)与当前执行指针,始终与真实进度一致。
   - 任务目录只存放上述流程文件;任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录,否则会被外部引擎拒绝。
4. 执行规则:
   - 开始时:读取用户命令 → 按引擎消息确认本任务目录 → 写 task.md → 拆分子任务并写 subtasks/*.md → 初始化 progress.md(全部 pending)。
   - 循环:读 progress.md 找到第一个未完成子任务 → 读取对应子任务文件 → 按 LCRD 主协议逐层执行(lcrd_plan 声明 + 外生校验,失败退回重试或进入学习模式)。
   - 完成一个子任务:更新 progress.md 标记 completed,再执行下一个;子任务详情只在执行时读入,完成后留在文件,上下文只保留进度与最近失败原因。
   - 全部完成:按 task.md 的验收标准对主任务统一校验;不满足则回到失败子任务,修改其文件后重新执行。
   - 任务终止:在 progress.md 标记当前子任务 failed 并总结已完成/未完成部分,然后向用户报告。
5. 边界:硬隔离只作用于任务上下文——${flowRoot}/ 目录内的读写受外部引擎约束,每个任务只能访问引擎自动创建的本任务目录,禁止读写其他任务的目录或 ${flowRoot}/ 根目录,越界会被拒绝并计数,连续越界达到上限即终止任务;${flowRoot}/ 之外的文件读写不受本协议限制。`;
}
/**
* Classify one canonical file path against the task-flow root and the agent's
* pinned task directory. The comparison is prefix-based on canonicalized
* identities (realpath ancestors plus appended suffixes), so both sides must
* be produced by the same resolver.
* @param flowRoot - the canonical task-flow root (a sibling of the flow-log directory).
* @param taskDir - the agent's pinned task subdirectory, undefined before the first task-context access.
* @param target - the canonical path to classify.
* @returns the verdict; `bootstrap` also carries the task directory to pin.
*/
function classifyFlowPath(flowRoot, taskDir, target) {
	/* v8 ignore start -- pure prefix helper, fully covered through the classifyFlowPath unit suite */
	const within = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
	/* v8 ignore stop */
	if (!within(flowRoot, target)) return { kind: "outside" };
	/* v8 ignore next -- split always yields a non-empty array, so the nullish fallback is unreachable */
	const slug = target.slice(flowRoot.length + sep.length).split(sep)[0] ?? "";
	if (slug.length === 0) return taskDir === void 0 ? { kind: "flowRoot" } : { kind: "foreign" };
	if (taskDir === void 0) return {
		kind: "bootstrap",
		taskDir: `${flowRoot}${sep}${slug}`
	};
	if (within(taskDir, target)) return { kind: "own" };
	return { kind: "foreign" };
}
/**
* Register the file-flow section in the calling context's scope. Order 210
* places it right after the root-anchor protocol (200) and before later
* context. The section text is a provider evaluated at each assembly with the
* assembling agent, so it embeds that agent's workspace root.
* @param ctx - plugin context; the registration is disposed with it.
* @param flowRoot - the absolute task-flow root embedded in the protocol text.
* @param workRootProvider - per-agent provider for the absolute workspace root; empty means omit the workspace line.
*/
function registerFileFlowSection(ctx, flowRoot, workRootProvider) {
	ctx.systemPrompt.section({
		name: FILE_FLOW_SECTION_NAME,
		order: 210,
		text: (context) => fileFlowSectionText(flowRoot, workRootProvider?.(context.agent) ?? "")
	});
}
//#endregion
//#region lib/types/verifiers.js
/**
* The three verifier implementations the model may choose. Verification
* programs are plugin-owned: the model supplies only expressions over
* `result` / `content` / `isError` (code verifiers) or nothing (LLM
* verifier), never the pass criterion itself. Expressions must reference at
* least one bound variable and hold on at least one probe input while
* failing on another — a condition true for every probe ("missing
* discrimination") is rejected, closing the self-pass attack. A failed tool
* result (isError) always fails the code verifiers outright: a broken call
* cannot satisfy a stop condition, and the pre-existing `result ===
* undefined` self-pass-on-error hole is closed.
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
/** Probe content inputs, swept together with the value variants so content-only conditions stay discriminating. */
const CONTENT_PROBE_VARIANTS = [
	"",
	"x",
	"hello",
	void 0,
	null
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
/** JSON-safe probe content inputs for the Python template script. */
const PYTHON_CONTENT_PROBE_VARIANTS = [
	"",
	"x",
	"hello",
	null,
	"abc"
];
/** Error flags swept in the discrimination probe matrix. */
const PROBE_ERROR_FLAGS = [false, true];
/**
* Render one tool result into the verifier payload.
* @param result - the executed tool's canonical result.
* @returns the payload every verifier evaluates against.
*/
function resultPayload(result) {
	return {
		isError: result.isError,
		value: result.isError ? void 0 : result.value,
		content: result.content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n")
	};
}
/** Whether the model-written expression actually uses at least one bound variable. */
function referencesBound(expression) {
	return /\b(result|content|isError)\b/.test(expression);
}
/** Clip long model-facing text in failure reasons. */
function clipText(text, max) {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
/** Whether a condition holds on every probe combination (rejected as lacking discrimination). */
function holdsOnAllProbes(evaluator) {
	for (const resultVariant of JS_PROBE_VARIANTS) for (const contentVariant of CONTENT_PROBE_VARIANTS) for (const isErrorVariant of PROBE_ERROR_FLAGS) try {
		if (!evaluator(resultVariant, contentVariant, isErrorVariant)) return false;
	} catch {
		return false;
	}
	return true;
}
/**
* Probe one model-authored JS condition and report the fraction of probe
* inputs on which it holds: `0` is maximally constraining, `1` is a tautology,
* and a rate strictly between the two is a condition that actually separates
* inputs. Instrumentation only — it measures a declaration before the tool
* runs and grants no verdict.
*
* XXX: the python verifier runs the same probe matrix inside its template
* script and reports only PASS/FAIL, so its hold rate stays unmeasured; the
* template would have to print the rate for the recorder to read it.
* @param expression - the model-authored condition.
* @returns the hold rate in `[0, 1]`, or null when the condition cannot be
*   probed (it reads no bound variable or does not compile).
*/
function probeHoldRate(expression) {
	if (!referencesBound(expression)) return null;
	let evaluator;
	try {
		evaluator = new Function("result", "content", "isError", `return (${expression})`);
	} catch {
		return null;
	}
	let holds = 0;
	let total = 0;
	for (const resultVariant of JS_PROBE_VARIANTS) for (const contentVariant of CONTENT_PROBE_VARIANTS) for (const isErrorVariant of PROBE_ERROR_FLAGS) {
		total += 1;
		try {
			if (evaluator(resultVariant, contentVariant, isErrorVariant)) holds += 1;
		} catch {}
	}
	return holds / total;
}
/**
* Classify one model-authored JS condition through the same probe matrix the
* post-execute verifier runs, without any tool result. Instrumentation only:
* it lets a caller record how discriminating a declared check is before the
* tool executes, and grants no verdict.
* @param expression - the model-authored condition.
* @returns `unbound` when it reads no bound variable, `invalid` when it does not
*   compile, `tautological` when it holds on every probe input, otherwise
*   `discriminating`.
*/
function probeExpression(expression) {
	if (!referencesBound(expression)) return "unbound";
	let evaluator;
	try {
		evaluator = new Function("result", "content", "isError", `return (${expression})`);
	} catch {
		return "invalid";
	}
	return holdsOnAllProbes(evaluator) ? "tautological" : "discriminating";
}
/**
* Structured assertions: every condition is a JS expression over
* `result` (the structured value), `content` (the rendered text), or
* `isError`; all must hold and none may be trivially true. A failed tool
* result fails outright before any condition runs.
* @param conditions - the model-authored JS expressions, each referencing at least one bound variable.
* @param payload - the verified tool result projection.
* @returns the normalized verdict; failure reasons localize the cause.
*/
function verifyAssert(conditions, payload) {
	if (conditions.length === 0) return {
		pass: false,
		reason: "断言列表为空: 至少需要一条作用于 result/content/isError 的表达式;空列表等于没有检查,外部执行不会放行",
		exception: true,
		exceptionKind: "invalid-condition"
	};
	if (payload.isError) return {
		pass: false,
		reason: `工具执行失败,校验直接判 FAIL(错误结果无法满足停止条件): ${clipText(payload.content, 120)}`
	};
	for (const condition of conditions) {
		if (!referencesBound(condition)) return {
			pass: false,
			reason: `断言必须引用 result/content/isError 之一: ${condition}`,
			exception: true,
			exceptionKind: "invalid-condition"
		};
		let evaluator;
		try {
			evaluator = new Function("result", "content", "isError", `return (${condition})`);
		} catch (error) {
			/* v8 ignore next -- only Error instances reach the construction catch */
			return {
				pass: false,
				reason: `断言求值失败: ${error instanceof Error ? error.message : String(error)} (条件: ${condition})`,
				exception: true,
				exceptionKind: "invalid-condition"
			};
		}
		if (holdsOnAllProbes(evaluator)) return {
			pass: false,
			reason: `断言对所有探测输入都为真,缺少区分度,请改用引用 result/content 具体内容的条件: ${condition}${condition.includes("!") ? ";否定式条件对所有探测输入恒真,无法通过区分度检查,需要验证\"不存在\"时请使用 llm 校验器或改述为肯定式" : ""}`,
			exception: true,
			exceptionKind: "invalid-condition"
		};
		let holds = false;
		try {
			holds = evaluator(payload.value, payload.content, false);
		} catch (error) {
			/* v8 ignore next -- only Error instances reach the verifier evaluation */
			const message = error instanceof Error ? error.message : String(error);
			const inHint = message.includes("Cannot use 'in' operator") ? ";JS 的 in 运算符只适用于对象,不适用于字符串,字符串请用 content.includes(...)/content.indexOf(...)" : "";
			return {
				pass: false,
				reason: `断言求值失败: ${message} (条件: ${condition});当前 result 类型: ${typeof payload.value},content 类型: ${typeof payload.content}${inHint}`,
				exception: true,
				exceptionKind: "eval-error"
			};
		}
		if (!holds) return {
			pass: false,
			reason: `断言不成立: ${condition} (result 类型: ${typeof payload.value})`
		};
	}
	return {
		pass: true,
		reason: "全部断言通过"
	};
}
/**
* Python verifier: the plugin-owned template script embeds the model's
* expression list as data, performs the same discrimination probe over the
* full result/content/isError matrix, then evaluates every expression
* against the result with `json` available. A failed tool result fails
* outright. A script that hangs past the timeout is killed and counts as a
* failure.
*/
async function verifyPython(command, timeoutMs, checks, payload) {
	if (checks.length === 0) return {
		pass: false,
		reason: "Python 检查列表为空: 至少需要一条作用于 result/content/isError 的表达式;空列表等于没有检查,外部执行不会放行",
		exception: true,
		exceptionKind: "invalid-condition"
	};
	for (const check of checks) if (!referencesBound(check)) return {
		pass: false,
		reason: `Python 检查必须引用 result/content/isError 之一: ${check}`,
		exception: true,
		exceptionKind: "invalid-condition"
	};
	const template = `import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
if data.get('isError'):
    print('FAIL: 工具执行失败,校验直接判 FAIL: ' + str(data.get('content'))[:200])
    sys.exit(0)
result = data.get('value')
content = data.get('content')
checks = data.get('checks')
variants = data.get('variants')
content_variants = data.get('content_variants')
env = {'result': result, 'content': content, 'isError': False, 'json': json}
def holds_on_all(expr):
    for v in variants:
        for c in content_variants:
            for e in (False, True):
                try:
                    if not eval(expr, {'result': v, 'content': c, 'isError': e, 'json': json}):
                        return False
                except Exception:
                    return False
    return True
for expr in checks:
    if holds_on_all(expr):
        hint = ';否定式条件对所有探测输入恒真,无法通过区分度检查,需要验证"不存在"时请使用 llm 校验器或改述为肯定式' if ('!' in expr or ' not ' in expr) else ''
        print('FAIL: 检查对所有探测输入都为真,缺少区分度: ' + expr + hint)
        sys.exit(0)
for expr in checks:
    try:
        ok = bool(eval(expr, env))
    except Exception as e:
        print('FAIL: 检查求值失败: ' + str(e) + ': ' + expr + ' (result 类型: ' + type(result).__name__ + ')')
        sys.exit(0)
    if not ok:
        print('FAIL: ' + expr + ' (result 类型: ' + type(result).__name__ + ')')
        sys.exit(0)
print('PASS')
`;
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const scriptPath = join(tmpdir(), `lcrd-verify-${suffix}.py`);
	const payloadPath = join(tmpdir(), `lcrd-result-${suffix}.json`);
	await writeFile(scriptPath, template, "utf8");
	await writeFile(payloadPath, JSON.stringify({
		...payload,
		checks,
		variants: PYTHON_PROBE_VARIANTS,
		content_variants: PYTHON_CONTENT_PROBE_VARIANTS
	}), "utf8");
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
					exception: true,
					exceptionKind: "timeout"
				});
			}, timeoutMs);
			proc.stdout.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			/* v8 ignore next -- the template script prints all verdicts to stdout; stderr only receives crashes outside the controlled paths */
			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				resolve({
					pass: false,
					reason: `无法启动校验脚本: ${error.message}`,
					exception: true,
					exceptionKind: "unspawnable"
				});
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				const output = stdout.trim();
				if (code !== 0) {
					resolve({
						pass: false,
						reason: `校验脚本退出码 ${String(code)}: ${stderr.trim() || output || "(无输出)"}`,
						exception: true,
						exceptionKind: "exit-code"
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
				/* v8 ignore start -- the template script always prints PASS or FAIL, so an empty output is unreachable */
				const reason = output.replace(/^FAIL[:：]/, "").trim() || "(脚本未输出 PASS/FAIL)";
				/* v8 ignore stop */
				const isException = /求值失败|缺少区分度|必须引用/.test(reason);
				resolve({
					pass: false,
					reason,
					exception: isException,
					...isException ? { exceptionKind: reason.includes("求值失败") ? "eval-error" : "invalid-condition" } : {}
				});
			});
		});
	} finally {
		/* v8 ignore start -- temp-file cleanup fails only on filesystem errors */
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
		reason: "LLM 校验器无法运行: agent 未配置 provider/model",
		exception: true,
		exceptionKind: "no-provider"
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
		exception: true,
		exceptionKind: "bad-output"
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
			exception: true,
			exceptionKind: "bad-output"
		};
	}
}
/**
* Run the verifier declared in the step plan.
* @param ctx - plugin context (used only by the llm verifier's stream).
* @param agent - the executing agent (used only by the llm verifier's provider/model).
* @param verifier - the model-chosen verifier specification.
* @param result - the executed tool's canonical result.
* @param options - python command/timeout and the optional dedicated verifier model plus the anchor text.
* @param plan - the declared step plan (used only by the llm verifier prompt).
* @param signal - cancellation for the llm stream.
* @returns the normalized verdict.
*/
async function runVerifier(ctx, agent, verifier, result, options, plan, signal) {
	const payload = resultPayload(result);
	switch (verifier.kind) {
		case "assert": return verifyAssert(verifier.conditions, payload);
		case "python": return verifyPython(options.pythonCommand, options.pythonTimeoutMs, verifier.checks, payload);
		case "llm": return verifyLlm(ctx, agent, options.verifierModel, options.anchorText, plan, payload, signal);
	}
}
//#endregion
//#region lib/types/instrumentation.js
/** A literal pinned by an expression: quoted text, or a numeric threshold above 1. */
const LITERAL_RE = /(['"][^'"]+['"]|\b(?:[2-9]|\d{2,})\b)/;
/** A read of one field or attribute of the structured result value. */
const STRUCTURAL_RE = /(\.get\(|result\s*\[|result\s*\.\s*\w+)/;
/** A read of the rendered text, or a substring test expressed through it. */
const CONTENT_RE = /(\bcontent\b|str\(result\)|in result|in str\()/;
/**
* The expressions one verifier spec evaluates.
* @param spec - the model-chosen verifier specification.
* @returns the declared expression list; empty for the llm verifier.
*/
function specExpressions(spec) {
	return spec.kind === "assert" ? spec.conditions : spec.kind === "python" ? spec.checks : [];
}
/**
* Read one declared check: its static axes plus the probe-matrix reading of
* each JS expression. Failure reasons stay the verifier's, so a declared check
* is measured without being judged.
* @param spec - the model-chosen verifier specification.
* @returns the strictness reading recorded on the plan event.
*/
function describeStrictness(spec) {
	const expressions = specExpressions(spec);
	const readings = expressions.map((expression) => ({
		literal: LITERAL_RE.test(expression),
		structural: STRUCTURAL_RE.test(expression),
		usesContent: CONTENT_RE.test(expression)
	}));
	const probes = spec.kind === "assert" ? expressions.map(probeExpression) : [];
	const rates = spec.kind === "assert" ? expressions.map(probeHoldRate).filter((rate) => rate !== null) : [];
	const literal = readings.some((reading) => reading.literal);
	const structural = readings.some((reading) => reading.structural);
	return {
		kind: spec.kind,
		expressions: expressions.length,
		tautological: probes.filter((probe) => probe === "tautological").length,
		literal,
		structural,
		usesContent: readings.some((reading) => reading.usesContent),
		presenceOnly: expressions.length > 0 && !literal && !structural,
		maxHoldRate: rates.length === 0 ? null : Math.max(...rates),
		discrimination: spec.kind === "assert" ? aggregateDiscrimination(probes) : spec.kind === "python" && expressions.length === 0 ? "empty" : "unchecked"
	};
}
/**
* Aggregate per-expression probes into the declaration's reading: the weakest
* expression decides, because the verifier requires every declared expression
* to hold.
* @param probes - one probe reading per declared expression.
* @returns the aggregate reading; a declaration with no expression cannot discriminate.
*/
function aggregateDiscrimination(probes) {
	if (probes.length === 0) return "empty";
	if (probes.includes("unbound")) return "unbound";
	if (probes.includes("invalid")) return "invalid";
	return probes.every((probe) => probe === "tautological") ? "tautological" : "discriminating";
}
/**
* The axes along which one declaration loosened its check. Every axis reads
* recorded fields, so a relaxation label is reproducible from the transcript
* alone and never depends on a value the tool happened to return. The axes are
* monotone shape signals rather than verdicts: a rewrite that stays as tight
* while changing shape trips them too, so a reader judges the two expression
* lists on the relaxation record.
* @param previous - the strictness reading of the previous plan declaration.
* @param next - the strictness reading of the newly declared plan.
* @returns the relaxed axes in a fixed order; empty when the check did not loosen.
*/
function relaxationAxes(previous, next) {
	const axes = [];
	if (previous.kind !== next.kind) axes.push("verifier-kind");
	if (next.expressions < previous.expressions) axes.push("fewer-expressions");
	if (!previous.presenceOnly && next.presenceOnly) axes.push("presence-only");
	if (previous.structural && !next.structural) axes.push("lost-structural");
	if (previous.literal && !next.literal) axes.push("dropped-literals");
	if (!previous.usesContent && next.usesContent) axes.push("substring-text");
	if (previous.maxHoldRate !== null && next.maxHoldRate !== null && next.maxHoldRate > previous.maxHoldRate) axes.push("weaker-constraint");
	return axes;
}
/** Clip length of one recorded argument or result summary, in characters. */
const SUMMARY_MAX = 240;
/**
* Clip one recorded summary to the transcript budget.
* @param text - the raw summary text.
* @returns the text, truncated with an ellipsis when it exceeds the budget.
*/
function clipSummary(text) {
	return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX)}…`;
}
/**
* Render tool arguments into one recorded line.
* @param args - the model-supplied tool arguments.
* @returns the clipped JSON rendering, or a marker when the value cannot be serialized.
*/
function summarizeArguments(args) {
	try {
		const serialized = JSON.stringify(args);
		return clipSummary(typeof serialized === "string" ? serialized : String(args));
	} catch {
		return "(unserializable arguments)";
	}
}
/**
* Project one executed tool result into the fields recorded beside the call.
* @param result - the executed tool's canonical result.
* @returns the kind, clipped summary, and failure detail recorded on the tool event.
*/
function summarizeResult(result) {
	const payload = resultPayload(result);
	if (result.isError) return {
		kind: "error",
		summary: clipSummary(payload.content),
		error: result.error.message,
		errorCode: result.error.info?.code
	};
	return {
		kind: valueKind(payload.value),
		summary: summarizeArguments(payload.value),
		error: void 0,
		errorCode: void 0
	};
}
/**
* The runtime kind of a structured tool value; the canonical tool contract
* restricts the value to JSON, so every reading is a JSON kind.
* @param value - the structured value carried by the verifier payload.
* @returns `null`, `array`, or the JSON `typeof` reading.
*/
function valueKind(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
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
/** Current artifact schema version; changes when a recorded field changes meaning. */
const FLOW_SCHEMA_VERSION = 2;
/** The append-only event stream written beside the rewritten snapshot files. */
const FLOW_STREAM_FILE = "lcrd-flow.jsonl";
/** The per-run metadata file written beside the events: what ran, under which configuration. */
const RUN_META_FILE = "run.json";
/** Walk up from this module to the nearest directory owning a `package.json`. */
function packageRoot() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		/* v8 ignore next -- the module always sits inside a package; the filesystem-root escape is defensive */
		if (parent === dir) return dir;
		dir = parent;
	}
}
/**
* Default log directory: a `lcrd-flow` folder inside the plugin package.
* @returns the absolute default artifact directory.
*/
function defaultLogDir() {
	return join(packageRoot(), "lcrd-flow");
}
/** The plugin package's own recorded version, read from its manifest once. */
let cachedPluginVersion;
/**
* The version of the plugin package that records a run, so artifacts from
* different releases stay distinguishable.
* @returns the package version, or `unknown` when the manifest cannot be read.
*/
function pluginVersion() {
	if (cachedPluginVersion !== void 0) return cachedPluginVersion;
	/* v8 ignore start -- the manifest is unreadable only from a broken installation */
	try {
		const manifest = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
		cachedPluginVersion = typeof manifest.version === "string" ? manifest.version : "unknown";
	} catch {
		cachedPluginVersion = "unknown";
	}
	/* v8 ignore stop */
	return cachedPluginVersion;
}
/** Make a filesystem-safe, human-readable task slug. */
function slugify(text) {
	const cleaned = text.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim();
	return cleaned.length === 0 ? "" : cleaned.slice(0, 60);
}
/**
* Stable 8-hex suffix from an agent id, disambiguating same-slug task folders.
* @param id - the agent or session id to hash.
* @returns the 8-hex FNV-1a hash suffix.
*/
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
/**
* Normalized fingerprint of one declaration: its goal, stop condition, and
* verifier specification. Two declarations with the same fingerprint retry the
* same method, which is what the rollback symbol forbids.
* @param plan - the recorded plan event.
* @returns the fingerprint string compared across declarations.
*/
function planFingerprint(plan) {
	return [
		plan.goal.trim(),
		plan.stop.trim(),
		JSON.stringify(plan.verifierSpec ?? plan.verifier)
	].join("\0");
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
	learningEnabled;
	learningThreshold;
	maxLearningAttempts;
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
	learningAttemptsConsumed = 0;
	learningSucceeded = false;
	previousStrictness;
	relaxationCount = 0;
	repeatPlanCount = 0;
	anchorDigest = null;
	anchorExcerpt = null;
	pluginVersionValue;
	protocolVersion;
	configSnapshot;
	model;
	provider;
	cwd;
	startedAt;
	endedAt;
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
		this.learningEnabled = options?.learningEnabled ?? false;
		this.learningThreshold = options?.learningThreshold ?? 5;
		this.maxLearningAttempts = options?.maxLearningAttempts ?? 3;
		this.pluginVersionValue = options?.pluginVersion ?? pluginVersion();
		this.protocolVersion = options?.protocolVersion ?? 0;
		this.configSnapshot = options?.config;
		this.model = agent.options.model ?? null;
		this.provider = agent.options.provider ?? null;
		this.cwd = agent.session.header.cwd ?? null;
		this.startedAt = (/* @__PURE__ */ new Date()).toISOString();
		this.endedAt = this.startedAt;
	}
	/**
	* The per-task artifact subfolder. Named after the goal slug plus a stable
	* agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
	* agents with the same goal never collide; without a goal it falls back to
	* the agent id (a `session-<uuid>`). Fixed at the first write so early
	* events and later events always land in the same folder.
	*/
	taskDir() {
		if (this.taskDirName === void 0) this.taskDirName = this.taskSlug !== this.agentId ? `${this.taskSlug}-${shortAgentId(this.agentId)}` : this.agentId;
		return join(this.outDir, this.taskDirName);
	}
	/**
	* Append one event; artifacts are rewritten per turn, on disposal, and on process exit.
	* @param event - the ordered protocol event to append.
	*/
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
		} else if (event.type === "learn-verify") {
			if (event.count !== void 0) this.learningAttemptsConsumed = event.count;
		} else if (event.type === "intercept" && event.kind === "terminated") this.retryConsumed = this.maxRetries;
		const recorded = this.stamp(event);
		this.events.push(recorded);
		this.appendStream(recorded);
	}
	/**
	* Stamp one appended event with its envelope and, for a plan, the strictness
	* reading plus the axes it relaxed along. The comparison uses this agent's
	* own previous declaration, so a relaxation label never depends on another
	* agent's plan.
	* @param event - the ordered protocol event to append.
	* @returns the recorded event written to both the snapshot and the stream.
	*/
	stamp(event) {
		const envelope = {
			seq: this.events.length + 1,
			ts: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (event.type !== "plan") return {
			...event,
			...envelope
		};
		const previous = this.previousPlan();
		const repeatPlan = previous !== void 0 && planFingerprint(previous) === planFingerprint(event);
		if (repeatPlan) this.repeatPlanCount += 1;
		if (event.verifierSpec === void 0) return {
			...event,
			...envelope,
			relaxation: [],
			repeatPlan
		};
		const strictness = describeStrictness(event.verifierSpec);
		const relaxation = this.previousStrictness === void 0 ? [] : relaxationAxes(this.previousStrictness, strictness);
		if (relaxation.length > 0) this.relaxationCount += 1;
		this.previousStrictness = strictness;
		return {
			...event,
			...envelope,
			strictness,
			relaxation,
			repeatPlan
		};
	}
	/** The agent's own preceding plan declaration, when there is one. */
	previousPlan() {
		for (let i = this.events.length - 1; i >= 0; i -= 1) {
			const candidate = this.events[i];
			if (candidate !== void 0 && candidate.type === "plan") return candidate;
		}
	}
	/**
	* Append one recorded event to the task's `.jsonl` stream. The snapshot files
	* are rewritten on every dump, so the stream is the durable record: an
	* interrupted run keeps every event already appended, and no later dump
	* rewrites what earlier turns recorded.
	* @param event - the recorded event to append.
	*/
	appendStream(event) {
		/* v8 ignore start -- the stream fails only on filesystem errors, which must never break the session */
		try {
			mkdirSync(this.taskDir(), { recursive: true });
			appendFileSync(join(this.taskDir(), FLOW_STREAM_FILE), `${JSON.stringify(event)}\n`, "utf8");
		} catch {}
		/* v8 ignore stop */
	}
	/**
	* External fields an offline evaluator backfilled into the previous snapshot.
	* Reading them back keeps a mid-process backfill from being overwritten by
	* the next dump; the constructor options still win over the file.
	* @returns the backfilled reward and root-cause hint; each null when absent.
	*/
	readBackfill() {
		try {
			const raw = JSON.parse(readFileSync(join(this.taskDir(), "lcrd-flow.json"), "utf8"));
			return {
				reward: typeof raw.tb_final_reward === "number" ? raw.tb_final_reward : null,
				hint: typeof raw.root_cause_hint === "string" ? raw.root_cause_hint : null
			};
		} catch {
			return {
				reward: null,
				hint: null
			};
		}
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
	/**
	* Compute the per-run metadata: what ran, with which model, under which
	* configuration and protocol version.
	* @returns the metadata written to `run.json`.
	*/
	computeRunMeta() {
		const meta = this.computeMeta();
		const terminal = meta.final_verdict === "terminated";
		return {
			schema_version: 2,
			plugin_version: this.pluginVersionValue,
			protocol_version: this.protocolVersion,
			session_id: this.agentId,
			task_id: this.taskSlug,
			config: this.configSnapshot,
			model: this.model,
			provider: this.provider,
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			cwd: this.cwd,
			started_at: this.startedAt,
			ended_at: this.endedAt,
			final_verdict: meta.final_verdict,
			termination: terminal ? "terminated" : meta.final_verdict === "pass" ? "completed" : "incomplete",
			anchor_digest: this.anchorDigest,
			anchor_excerpt: this.anchorExcerpt
		};
	}
	/** Record that the task completed through a post-learning re-solve; resets the consumed-attempts report. */
	markLearningSuccess() {
		this.learningSucceeded = true;
		this.learningAttemptsConsumed = 0;
	}
	/**
	* Record the digest and excerpt of the task's root anchor. Only the first
	* call counts: the anchor is the conversation's first user message, so a
	* later command in the same session must not replace it.
	* @param digest - hex digest of the anchoring user message text.
	* @param excerpt - clipped text of that message, for offline anchor judgement.
	*/
	markAnchorDigest(digest, excerpt) {
		if (this.anchorDigest !== null) return;
		this.anchorDigest = digest;
		this.anchorExcerpt = excerpt;
	}
	/**
	* Compute the machine-readable summary from the recorded state.
	* @returns the summary line emitted in the JSON transcript.
	*/
	computeMeta() {
		const finalVerdict = this.events.some((event) => event.type === "intercept" && event.kind === "terminated") ? "terminated" : this.hasAnyVerdict ? this.lastPass ? "pass" : "fail" : "fail";
		const backfill = this.readBackfill();
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
			tb_final_reward: this.tbFinalReward ?? backfill.reward,
			root_cause_hint: this.rootCauseHint ?? backfill.hint,
			learning_enabled: this.learningEnabled,
			learning_threshold: this.learningThreshold,
			learning_attempts_max: this.maxLearningAttempts,
			learning_attempts_consumed: this.learningAttemptsConsumed,
			learning_success: this.learningSucceeded,
			schema_version: 2,
			events_file: FLOW_STREAM_FILE,
			anchor_digest: this.anchorDigest,
			anchor_excerpt: this.anchorExcerpt,
			relaxation_count: this.relaxationCount,
			repeat_plan_count: this.repeatPlanCount,
			plugin_version: this.pluginVersionValue,
			protocol_version: this.protocolVersion,
			model: this.model,
			provider: this.provider,
			platform: process.platform
		};
	}
	/**
	* Append one line to this task's live `.log` file (and keep echoing to console).
	* @param line - the timestamped log line to append.
	*/
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
	/**
	* Render the Mermaid flowchart source.
	* @returns the flowchart text with every event chained in order.
	*/
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
				case "learn":
					id = `L${index}`;
					lines.push(`${id}["lcrd_learn: ${mermaidEscape(clip(event.analysis, 30))}<br/>learn=${mermaidEscape(clip(event.method, 30))}"]`);
					break;
				case "learn-verify": {
					id = `LV${index}`;
					const label = event.learned ? "learn PASS" : `learn FAIL${event.count === void 0 ? "" : ` ${event.count}/${this.maxLearningAttempts}`}`;
					lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.evidence, 60))}"}`);
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
	/**
	* Render the Markdown report embedding the flowchart.
	* @returns the report with the outcome, flowchart, and event timeline.
	*/
	renderMarkdown() {
		const terminal = this.events.some((event) => event.type === "intercept" && event.kind === "terminated");
		const rows = this.events.map((event, i) => {
			const detail = event.type === "plan" ? `goal=${event.goal} / stop=${event.stop} / feasible=${String(event.feasibility)} / verifier=${event.verifier}` : event.type === "tool" ? event.name : event.type === "verdict" ? `${event.pass ? "PASS" : "FAIL"}${event.count === void 0 ? "" : ` (${event.count}/${this.maxRetries})`}: ${event.reason}` : event.type === "learn" ? `analysis=${event.analysis} / knowledge=${event.knowledge} / method=${event.method} / criteria=${event.criteria}` : event.type === "learn-verify" ? `${event.learned ? "PASS" : "FAIL"}${event.count === void 0 ? "" : ` (${event.count}/${this.maxLearningAttempts})`}: ${event.evidence}` : `${event.kind}: ${event.detail}`;
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
	* Write the per-run metadata, flowchart, report, and JSON transcript into the
	* task subfolder. Re-runnable: every call rewrites the current snapshot, so
	* per-turn dumps stay fresh until the final disposal or process-exit flush.
	* Synchronous so it also runs from a process-exit handler; never throws.
	*/
	dump() {
		this.endedAt = (/* @__PURE__ */ new Date()).toISOString();
		mkdirSync(this.taskDir(), { recursive: true });
		const base = join(this.taskDir(), "lcrd-flow");
		writeFileSync(join(this.taskDir(), RUN_META_FILE), JSON.stringify(this.computeRunMeta(), null, 2), "utf8");
		writeFileSync(`${base}.md`, this.renderMarkdown(), "utf8");
		writeFileSync(`${base}.mmd`, this.renderMermaid(), "utf8");
		writeFileSync(`${base}.json`, JSON.stringify({
			...this.computeMeta(),
			events: this.events
		}, null, 2), "utf8");
	}
};
//#endregion
//#region lib/types/index.js
const name = "lcrd-hard-isolation";
const inject = [
	"systemPrompt",
	"tools",
	"llm",
	"fs"
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
	]).default("manual"),
	learningEnabled: z.boolean().default(false),
	learningThreshold: z.number().default(5),
	maxLearningAttempts: z.number().default(3),
	learningTools: z.array(z.string()).default([
		"web_search",
		"read",
		"glob",
		"grep",
		"skill",
		"subagent",
		"web_fetch"
	]),
	fileFlowEnabled: z.boolean().default(false),
	fileFlowPathViolationsMax: z.number().default(3),
	workspaceRoot: z.string().default(void 0),
	fileFlowTools: z.array(z.string()).default([
		"str_replace_editor",
		"write",
		"edit"
	]),
	failedCheckConsumesRetry: z.boolean().default(true)
});
/** The `{kind:'plugin'}` source stamped on every injected context, concretely typed so spreads never widen to the MessageSource union. */
const PLUGIN_SOURCE = {
	kind: "plugin",
	plugin: "lcrd-hard-isolation"
};
/** Clip length of the recorded anchor excerpt, in characters. */
const ANCHOR_EXCERPT_MAX = 500;
/**
* Digest and excerpt of the anchoring user message text. The anchor is the
* conversation's first user message: the digest groups runs that share one root
* anchor, and the excerpt lets an offline judge label conformance against it.
* @param message - the user message that opened the task.
* @returns the 16-hex digest and the clipped message text.
*/
function anchorIdentityOf(message) {
	const text = message.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
	return {
		digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
		excerpt: text.length <= ANCHOR_EXCERPT_MAX ? text : `${text.slice(0, ANCHOR_EXCERPT_MAX)}…`
	};
}
/** Model-facing text of one content block. */
function textBlock(text) {
	return {
		type: "text",
		text
	};
}
/** Narrow one tool-argument value to a string, rejecting anything else. */
function parseString(raw, field) {
	/* v8 ignore next 2 -- the tool schema rejects non-string arguments before execute runs */
	if (typeof raw !== "string" || raw.length === 0) throw new Error(`lcrd_plan: 参数 ${field} 必须是非空字符串`);
	return raw;
}
/** Narrow one tool-argument value to a boolean, rejecting anything else. */
function parseBoolean(raw, field) {
	/* v8 ignore next 2 -- the tool schema rejects non-boolean arguments before execute runs */
	if (typeof raw !== "boolean") throw new Error(`lcrd_plan: 参数 ${field} 必须是布尔值`);
	return raw;
}
/** Validate the model-supplied verifier object against the declared protocol. */
function parseVerifier(raw) {
	/* v8 ignore next 2 -- the tool schema rejects a non-object verifier before execute runs */
	if (typeof raw !== "object" || raw === null) throw new Error("lcrd_plan: 参数 verifier 必须是对象");
	const record = raw;
	if (record.kind === "assert") {
		const conditions = record.conditions;
		/* v8 ignore next 2 -- the tool schema rejects non-string-array conditions before execute runs */
		if (!Array.isArray(conditions) || !conditions.every((item) => typeof item === "string")) throw new Error("lcrd_plan: verifier.kind=assert 需要 conditions 为字符串数组");
		if (conditions.length === 0) throw new Error("lcrd_plan: verifier.kind=assert 的 conditions 不能为空,至少需要一条断言表达式");
		return {
			kind: "assert",
			conditions
		};
	}
	if (record.kind === "python") {
		const checks = record.checks;
		/* v8 ignore next 2 -- the tool schema rejects non-string-array checks before execute runs */
		if (!Array.isArray(checks) || !checks.every((item) => typeof item === "string")) throw new Error("lcrd_plan: verifier.kind=python 需要 checks 为字符串数组");
		if (checks.length === 0) throw new Error("lcrd_plan: verifier.kind=python 的 checks 不能为空,至少需要一条检查表达式");
		return {
			kind: "python",
			checks
		};
	}
	/* v8 ignore start -- the tool schema rejects unknown verifier kinds before execute runs */
	if (record.kind === "llm") return { kind: "llm" };
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
function apply(ctx, config) {
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
	/** The task-flow root: a sibling of the flow-log directory, so task context persists beside the logs. */
	const taskFlowRoot = join(dirname(config.logDir ?? defaultLogDir()), FILE_FLOW_DIR);
	if (!Number.isInteger(maxRetries) || maxRetries < 1) throw new Error("lcrd-hard-isolation: `maxRetries` must be an integer >= 1");
	if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1e3) throw new Error("lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000");
	if (!Number.isInteger(learningThreshold) || learningThreshold < 1) throw new Error("lcrd-hard-isolation: `learningThreshold` must be an integer >= 1");
	if (!Number.isInteger(maxLearningAttempts) || maxLearningAttempts < 1) throw new Error("lcrd-hard-isolation: `maxLearningAttempts` must be an integer >= 1");
	if (!Number.isInteger(fileFlowPathViolationsMax) || fileFlowPathViolationsMax < 1) throw new Error("lcrd-hard-isolation: `fileFlowPathViolationsMax` must be an integer >= 1");
	const plans = /* @__PURE__ */ new WeakMap();
	const failures = /* @__PURE__ */ new WeakMap();
	/** The verdict the model last saw, so the next declaration records its decision context. */
	const lastVerdict = /* @__PURE__ */ new WeakMap();
	/** Failures in which the engine rejected the model's own check rather than the work. */
	const invalidChecks = /* @__PURE__ */ new WeakMap();
	const terminated = /* @__PURE__ */ new WeakSet();
	/** Per-agent learning-mode state: consumed rounds, the current phase, and whether a learning tool ran this round. */
	const learning = /* @__PURE__ */ new WeakMap();
	/** Per-agent consecutive task-context path denials under the file-flow guard. */
	const pathViolations = /* @__PURE__ */ new WeakMap();
	/** Per-agent file-flow launch gate: the pinned `task-flow/<task-slug>` directory, set by the first task-context access. */
	const taskDirs = /* @__PURE__ */ new WeakMap();
	/** Executions denied by the file-flow guard; their results are final and never run the verifier. */
	const guardDenied = /* @__PURE__ */ new WeakSet();
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
				interaction,
				learningEnabled,
				learningThreshold,
				maxLearningAttempts,
				protocolVersion: 1,
				config
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
			} catch {}
		}
		return recorder;
	}
	/** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
	function flush(agent) {
		const recorder = flows.get(agent);
		/* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
		if (recorder) try {
			recorder.dump();
		} catch {}
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
		const summary = result === void 0 ? void 0 : summarizeResult(result);
		ensureFlow(owner).push({
			type: "tool",
			name: exec.name,
			callId: String(exec.callId),
			argsSummary: summarizeArguments(exec.arguments),
			...summary === void 0 ? {} : {
				resultKind: summary.kind,
				resultSummary: summary.summary
			},
			...summary?.error === void 0 ? {} : { errorMessage: summary.error },
			...summary?.errorCode === void 0 ? {} : { errorCode: summary.errorCode }
		});
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
		lastVerdict.set(owner, {
			pass: verdict.pass,
			reason: verdict.reason,
			verifierKind
		});
		if (verdict.exceptionKind === "invalid-condition" || verdict.exceptionKind === "eval-error") invalidChecks.set(owner, (invalidChecks.get(owner) ?? 0) + 1);
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
			phase: learning.get(owner)?.phase ?? "normal",
			lastReason: previous === void 0 ? null : clipSummary(previous.reason),
			lastPass: previous?.pass ?? null,
			lastVerifierKind: previous?.verifierKind ?? null,
			invalidChecks: invalidChecks.get(owner) ?? 0
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
		let dirName = `taskflow-${agent.id.startsWith("session-") ? agent.id.slice(8) : agent.id}`;
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
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const recorder = sessionRecorders.get(session);
		if (recorder)
 /* v8 ignore start -- dump fails only on filesystem errors, which must not break the session */
		try {
			recorder.dump();
		} catch {}
	});
	ctx.on("agent/disposed", ({ agent }) => {
		const recorder = flows.get(agent);
		if (recorder)
 /* v8 ignore start -- dump fails only on filesystem errors, which must not break disposal */
		try {
			recorder.dump();
		} catch {}
	});
	/* v8 ignore next -- a process-exit handler cannot be driven from an in-process test */
	process.once("exit", () => {
		for (const recorder of allRecorders) try {
			recorder.dump();
		} catch {}
	});
	registerAnchorSection(ctx);
	let fsWorkRoot = "";
	/**
	* The workspace root for one agent: explicit config, the session's
	* validated cwd, the deployment's sandbox workspace root (the authoritative
	* workspace-write boundary), DSH_CWD, then the fs root.
	*/
	const resolveWorkRoot = (agent) => {
		const sandboxRoot = ctx.get("sandboxPolicy")?.workspaceRoot;
		return workspaceRoot ?? agent?.session.header.cwd ?? sandboxRoot ?? process.env.DSH_CWD ?? fsWorkRoot;
	};
	if (fileFlowEnabled) {
		ctx.fs.resolve(".").then(
			(target) => {
				fsWorkRoot = ctx.fs.processPath(target);
			},
			/* v8 ignore next 2 -- the fs root is unresolvable only when the backend fails */
			() => {}
		);
		registerFileFlowSection(ctx, taskFlowRoot, resolveWorkRoot);
	}
	ctx.tools.register(defineTool({
		name: "lcrd_plan",
		description: "Declare the next subtask plan before executing tools: the subtask goal, a stop condition an external verifier can check, a feasibility flag, and the verifier to run on the next tool result (assert / python / llm). The external engine verifies every tool result against the declared stop condition; a failed verification rejects the result. The model supplies only data, never the pass criterion: assert/python take expressions over `result` (the structured tool value), `content` (the rendered text), or `isError` that must reference at least one and must not be true for every probe input; the llm verifier uses a plugin-fixed prompt checked against the root anchor. A failed tool result always fails assert/python outright.",
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
						description: "kind=assert: 每条断言是 JS 表达式,可作用于 result(结构化值)/content(渲染文本)/isError,至少引用其一;对所有探测输入恒真判\"缺少区分度\"失败;工具执行失败直接判 FAIL;全部为真才通过;列表不得为空"
					},
					checks: {
						type: "array",
						items: { type: "string" },
						description: "kind=python: 每条检查是 Python 表达式,可作用于 result/content/isError(环境注入 json 模块),至少引用其一;规则同 assert;全部为真才通过;列表不得为空"
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
				verifierSpec: plan.verifier,
				context: planContext(agent)
			});
			recorder.log(`[LCRD] plan: goal="${plan.goal}" stop="${plan.stop_condition}" feasibility=${String(plan.feasibility)} verifier=${plan.verifier.kind}`);
			if (fileFlowEnabled && taskDirs.get(agent) === void 0)
 /* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
			try {
				const taskDir = await ensureTaskDir(agent);
				recorder.log(`[LCRD] task dir auto-created: ${taskDir}`);
				flush(agent);
				return `计划已记录: 目标="${plan.goal}"。任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。下一步工具结果将由 ${plan.verifier.kind} 校验器独立验证。`;
			} catch {}
			flush(agent);
			return `计划已记录: 目标="${plan.goal}"。下一步工具结果将由 ${plan.verifier.kind} 校验器独立验证。`;
		}
	}));
	if (learningEnabled) {
		ctx.tools.register(defineTool({
			name: "lcrd_learn",
			description: "Declare one learning round before acquiring knowledge: analyze why the current task cannot be solved, what knowledge is needed, how it will be learned (web search / reading files / reflection / delegation), and the self-evaluation criteria. After declaring, use the configured learning tools to acquire knowledge, then call lcrd_learn_verify to self-evaluate. A failed self-evaluation consumes one learning attempt; a passed one resumes re-solving the original task.",
			parameters: {
				problem_analysis: {
					type: "string",
					required: true,
					description: "当前无法解决问题的拆解与根因分析"
				},
				knowledge_needed: {
					type: "string",
					required: true,
					description: "需要学习的具体知识"
				},
				learning_method: {
					type: "string",
					required: true,
					description: "学习方法:web_search / 读文件 / 反思 / 子代理等"
				},
				eval_criteria: {
					type: "string",
					required: true,
					description: "自评是否学会的评价标准(模型自己编写)"
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
				if (!agent) throw new Error("lcrd_learn requires an agent-scoped execution");
				const state = learning.get(agent);
				if (!state) throw new Error("lcrd_learn 只能在学习模式(连续校验失败达到阈值)下调用");
				const declaration = {
					problem_analysis: parseString(args.problem_analysis, "problem_analysis"),
					knowledge_needed: parseString(args.knowledge_needed, "knowledge_needed"),
					learning_method: parseString(args.learning_method, "learning_method"),
					eval_criteria: parseString(args.eval_criteria, "eval_criteria")
				};
				state.phase = "learn";
				state.evidence = false;
				const recorder = ensureFlow(agent);
				recorder.push({
					type: "learn",
					analysis: declaration.problem_analysis,
					knowledge: declaration.knowledge_needed,
					method: declaration.learning_method,
					criteria: declaration.eval_criteria
				});
				recorder.log(`[LCRD] learn: problem="${declaration.problem_analysis}" knowledge="${declaration.knowledge_needed}" method="${declaration.learning_method}"`);
				flush(agent);
				return `学习轮次已记录: 问题="${declaration.problem_analysis}"。现在使用学习工具获取知识,完成后调用 lcrd_learn_verify 自评。`;
			}
		}));
		ctx.tools.register(defineTool({
			name: "lcrd_learn_verify",
			description: "Self-evaluate one learning round against the criteria declared in lcrd_learn: whether the knowledge has been acquired and the evidence. A failed self-evaluation consumes one learning attempt; when attempts are exhausted the task terminates for human review. A passed one switches to re-solving the original task, whose tool results still run the exogenous verifier.",
			parameters: {
				learned: {
					type: "boolean",
					required: true,
					description: "是否认为自己已学会所需知识"
				},
				evidence: {
					type: "string",
					required: true,
					description: "自评依据:如何用声明的评价标准判断"
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
				if (!agent) throw new Error("lcrd_learn_verify requires an agent-scoped execution");
				const state = learning.get(agent);
				if (!state) throw new Error("lcrd_learn_verify 只能在学习模式(连续校验失败达到阈值)下调用");
				const verdict = {
					learned: parseBoolean(args.learned, "learned"),
					evidence: parseString(args.evidence, "evidence")
				};
				const recorder = ensureFlow(agent);
				if (!verdict.learned) {
					state.attempts += 1;
					recorder.push({
						type: "learn-verify",
						learned: false,
						evidence: verdict.evidence,
						count: state.attempts
					});
					recorder.log(`[LCRD] learn FAIL (${state.attempts}/${maxLearningAttempts}): ${verdict.evidence}`);
					flush(agent);
					if (state.attempts >= maxLearningAttempts) {
						terminated.add(agent);
						return `[LCRD] 自评未通过且学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.evidence}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
					}
					return `自评未通过(第 ${state.attempts}/${maxLearningAttempts} 轮): ${verdict.evidence}。请再次调用 lcrd_learn 分析问题,继续学习并重新自评。`;
				}
				if (!state.evidence) return `自评不能通过:本轮尚未调用任何学习工具(${[...learningToolSet].join(", ")})。请先使用学习工具获取知识,再重新自评。`;
				state.phase = "resolve";
				recorder.push({
					type: "learn-verify",
					learned: true,
					evidence: verdict.evidence
				});
				recorder.log(`[LCRD] learn PASS: ${verdict.evidence} → 进入重解阶段`);
				flush(agent);
				return "自评通过。请重新声明 lcrd_plan 并执行工具解决原任务;重解结果仍由外生校验器验证,通过即任务完成并重置学习次数。";
			}
		}));
	}
	ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
		const userMessage = messages.find((message) => message.source.kind === "user");
		if (userMessage !== void 0) {
			const anchor = anchorIdentityOf(userMessage);
			ensureFlow(agent).markAnchorDigest(anchor.digest, anchor.excerpt);
			plans.delete(agent);
			failures.delete(agent);
			learning.delete(agent);
			lastVerdict.delete(agent);
			invalidChecks.delete(agent);
			pathViolations.delete(agent);
			taskDirs.delete(agent);
			if (terminated.has(agent)) {
				ensureFlow(agent).log("[LCRD] user command: termination reset for a new task");
				terminated.delete(agent);
			}
		}
		return next();
	});
	ctx.on("tools/pre-execute", async (exec, next) => {
		const agent = exec.agent;
		if (!agent || !fileFlowEnabled || !fileFlowToolSet.has(exec.name)) return next();
		const rawPath = exec.arguments.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return next();
		/* v8 ignore start -- a path both the guard and the file tool resolve through the same fs seam, which surfaces its own errors */
		let flowRoot;
		let target;
		try {
			const fs = ctx.fs;
			flowRoot = fs.processPath(await fs.resolve(taskFlowRoot, { signal: exec.signal }));
			target = fs.processPath(await fs.resolve(rawPath, { signal: exec.signal }));
		} catch {
			return next();
		}
		/* v8 ignore stop */
		const pinned = taskDirs.get(agent);
		if (pinned === void 0) {
			let taskDir;
			/* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
			try {
				taskDir = await ensureTaskDir(agent);
			} catch {
				return next();
			}
			/* v8 ignore stop */
			guardDenied.add(exec);
			ensureFlow(agent).log(`[LCRD] file-flow launch gate: tool=${exec.name} path=${rawPath} denied (task dir auto-created: ${taskDir})`);
			flush(agent);
			const workRoot = resolveWorkRoot(agent);
			/* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
			return {
				kind: "deny",
				reason: `[LCRD] 任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在本任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。当前路径 ${rawPath} 不在任务目录内;当前工作目录为 ${workRoot.length > 0 ? workRoot : "(未解析)"}。`
			};
		}
		const classification = classifyFlowPath(flowRoot, pinned, target);
		/* v8 ignore next -- flowRoot, bootstrap, and the exhaustive default are unreachable once pinned */
		switch (classification.kind) {
			case "outside": {
				const isMutation = exec.name === "write" || exec.name === "edit" || exec.name === "str_replace_editor" && exec.arguments.command !== "view";
				const workRoot = resolveWorkRoot(agent);
				/* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
				if (isMutation && workRoot.length > 0) {
					let workRootKey = "";
					try {
						workRootKey = ctx.fs.processPath(await ctx.fs.resolve(workRoot, { signal: exec.signal }));
					} catch {}
					if (!(workRootKey.length > 0 && (target === workRootKey || target.startsWith(`${workRootKey}${sep}`)))) {
						guardDenied.add(exec);
						ensureFlow(agent).log(`[LCRD] file-flow workspace containment denied: tool=${exec.name} path=${rawPath} (outside workspace)`);
						flush(agent);
						return {
							kind: "deny",
							reason: `[LCRD] 任务产物必须写入工作区: ${workRoot}。当前路径 ${rawPath} 在工作区之外。请将任务产物(脚本、代码、数据文件)创建在工作区内,使用绝对路径;工作区之外的文件写入会被外部引擎拒绝。`
						};
					}
				}
				return next();
			}
			case "own": {
				const relative = target.slice(pinned.length + sep.length);
				if (!(relative === "" || relative === "task.md" || relative === "progress.md" || relative === "subtasks" || relative.startsWith(`subtasks${sep}`))) {
					guardDenied.add(exec);
					ensureFlow(agent).log(`[LCRD] file-flow product-in-task-dir denied: tool=${exec.name} path=${rawPath} (task dir holds flow files only)`);
					flush(agent);
					const workRoot = resolveWorkRoot(agent);
					/* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
					return {
						kind: "deny",
						reason: `[LCRD] 任务目录只存放流程文件(task.md、subtasks/*.md、progress.md);任务产物(脚本、代码、数据文件)必须创建在工作区 ${workRoot.length > 0 ? workRoot : "(见工作目录行)"},不得写入任务目录。`
					};
				}
				return next();
			}
			case "flowRoot":
			case "foreign":
			case "bootstrap": {
				guardDenied.add(exec);
				const count = (pathViolations.get(agent) ?? 0) + 1;
				pathViolations.set(agent, count);
				const recorder = ensureFlow(agent);
				recorder.log(`[LCRD] file-flow path violation (${count}/${fileFlowPathViolationsMax}): tool=${exec.name} path=${rawPath}`);
				recordTool(agent, exec);
				recorder.push({
					type: "intercept",
					kind: "missing-plan",
					detail: `path outside the task context: ${rawPath}`
				});
				flush(agent);
				if (count >= fileFlowPathViolationsMax) {
					terminated.add(agent);
					return {
						kind: "deny",
						reason: `[LCRD] 任务上下文路径连续越界 ${count} 次,幻觉严重,任务已终止转人工: ${rawPath}。停止所有工具调用,向用户报告失败原因,等待人工指令。`
					};
				}
				return {
					kind: "deny",
					reason: `[LCRD] 任务上下文越界(第 ${count}/${fileFlowPathViolationsMax} 次): ${rawPath}。${FILE_FLOW_DIR}/ 内只能读写引擎自动创建的本任务目录;其他任务的目录与 ${FILE_FLOW_DIR}/ 根目录均禁止访问。需要读写 ${FILE_FLOW_DIR}/ 之外的文件不受此限制。请重新使用正确路径。`
				};
			}
			default: return assertNever(classification);
		}
	});
	ctx.on("tools/post-execute", async (exec, result, next) => {
		if (!exec.agent) return next();
		const agent = exec.agent;
		if (guardDenied.has(exec)) return next();
		if (terminated.has(agent)) {
			ensureFlow(agent).log(`[LCRD] terminated: tool=${exec.name} blocked`);
			recordTool(agent, exec);
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
		const learningState = learning.get(agent);
		if (exec.name === "lcrd_plan" || exec.name === "lcrd_learn" || exec.name === "lcrd_learn_verify") {
			if (learningState && learningState.phase === "learn" && exec.name === "lcrd_plan") {
				ensureFlow(agent).log("[LCRD] learn phase: tool=lcrd_plan blocked (must declare learning first)");
				recordTool(agent, exec);
				ensureFlow(agent).push({
					type: "intercept",
					kind: "missing-plan",
					detail: "lcrd_plan during learn phase"
				});
				flush(agent);
				return {
					kind: "block",
					feedback: [textBlock("[LCRD] 学习阶段禁止声明任务计划。请先调用 lcrd_learn 声明学习轮次,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后才能重新声明 lcrd_plan 重解任务。")],
					additionalContexts: [createUserMessage({
						content: [textBlock("[LCRD] 当前处于学习阶段:先完成 lcrd_learn → 学习工具 → lcrd_learn_verify,再重解任务。")],
						source: {
							...PLUGIN_SOURCE,
							form: "notice",
							summary: "lcrd learn phase plan blocked"
						}
					})]
				};
			}
			return next();
		}
		if (interaction === "auto" && exec.name === "ask_user_question") {
			const recorder = ensureFlow(agent);
			recorder.markAskIntercepted();
			recorder.log("[LCRD] auto-answer: tool=ask_user_question blocked (unattended)");
			recordTool(agent, exec);
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
		if (learningState && learningState.phase === "learn") {
			if (learningToolSet.has(exec.name)) {
				learningState.evidence = true;
				recordTool(agent, exec);
				ensureFlow(agent).log(`[LCRD] learn tool: ${exec.name} passed`);
				flush(agent);
				return next();
			}
			ensureFlow(agent).log(`[LCRD] learn phase: tool=${exec.name} blocked (not a learning tool)`);
			recordTool(agent, exec);
			ensureFlow(agent).push({
				type: "intercept",
				kind: "missing-plan",
				detail: `${exec.name} during learn phase`
			});
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock(`[LCRD] 学习阶段仅允许学习工具(${[...learningToolSet].join(", ")})。请使用它们获取知识,然后调用 lcrd_learn_verify 自评;禁止执行任务工具。`)],
				additionalContexts: [createUserMessage({
					content: [textBlock(`[LCRD] 工具 ${exec.name} 被拦截:学习阶段仅允许学习工具。先完成学习与自评,再重解任务。`)],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd learn phase tool blocked"
					}
				})]
			};
		}
		const plan = plans.get(agent);
		if (!plan) {
			ensureFlow(agent).log(`[LCRD] missing plan: tool=${exec.name} blocked`);
			recordTool(agent, exec);
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
			recordTool(agent, exec);
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
		recordTool(agent, exec, result);
		if (verdict.pass) {
			noteVerdict(agent, verdict, plan.verifier.kind);
			ensureFlow(agent).push({
				type: "verdict",
				pass: true,
				reason: verdict.reason,
				verifierKind: plan.verifier.kind,
				callId: String(exec.callId),
				tool: exec.name
			});
			failures.delete(agent);
			const passedState = learning.get(agent);
			if (passedState) {
				ensureFlow(agent).push({
					type: "learn-verify",
					learned: true,
					evidence: `重解通过: ${verdict.reason}`,
					count: passedState.attempts
				});
				ensureFlow(agent).markLearningSuccess();
				ensureFlow(agent).log(`[LCRD] learning success: re-solve PASS after ${passedState.attempts} learning attempt(s), learning budget reset`);
				learning.delete(agent);
			}
			ensureFlow(agent).log(`[LCRD] verify PASS: tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
			flush(agent);
			return next();
		}
		const checkOnly = (verdict.exceptionKind === "invalid-condition" || verdict.exceptionKind === "eval-error") && !failedCheckConsumesRetry;
		const count = checkOnly ? failures.get(agent) ?? 0 : (failures.get(agent) ?? 0) + 1;
		if (!checkOnly) failures.set(agent, count);
		const invalidCount = noteVerdict(agent, verdict, plan.verifier.kind);
		ensureFlow(agent).push({
			type: "verdict",
			pass: false,
			reason: verdict.reason,
			count,
			verifierKind: plan.verifier.kind,
			callId: String(exec.callId),
			tool: exec.name,
			...verdict.exceptionKind === void 0 ? {} : { exceptionKind: verdict.exceptionKind }
		});
		if (verdict.exception === true) ensureFlow(agent).markVerifierException();
		ensureFlow(agent).log(`[LCRD] verify FAIL (${count}/${maxRetries}): tool=${exec.name} verifier=${plan.verifier.kind} reason="${verdict.reason}"`);
		if (checkOnly) {
			if (invalidCount >= maxRetries) {
				terminated.add(agent);
				const terminal = `[LCRD] 连续 ${maxRetries} 次断言被引擎判为无效,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
				return {
					kind: "block",
					feedback: [textBlock(terminal)],
					additionalContexts: [createUserMessage({
						content: [textBlock(terminal)],
						source: {
							...PLUGIN_SOURCE,
							form: "notice",
							summary: "lcrd invalid checks exhausted"
						}
					})]
				};
			}
			return {
				kind: "block",
				feedback: [textBlock(`[LCRD] 断言被引擎判为无效(第 ${invalidCount}/${maxRetries} 次,不消耗任务重试预算): ${verdict.reason}。请修正检查本身(类型引用、区分度),再声明计划重试。`)],
				additionalContexts: [createUserMessage({
					content: [textBlock(`[LCRD] 无效断言: ${verdict.reason}`)],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd invalid check"
					}
				})]
			};
		}
		if (learningEnabled && !learning.has(agent) && count >= learningThreshold) {
			learning.set(agent, {
				attempts: 0,
				phase: "learn",
				evidence: false
			});
			const notice = `[LCRD] 连续 ${count} 次校验失败,达到学习阈值(${learningThreshold}),进入学习模式(最多 ${maxLearningAttempts} 轮)。停止直接重试:先调用 lcrd_learn 分析问题与所需知识,使用学习工具获取知识,再调用 lcrd_learn_verify 自评;自评通过后重新声明 lcrd_plan 重解任务。`;
			flush(agent);
			return {
				kind: "block",
				feedback: [textBlock(notice)],
				additionalContexts: [createUserMessage({
					content: [textBlock(notice)],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd learning mode entered"
					}
				})]
			};
		}
		const activeLearning = learning.get(agent);
		if (activeLearning) {
			activeLearning.attempts += 1;
			ensureFlow(agent).push({
				type: "learn-verify",
				learned: false,
				evidence: verdict.reason,
				count: activeLearning.attempts
			});
			ensureFlow(agent).log(`[LCRD] learning round FAIL (${activeLearning.attempts}/${maxLearningAttempts}): ${verdict.reason}`);
			if (activeLearning.attempts >= maxLearningAttempts) {
				terminated.add(agent);
				const terminal = `[LCRD] 学习后重解仍失败,学习次数已用尽(${maxLearningAttempts} 次),任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
				return {
					kind: "block",
					feedback: [textBlock(terminal)],
					additionalContexts: [createUserMessage({
						content: [textBlock(terminal)],
						source: {
							...PLUGIN_SOURCE,
							form: "notice",
							summary: "lcrd learning exhausted"
						}
					})]
				};
			}
			activeLearning.phase = "learn";
			activeLearning.evidence = false;
			return {
				kind: "block",
				feedback: [textBlock(`[LCRD] 学习后重解仍失败(第 ${activeLearning.attempts}/${maxLearningAttempts} 轮): ${verdict.reason}。回到学习模式:调用 lcrd_learn 结合本次失败原因重新分析,继续学习并重新自评。`)],
				additionalContexts: [createUserMessage({
					content: [textBlock(`[LCRD] 重解失败原因(供新一轮学习分析): ${verdict.reason}`)],
					source: {
						...PLUGIN_SOURCE,
						form: "notice",
						summary: "lcrd learning round failed"
					}
				})]
			};
		}
		if (count >= maxRetries) {
			terminated.add(agent);
			const terminal = `[LCRD] 连续 ${maxRetries} 次校验失败,任务已终止转人工: ${verdict.reason}。停止所有工具调用,向用户报告失败原因,等待人工指令。`;
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
		return {
			kind: "block",
			feedback: [textBlock(`[LCRD] 校验失败(第 ${count}/${maxRetries} 次): ${verdict.reason}。工具结果已被外部引擎拒绝。请重新设计一套不同的子任务方法(更换策略或参数)并再次声明 lcrd_plan;禁止原样重试。`)],
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
export { Config, FLOW_SCHEMA_VERSION, FLOW_STREAM_FILE, FlowRecorder, PROTOCOL_VERSION, RUN_META_FILE, apply, classifyFlowPath, clipSummary, defaultLogDir, describeStrictness, fileFlowSectionText, inject, name, pluginVersion, probeExpression, probeHoldRate, relaxationAxes, resultPayload, shortAgentId, specExpressions, summarizeArguments, summarizeResult, verifyAssert };
