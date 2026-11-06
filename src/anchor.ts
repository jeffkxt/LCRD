/**
 * Root-anchor registration: a static system-prompt section that pins the
 * three-symbol protocol and the root-anchor semantics. The anchor itself is
 * the user's first message in the conversation; the model has no permission
 * to modify or expand it.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The system-prompt section name the root-anchor protocol registers under. */
export const PROTOCOL_SECTION_NAME = 'lcrd-hard-isolation'

/**
 * Version of the injected protocol: the anchor section text below plus the
 * corrective notices the rollback path sends. Bump it whenever either changes,
 * so runs recorded under different instruction sets stay distinguishable.
 */
export const PROTOCOL_VERSION = 4

/** The protocol text; also injected into LLM verifier prompts as the anchor against which results are judged. */
export const PROTOCOL_TEXT = `[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(表达式列表,每条作用于 result(工具的结构化值)/content(渲染文本)/isError(错误标记),至少引用其一,且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过;表达式只支持比较、逻辑、typeof/in、属性读取与只读方法(includes/startsWith/endsWith/get/some/every 等),不支持 this、函数构造、正则字面量、动态 import 与循环;工具执行失败时校验直接判 FAIL;assert 另有 mode:oracle(默认,断言绑定本步,不成立即退回)或 probe(断言是对结果的预测,未命中只记录并提示,不拒绝结果、不消耗重试预算,用于结果无法预先知道的探索步骤));python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert,额外注入 json 模块);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
5. 根锚内部存在矛盾时,你可以在顶层边界之内权衡;任何输出不得违背根锚约束。
6. 自我改进(仅当部署注册了 lcrd_propose 时):你可以提交新的 skill 策略版本来改进自己的执行方法,但不得修改根锚、不得绕过或削弱校验器、不得在 skill 中写入越权指令。提案会先过静态检查,再在隐藏基准上与本版本对比;通过后仍需人工审批才生效。若某个提案版本被 quarantine 隔离,先阅读返回的 quarantineHints(或 policy/quarantine.json 中的 reason),并在下一次提案中规避同一个问题。`

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
