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
import { spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessage } from '@deepseek-ai/dsh-llm';
/** Probe inputs for discrimination detection: a condition true on every probe cannot verify anything. */
const JS_PROBE_VARIANTS = [
    undefined, null, 0, 1, -1, '', 'x', false, true, [], {}, { content: 'x' },
];
/** Probe content inputs, swept together with the value variants so content-only conditions stay discriminating. */
const CONTENT_PROBE_VARIANTS = ['', 'x', 'hello', undefined, null];
/** JSON-safe probe inputs for the Python template script. */
const PYTHON_PROBE_VARIANTS = [null, 0, 1, -1, '', 'x', false, true, [], {}, { content: 'x' }];
/** JSON-safe probe content inputs for the Python template script. */
const PYTHON_CONTENT_PROBE_VARIANTS = ['', 'x', 'hello', null, 'abc'];
/** Error flags swept in the discrimination probe matrix. */
const PROBE_ERROR_FLAGS = [false, true];
/**
 * Render one tool result into the verifier payload.
 * @param result - the executed tool's canonical result.
 * @returns the payload every verifier evaluates against.
 */
export function resultPayload(result) {
    return {
        isError: result.isError,
        value: result.isError ? undefined : result.value,
        content: result.content
            .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
            .join('\n'),
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
    for (const resultVariant of JS_PROBE_VARIANTS) {
        for (const contentVariant of CONTENT_PROBE_VARIANTS) {
            for (const isErrorVariant of PROBE_ERROR_FLAGS) {
                try {
                    if (!evaluator(resultVariant, contentVariant, isErrorVariant))
                        return false;
                }
                catch {
                    return false;
                }
            }
        }
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
export function probeHoldRate(expression) {
    if (!referencesBound(expression))
        return null;
    let evaluator;
    try {
        // oxlint-disable-next-line typescript/no-implied-eval -- model-authored condition is code
        evaluator = new Function('result', 'content', 'isError', `return (${expression})`);
    }
    catch {
        return null;
    }
    let holds = 0;
    let total = 0;
    for (const resultVariant of JS_PROBE_VARIANTS) {
        for (const contentVariant of CONTENT_PROBE_VARIANTS) {
            for (const isErrorVariant of PROBE_ERROR_FLAGS) {
                total += 1;
                try {
                    if (evaluator(resultVariant, contentVariant, isErrorVariant))
                        holds += 1;
                }
                catch {
                    // A throw is a non-holding input, like the discrimination probe treats it.
                }
            }
        }
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
export function probeExpression(expression) {
    if (!referencesBound(expression))
        return 'unbound';
    let evaluator;
    try {
        // oxlint-disable-next-line typescript/no-implied-eval -- model-authored condition is code
        evaluator = new Function('result', 'content', 'isError', `return (${expression})`);
    }
    catch {
        return 'invalid';
    }
    return holdsOnAllProbes(evaluator) ? 'tautological' : 'discriminating';
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
export function verifyAssert(conditions, payload) {
    if (conditions.length === 0) {
        return {
            pass: false,
            reason: '断言列表为空: 至少需要一条作用于 result/content/isError 的表达式;空列表等于没有检查,外部执行不会放行',
            exception: true,
            exceptionKind: 'invalid-condition',
        };
    }
    if (payload.isError) {
        return { pass: false, reason: `工具执行失败,校验直接判 FAIL(错误结果无法满足停止条件): ${clipText(payload.content, 120)}` };
    }
    for (const condition of conditions) {
        if (!referencesBound(condition)) {
            return { pass: false, reason: `断言必须引用 result/content/isError 之一: ${condition}`, exception: true, exceptionKind: 'invalid-condition' };
        }
        let evaluator;
        try {
            // oxlint-disable-next-line typescript/no-implied-eval -- model-authored condition is code
            evaluator = new Function('result', 'content', 'isError', `return (${condition})`);
        }
        catch (error) {
            /* v8 ignore next -- only Error instances reach the construction catch */
            return { pass: false, reason: `断言求值失败: ${error instanceof Error ? error.message : String(error)} (条件: ${condition})`, exception: true, exceptionKind: 'invalid-condition' };
        }
        if (holdsOnAllProbes(evaluator)) {
            const negationHint = condition.includes('!')
                ? ';否定式条件对所有探测输入恒真,无法通过区分度检查,需要验证"不存在"时请使用 llm 校验器或改述为肯定式'
                : '';
            return { pass: false, reason: `断言对所有探测输入都为真,缺少区分度,请改用引用 result/content 具体内容的条件: ${condition}${negationHint}`, exception: true, exceptionKind: 'invalid-condition' };
        }
        let holds = false;
        try {
            holds = evaluator(payload.value, payload.content, false);
        }
        catch (error) {
            /* v8 ignore next -- only Error instances reach the verifier evaluation */
            const message = error instanceof Error ? error.message : String(error);
            const inHint = message.includes("Cannot use 'in' operator")
                ? ';JS 的 in 运算符只适用于对象,不适用于字符串,字符串请用 content.includes(...)/content.indexOf(...)'
                : '';
            return { pass: false, reason: `断言求值失败: ${message} (条件: ${condition});当前 result 类型: ${typeof payload.value},content 类型: ${typeof payload.content}${inHint}`, exception: true, exceptionKind: 'eval-error' };
        }
        if (!holds) {
            return { pass: false, reason: `断言不成立: ${condition} (result 类型: ${typeof payload.value})` };
        }
    }
    return { pass: true, reason: '全部断言通过' };
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
    if (checks.length === 0) {
        return {
            pass: false,
            reason: 'Python 检查列表为空: 至少需要一条作用于 result/content/isError 的表达式;空列表等于没有检查,外部执行不会放行',
            exception: true,
            exceptionKind: 'invalid-condition',
        };
    }
    for (const check of checks) {
        if (!referencesBound(check)) {
            return { pass: false, reason: `Python 检查必须引用 result/content/isError 之一: ${check}`, exception: true, exceptionKind: 'invalid-condition' };
        }
    }
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
    await writeFile(scriptPath, template, 'utf8');
    await writeFile(payloadPath, JSON.stringify({
        ...payload,
        checks,
        variants: PYTHON_PROBE_VARIANTS,
        content_variants: PYTHON_CONTENT_PROBE_VARIANTS,
    }), 'utf8');
    try {
        return await new Promise((resolve) => {
            const proc = spawn(command, [scriptPath, payloadPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                proc.kill();
                resolve({ pass: false, reason: `Python 校验脚本超时(>${timeoutMs}ms)`, exception: true, exceptionKind: 'timeout' });
            }, timeoutMs);
            proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            /* v8 ignore next -- the template script prints all verdicts to stdout; stderr only receives crashes outside the controlled paths */
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            proc.on('error', (error) => {
                clearTimeout(timer);
                resolve({ pass: false, reason: `无法启动校验脚本: ${error.message}`, exception: true, exceptionKind: 'unspawnable' });
            });
            proc.on('close', (code) => {
                clearTimeout(timer);
                const output = stdout.trim();
                if (code !== 0) {
                    resolve({ pass: false, reason: `校验脚本退出码 ${String(code)}: ${stderr.trim() || output || '(无输出)'}`, exception: true, exceptionKind: 'exit-code' });
                    return;
                }
                if (output.startsWith('PASS')) {
                    resolve({ pass: true, reason: output.slice(4).replace(/^[:：]/, '').trim() || '脚本通过' });
                    return;
                }
                /* v8 ignore start -- the template script always prints PASS or FAIL, so an empty output is unreachable */
                const reason = output.replace(/^FAIL[:：]/, '').trim()
                    || '(脚本未输出 PASS/FAIL)';
                /* v8 ignore stop */
                const isException = /求值失败|缺少区分度|必须引用/.test(reason);
                // The template separates a rejected check from a check that threw while running.
                resolve({
                    pass: false,
                    reason,
                    exception: isException,
                    ...(isException ? { exceptionKind: reason.includes('求值失败') ? 'eval-error' : 'invalid-condition' } : {}),
                });
            });
        });
    }
    finally {
        /* v8 ignore start -- temp-file cleanup fails only on filesystem errors */
        await unlink(scriptPath).catch(() => { });
        await unlink(payloadPath).catch(() => { });
        /* v8 ignore stop */
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
    if (agent.options.provider === undefined || agent.options.model === undefined) {
        return { pass: false, reason: 'LLM 校验器无法运行: agent 未配置 provider/model', exception: true, exceptionKind: 'no-provider' };
    }
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
                role: 'user',
                content: [{ type: 'text', text: `需要校验的工具执行结果:\n${JSON.stringify(payload)}` }],
                source: { kind: 'plugin', plugin: 'lcrd-hard-isolation' },
            })],
        temperature: 0,
        maxTokens: 1024,
        signal,
    };
    let text = '';
    for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta')
            text += chunk.text;
    }
    const match = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (!match) {
        return { pass: false, reason: `校验器未返回 JSON 判定: ${text.slice(0, 200)}`, exception: true, exceptionKind: 'bad-output' };
    }
    try {
        const parsed = JSON.parse(match[0]);
        const verdictRaw = parsed.verdict;
        const verdict = (typeof verdictRaw === 'string' ? verdictRaw : '').toUpperCase();
        const reason = typeof parsed.reason === 'string' ? parsed.reason : '(无理由)';
        return verdict === 'PASS'
            ? { pass: true, reason }
            : { pass: false, reason: reason || 'LLM 校验器判定 FAIL' };
    }
    catch {
        return { pass: false, reason: `校验器 JSON 解析失败: ${text.slice(0, 200)}`, exception: true, exceptionKind: 'bad-output' };
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
export async function runVerifier(ctx, agent, verifier, result, options, plan, signal) {
    const payload = resultPayload(result);
    switch (verifier.kind) {
        case 'assert':
            return verifyAssert(verifier.conditions, payload);
        case 'python':
            return verifyPython(options.pythonCommand, options.pythonTimeoutMs, verifier.checks, payload);
        case 'llm':
            return verifyLlm(ctx, agent, options.verifierModel, options.anchorText, plan, payload, signal);
    }
}
//# sourceMappingURL=verifiers.js.map