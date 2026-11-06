/**
 * File-flow pre-execute guard: hard isolation for task-context paths under
 * the `task-flow/` root while `fileFlowEnabled` is on. Creates and pins the
 * agent's task directory on first access, enforces the launch gate, workspace
 * containment, the flow-file whitelist, and the path-violation cap. Takes
 * state and the recorder bridge once so this module never imports the wiring
 * root.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { classifyFlowPath, FILE_FLOW_DIR } from './file-flow.ts'
import { denyDecision } from './notice.ts'
import type { LcrdState } from './state.ts'
import type { FlowRecorder } from './flow.ts'

/** The recorder operations the file-flow guard uses — a structural subset of the full bridge. */
export interface FileFlowGuardBridge {
  /** Lazily create (or fetch) the agent's flow recorder. */
  ensureFlow: (agent: Agent) => FlowRecorder
  /** Rewrite the flow artifacts for one agent's recorder, if any; never throws. */
  flush: (agent: Agent) => void
  /** Record one tool event on the flow (path violations also record the tool call). */
  recordTool: (
    owner: Agent,
    exec: { readonly name: string; readonly callId: unknown; readonly arguments: unknown },
  ) => void
}

/** State and configuration the file-flow guard closes over. */
export interface FileFlowGuardDeps {
  /** Mutable containers the guard mutates (task dirs, path violations, termination). */
  state: Pick<LcrdState, 'taskDirs' | 'guardDenied' | 'pathViolations' | 'terminated'>
  /** Shared recorder operations (ensureFlow / flush / recordTool). */
  bridge: FileFlowGuardBridge
  /** Absolute task-flow root (a sibling of the flow-log directory). */
  taskFlowRoot: string
  /** Guarded tool names (default `str_replace_editor`, `write`, `edit`). */
  fileFlowToolSet: Set<string>
  /** Consecutive path violations that terminate the task. */
  fileFlowPathViolationsMax: number
  /** Workspace-root resolver: explicit config, session cwd, sandbox root, DSH_CWD, then the fs root. */
  resolveWorkRoot: (agent?: Agent) => string
}

/**
 * Create the agent's task-flow context directory directly (bypassing tool
 * sandboxes) and pin it. Named `taskflow-<uuid>` (the agent id without its
 * `session-` prefix) — deliberately different from the flow-log folder
 * naming, so the model never confuses the two; on collision an entropy
 * suffix disambiguates so tasks never overwrite each other. The directory
 * starts EMPTY: the model must create task.md / subtasks / progress.md in
 * it.
 * @param ctx - plugin context (fs seam for path canonicalization).
 * @param taskDirs - the pinned-directory map for this plugin instance.
 * @param taskFlowRoot - absolute task-flow root under which the dir is created.
 * @param agent - the owning agent.
 * @returns the canonical pinned task directory.
 */
export async function ensureTaskDir(
  ctx: Context,
  taskDirs: LcrdState['taskDirs'],
  taskFlowRoot: string,
  agent: Agent,
): Promise<string> {
  const agentUuid = agent.id.startsWith('session-') ? agent.id.slice('session-'.length) : agent.id
  let dirName = `taskflow-${agentUuid}`
  let dir = join(taskFlowRoot, dirName)
  if (existsSync(dir)) {
    dirName += `-${Date.now().toString(36).slice(-4)}`
    dir = join(taskFlowRoot, dirName)
  }
  mkdirSync(dir, { recursive: true })
  const pinned = ctx.fs.processPath(await ctx.fs.resolve(dir))
  taskDirs.set(agent, pinned)
  return pinned
}

/**
 * Register the `tools/pre-execute` file-flow guard listener.
 * @param ctx - plugin context whose event bus receives the listener.
 * @param deps - state, bridge, and config the guard closes over.
 */
