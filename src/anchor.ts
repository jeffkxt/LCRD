/**
 * Root-anchor registration: a static system-prompt section that pins the
 * three-symbol protocol and the root-anchor semantics. The anchor itself is
 * the user's first message in the conversation; the model has no permission
 * to modify or expand it.
 */
import type { Context } from '@deepseek-ai/cordis'

export const PROTOCOL_SECTION_NAME = 'lcrd-hard-isolation'

/** The protocol text; also injected into LLM verifier prompts as the anchor against which results are judged. */
export const PROTOCOL_TEXT = `[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result,必须引用 result 且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
5. 根锚内部存在矛盾时,你可以在顶层边界之内权衡;任何输出不得违背根锚约束。`

/**
 * Register the protocol section in the calling context's scope. Order 200
 * places it after tool guidance (100-199) and before later context.
 * @param ctx - plugin context; the registration is disposed with it.
 */
export function registerAnchorSection(ctx: Context): void {
  ctx.systemPrompt.section({
    name: PROTOCOL_SECTION_NAME,
    order: 200,
    text: PROTOCOL_TEXT,
  })
}
