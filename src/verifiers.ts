/**
 * The three verifier implementations the model may choose. Verification
 * programs are plugin-owned: the model supplies only expressions over
 * `result` (code verifiers) or nothing (LLM verifier), never the pass
 * criterion itself. Expressions must reference `result` and hold on at least
 * one probe input while failing on another — a condition true for every probe
 * ("missing discrimination") is rejected, closing the self-pass attack.
 */
import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { StepPlan, Verdict, VerifierSpec } from './types.ts'

/** Payload handed to every verifier: the error flag, the canonical value, and the model-facing text. */
export interface VerifyPayload {
  isError: boolean
  value: unknown
  content: string
}

/** Probe inputs for discrimination detection: a condition true on every probe cannot verify anything. */
const JS_PROBE_VARIANTS: unknown[] = [
  undefined, null, 0, 1, -1, '', 'x', false, true, [], {}, { content: 'x' },
]

/** JSON-safe probe inputs for the Python template script. */
const PYTHON_PROBE_VARIANTS: unknown[] = [null, 0, 1, -1, '', 'x', false, true, [], {}, { content: 'x' }]

/** Render one tool result into the verifier payload. */
export function resultPayload(result: ToolExecutionResult): VerifyPayload {
  return {
    isError: result.isError,
    value: result.isError ? undefined : result.value,
    content: result.content
      .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
      .join('\n'),
  }
}

/** Whether the model-written expression actually uses the result. */
function referencesResult(expression: string): boolean {
  return /\bresult\b/.test(expression)
}

/** Structured assertions: every condition is a JS expression over `result`; all must hold and none may be trivially true. */
export function verifyAssert(conditions: string[], payload: VerifyPayload): Verdict {
  for (const condition of conditions) {
    if (!referencesResult(condition)) {
      return { pass: false, reason: `断言必须引用 result: ${condition}`, exception: true }
    }
    let holdsOnEveryProbe = true
    for (const variant of JS_PROBE_VARIANTS) {
      try {
        // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call -- model-authored condition is code
        if (!Boolean(new Function('result', `return (${condition})`)(variant))) {
          holdsOnEveryProbe = false
          break
        }
      } catch {
        holdsOnEveryProbe = false
        break
      }
    }
    if (holdsOnEveryProbe) {
      return { pass: false, reason: `断言对所有探测输入都为真,缺少区分度,请改用引用 result 具体内容的条件: ${condition}`, exception: true }
    }
    let holds = false
    try {
      // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call -- model-authored condition is code
      holds = Boolean(new Function('result', `return (${condition})`)(payload.isError ? undefined : payload.value))
    } catch (error) {
      return { pass: false, reason: `断言求值失败: ${error instanceof Error ? error.message : String(error)} (条件: ${condition})`, exception: true }
    }
    if (!holds) {
      return { pass: false, reason: `断言不成立: ${condition}` }
    }
  }
  return { pass: true, reason: '全部断言通过' }
}

/**
 * Python verifier: the plugin-owned template script embeds the model's
 * expression list as data, performs the same discrimination probe, then
 * evaluates every expression against the result. A script that hangs past the
 * timeout is killed and counts as a failure.
 */
async function verifyPython(
  command: string,
  timeoutMs: number,
  checks: string[],
  payload: VerifyPayload,
): Promise<Verdict> {
  for (const check of checks) {
    if (!referencesResult(check)) {
      return { pass: false, reason: `Python 检查必须引用 result: ${check}` }
    }
  }
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
`
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scriptPath = join(tmpdir(), `lcrd-verify-${suffix}.py`)
  const payloadPath = join(tmpdir(), `lcrd-result-${suffix}.json`)
  await writeFile(scriptPath, template, 'utf8')
  await writeFile(payloadPath, JSON.stringify(payload), 'utf8')
  try {
    return await new Promise<Verdict>((resolve) => {
      const proc = spawn(command, [scriptPath, payloadPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        proc.kill()
        resolve({ pass: false, reason: `Python 校验脚本超时(>${timeoutMs}ms)`, exception: true })
      }, timeoutMs)
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      proc.on('error', (error) => {
        clearTimeout(timer)
        resolve({ pass: false, reason: `无法启动校验脚本: ${error.message}`, exception: true })
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        const output = stdout.trim()
        if (code !== 0) {
          resolve({ pass: false, reason: `校验脚本退出码 ${String(code)}: ${stderr.trim() || output || '(无输出)'}`, exception: true })
          return
        }
        if (output.startsWith('PASS')) {
          resolve({ pass: true, reason: output.slice(4).replace(/^[:：]/, '').trim() || '脚本通过' })
          return
        }
        const reason = output.replace(/^FAIL[:：]/, '').trim() || '(脚本未输出 PASS/FAIL)'
        const isException = /求值失败|缺少区分度|必须引用/.test(reason)
        resolve({ pass: false, reason, exception: isException })
      })
    })
  } finally {
    await unlink(scriptPath).catch(() => {})
    await unlink(payloadPath).catch(() => {})
  }
}

/**
 * LLM verifier: an independent session with a plugin-owned prompt that pins
 * the protocol and the model's own goal/stop-condition, and no conversation
 * history. The model cannot supply or alter the verifier prompt, so it cannot
 * instruct the verifier to pass. Non-JSON or non-PASS output counts as a
 * failure (strict by design).
 */
async function verifyLlm(
  ctx: Context,
  agent: Agent,
  verifierModel: string | undefined,
  anchorText: string,
  plan: StepPlan,
  payload: VerifyPayload,
  signal: AbortSignal,
): Promise<Verdict> {
  if (agent.options.provider === undefined || agent.options.model === undefined) {
    return { pass: false, reason: 'LLM 校验器无法运行: agent 未配置 provider/model' }
  }
  const options: GenerateOptions = {
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
  }
  let text = ''
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  const match = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
  if (!match) {
    return { pass: false, reason: `校验器未返回 JSON 判定: ${text.slice(0, 200)}`, exception: true }
  }
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown }
    const verdictRaw = parsed.verdict
    const verdict = (typeof verdictRaw === 'string' ? verdictRaw : '').toUpperCase()
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '(无理由)'
    return verdict === 'PASS'
      ? { pass: true, reason }
      : { pass: false, reason: reason || 'LLM 校验器判定 FAIL' }
  } catch {
    return { pass: false, reason: `校验器 JSON 解析失败: ${text.slice(0, 200)}`, exception: true }
  }
}

/** Run the verifier declared in the step plan. */
export async function runVerifier(
  ctx: Context,
  agent: Agent,
  verifier: VerifierSpec,
  result: ToolExecutionResult,
  options: { pythonCommand: string; pythonTimeoutMs: number; verifierModel: string | undefined; anchorText: string },
  plan: StepPlan,
  signal: AbortSignal,
): Promise<Verdict> {
  const payload = resultPayload(result)
  switch (verifier.kind) {
    case 'assert':
      return verifyAssert(verifier.conditions, payload)
    case 'python':
      return verifyPython(options.pythonCommand, options.pythonTimeoutMs, verifier.checks, payload)
    case 'llm':
      return verifyLlm(ctx, agent, options.verifierModel, options.anchorText, plan, payload, signal)
  }
}
