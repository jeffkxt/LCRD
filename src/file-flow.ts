/**
 * File-backed task-flow protocol: a system-prompt section that teaches the
 * model to keep the task breakdown, per-subtask files, and a progress file on
 * disk, execute subtasks one by one, and validate the whole task at the end.
 * Registered only when `fileFlowEnabled` is on, for minimal deployments
 * without web tools; the plugin enforces nothing about the files themselves —
 * the model owns them through the existing bash / str_replace_editor tools.
 * Hard isolation applies only to the task context: paths under the
 * `task-flow/` root are policed, everything else passes through unguarded.
 * The root sits next to the plugin's flow-log directory (the plugin package
 * root by default), so task context persists at a stable location
 * independent of the model's execution directory.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sep } from 'node:path'

/** The system-prompt section name the file-flow protocol registers under. */
export const FILE_FLOW_SECTION_NAME = 'lcrd-file-flow'

/** The file-flow directory name, a sibling of the plugin's lcrd-flow log dir (distinct from it). */
export const FILE_FLOW_DIR = 'task-flow'

/**
 * The file-flow protocol text with the real absolute flow root and workspace
 * root substituted, so the model knows exactly where to create its task
 * directory and where task products belong.
 * @param flowRoot - the absolute task-flow root (a sibling of the flow-log directory).
 * @param workRoot - the absolute workspace root for task products; empty when unresolvable.
 * @returns the fixed section text.
 */
export function fileFlowSectionText(flowRoot: string, workRoot: string): string {
  const workRootLine = workRoot.length > 0
    ? `0. 工作目录:当前工作目录绝对路径为 ${workRoot},任务产物(脚本、代码、数据文件)只能创建在工作区内,工作区之外的文件写入会被外部引擎拒绝;执行 shell 命令前必须先 cd 切换到工作区(Windows: cd /d ${workRoot}),确保命令的当前目录就是工作区;使用绝对路径,不要使用相对路径或环境提示的别名(如 /repo)。\n`
    : ''
  return `${workRootLine}[LCRD 文件化任务流程] 本协议由外部引擎强制注入,任务开始即生效。
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
5. 边界:硬隔离只作用于任务上下文——${flowRoot}/ 目录内的读写受外部引擎约束,每个任务只能访问引擎自动创建的本任务目录,禁止读写其他任务的目录或 ${flowRoot}/ 根目录,越界会被拒绝并计数,连续越界达到上限即终止任务;${flowRoot}/ 之外的文件读写不受本协议限制。`
}

/** One possible verdict for a file-flow path, against the agent's pinned task directory. */
export type FlowPathClass =
  /** The path lies outside the task-flow root; the guard passes it through. */
  | { kind: 'outside' }
  /** The path is the task-flow root itself before any task directory is pinned; denied with guidance, not counted. */
  | { kind: 'flowRoot' }
  /** First task-context access: the path names the agent's own task subdirectory, which gets pinned. */
  | { kind: 'bootstrap'; taskDir: string }
  /** The path lies inside the agent's pinned task directory; allowed. */
  | { kind: 'own' }
  /** The path lies under the task-flow root but outside the pinned task directory; denied and counted. */
  | { kind: 'foreign' }

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
export function classifyFlowPath(flowRoot: string, taskDir: string | undefined, target: string): FlowPathClass {
  /* v8 ignore start -- pure prefix helper, fully covered through the classifyFlowPath unit suite */
  const within = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(`${parent}${sep}`)
  /* v8 ignore stop */
  if (!within(flowRoot, target)) return { kind: 'outside' }
  /* v8 ignore next -- split always yields a non-empty array, so the nullish fallback is unreachable */
  const slug = target.slice(flowRoot.length + sep.length).split(sep)[0] ?? ''
  if (slug.length === 0) {
    return taskDir === undefined ? { kind: 'flowRoot' } : { kind: 'foreign' }
  }
  if (taskDir === undefined) {
    return { kind: 'bootstrap', taskDir: `${flowRoot}${sep}${slug}` }
  }
  if (within(taskDir, target)) return { kind: 'own' }
  return { kind: 'foreign' }
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
export function registerFileFlowSection(ctx: Context, flowRoot: string, workRootProvider?: (agent?: Agent) => string): void {
  ctx.systemPrompt.section({
    name: FILE_FLOW_SECTION_NAME,
    order: 210,
    text: context => fileFlowSectionText(flowRoot, workRootProvider?.(context.agent) ?? ''),
  })
}