export function registerFileFlowGuard(ctx: Context, deps: FileFlowGuardDeps): void {
  const { state, bridge, taskFlowRoot, fileFlowToolSet, fileFlowPathViolationsMax, resolveWorkRoot } = deps
  const { taskDirs, guardDenied, pathViolations, terminated } = state
  const { ensureFlow, flush, recordTool } = bridge

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
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (!agent || !fileFlowToolSet.has(exec.name)) return next()
    const rawPath = (exec.arguments as { path?: unknown }).path
    if (typeof rawPath !== 'string' || rawPath.length === 0) return next()
    /* v8 ignore start -- a path both the guard and the file tool resolve through the same fs seam, which surfaces its own errors */
    let flowRoot: string
    let target: string
    try {
      const fs: FileSystem = ctx.fs
      flowRoot = fs.processPath(await fs.resolve(taskFlowRoot, { signal: exec.signal }))
      target = fs.processPath(await fs.resolve(rawPath, { signal: exec.signal }))
    } catch {
      // Unresolvable path: let the tool surface the real error.
      return next()
    }
    /* v8 ignore stop */

    // Launch gate: before the task directory is pinned, create it directly
    // (plugin-owned, so sandboxes and model naming cannot block it) and deny
    // this first file operation with guidance. The denial is guidance, not a
    // counted violation.
    const pinned = taskDirs.get(agent)
    if (pinned === undefined) {
      let taskDir: string
      /* v8 ignore start -- task-dir creation fails only on filesystem permission errors */
      try {
        taskDir = await ensureTaskDir(ctx, taskDirs, taskFlowRoot, agent)
      } catch {
        // Task-dir creation failed: let the tool surface its own error.
        return next()
      }
      /* v8 ignore stop */
      guardDenied.add(exec)
      const recorder = ensureFlow(agent)
      recorder.log(`[LCRD] file-flow launch gate: tool=${exec.name} path=${rawPath} denied (task dir auto-created: ${taskDir})`)
      flush(agent)
      const workRoot = resolveWorkRoot(agent)
      /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
      return denyDecision(
        `[LCRD] 任务目录已自动创建(空目录,尚无任何文件): ${taskDir}。强制第一步:必须先在本任务目录下创建 task.md、subtasks/*.md、progress.md(全部 pending),再执行其他文件操作;禁止以读取日志或目录列表代替创建文件。任务产物(脚本、代码、数据文件)必须创建在工作区,禁止写入任务目录。当前路径 ${rawPath} 不在任务目录内;当前工作目录为 ${workRoot.length > 0 ? workRoot : '(未解析)'}。`,
      )
    }

    const classification = classifyFlowPath(flowRoot, pinned, target)
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
            && (exec.arguments as { command?: unknown }).command !== 'view')
        const workRoot = resolveWorkRoot(agent)
        /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
        if (isMutation && workRoot.length > 0) {
          let workRootKey = ''
          try {
            workRootKey = ctx.fs.processPath(await ctx.fs.resolve(workRoot, { signal: exec.signal }))
          } catch {
            // Unresolvable workspace root: skip containment for this call.
          }
          const inside = workRootKey.length > 0
            && (target === workRootKey || target.startsWith(`${workRootKey}${sep}`))
          if (!inside) {
            guardDenied.add(exec)
            const recorder = ensureFlow(agent)
            recorder.log(`[LCRD] file-flow workspace containment denied: tool=${exec.name} path=${rawPath} (outside workspace)`)
            flush(agent)
            return denyDecision(
              `[LCRD] 任务产物必须写入工作区: ${workRoot}。当前路径 ${rawPath} 在工作区之外。请将任务产物(脚本、代码、数据文件)创建在工作区内,使用绝对路径;工作区之外的文件写入会被外部引擎拒绝。`,
            )
          }
        }
        // 任务上下文之外不拦截
        return next()
      }
      case 'own': {
        // Flow-file whitelist: the task directory holds only the context
        // files; task products (scripts, code, data) belong in the workspace.
        const relative = target.slice(pinned.length + sep.length)
        const isFlowFile = relative === ''
          || relative === 'task.md'
          || relative === 'progress.md'
          || relative === 'subtasks'
          || relative.startsWith(`subtasks${sep}`)
        if (!isFlowFile) {
          guardDenied.add(exec)
          const recorder = ensureFlow(agent)
          recorder.log(`[LCRD] file-flow product-in-task-dir denied: tool=${exec.name} path=${rawPath} (task dir holds flow files only)`)
          flush(agent)
          const workRoot = resolveWorkRoot(agent)
          /* v8 ignore next -- the workspace root is unresolvable only while the fs-root resolution is pending or the backend fails */
          return denyDecision(
            `[LCRD] 任务目录只存放流程文件(task.md、subtasks/*.md、progress.md);任务产物(脚本、代码、数据文件)必须创建在工作区 ${workRoot.length > 0 ? workRoot : '(见工作目录行)'},不得写入任务目录。`,
          )
        }
        return next()
      }
      case 'flowRoot':
      case 'foreign':
      case 'bootstrap': {
        // Unreachable with a pinned task directory: the classifier only
        // reports bootstrap before pinning. Kept for exhaustiveness; denied
        // like foreign if it ever fires.
        guardDenied.add(exec)
        const count = (pathViolations.get(agent) ?? 0) + 1
        pathViolations.set(agent, count)
        const recorder = ensureFlow(agent)
        recorder.markPathViolation()
        recorder.log(`[LCRD] file-flow path violation (${count}/${fileFlowPathViolationsMax}): tool=${exec.name} path=${rawPath}`)
        recordTool(agent, exec)

        recorder.push({ type: 'intercept', kind: 'missing-plan', detail: `path outside the task context: ${rawPath}` })
        flush(agent)
        if (count >= fileFlowPathViolationsMax) {
          terminated.add(agent)
          return denyDecision(
            `[LCRD] 任务上下文路径连续越界 ${count} 次,幻觉严重,任务已终止转人工: ${rawPath}。停止所有工具调用,向用户报告失败原因,等待人工指令。`,
          )
        }
        return denyDecision(
          `[LCRD] 任务上下文越界(第 ${count}/${fileFlowPathViolationsMax} 次): ${rawPath}。${FILE_FLOW_DIR}/ 内只能读写引擎自动创建的本任务目录;其他任务的目录与 ${FILE_FLOW_DIR}/ 根目录均禁止访问。需要读写 ${FILE_FLOW_DIR}/ 之外的文件不受此限制。请重新使用正确路径。`,
        )
      }
      default:
        return assertNever(classification)
    }
  })
}
