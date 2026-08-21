/**
 * LCRD execution-flow recorder: every protocol event (plan, tool, verdict,
 * intercept) is appended in order, and the flow artifacts — a Mermaid
 * flowchart (viewable in VS Code, GitHub, mermaid.live), a Markdown report,
 * and a raw JSON transcript — are rewritten after every completed turn, on
 * agent disposal, and on process exit, so they stay fresh while the agent
 * lives.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { VerifierSpec } from './types.ts'

/** Where flow artifacts land: an explicit override, or the default plugin-folder location. */
export type FlowOutDir = string | undefined

/** One ordered protocol event. */
export type FlowEvent =
  | { type: 'plan'; goal: string; stop: string; feasibility: boolean; verifier: string; verifierSpec?: VerifierSpec }
  | { type: 'tool'; name: string }
  | { type: 'verdict'; pass: boolean; reason: string; count?: number }
  | { type: 'intercept'; kind: 'missing-plan' | 'infeasible' | 'terminated'; detail: string }

/** The interaction mode recorded per task, mirrored from the plugin config. */
export type InteractionMode = 'auto' | 'auth' | 'manual'

/** Machine-readable summary line emitted alongside the detailed events. */
export interface FlowMeta {
  session_id: string
  task_id: string
  md_file: string
  human_interaction_mode: InteractionMode
  hit_ask_intercepted: boolean
  lcrd_retry_consumed: number
  lcrd_retry_max: number
  goal_changed_times: number
  stop_changed_times: number
  verifier_changed_times: number
  has_verifier_exception: boolean
  final_verdict: 'pass' | 'fail' | 'terminated'
  tb_final_reward: number | null
  root_cause_hint: string | null
}

/** Walk up from this module to the nearest directory owning a `package.json`. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

/** Default log directory: a `lcrd-flow` folder inside the plugin package. */
export function defaultLogDir(): string {
  return join(packageRoot(), 'lcrd-flow')
}

/** Make a filesystem-safe, human-readable task slug. */
function slugify(text: string): string {
  const cleaned = text.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim()
  return cleaned.length === 0 ? '' : cleaned.slice(0, 60)
}

/** Stable 8-hex suffix from an agent id, disambiguating same-slug task folders. */
export function shortAgentId(id: string): string {
  let hash = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Escape node text for Mermaid syntax. */
function mermaidEscape(text: string): string {
  return text
    .replace(/"/g, '#quot;')
    .replace(/\(/g, '#40;')
    .replace(/\)/g, '#41;')
    .replace(/\[/g, '#91;')
    .replace(/\]/g, '#93;')
    .replace(/\|/g, '#124;')
    .replace(/</g, '#60;')
    .replace(/>/g, '#62;')
}

/** Clip long event text to keep the flowchart readable. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Options for {@link FlowRecorder}. */
export interface FlowRecorderOptions {
  /** Artifact directory; defaults to {@link defaultLogDir}. */
  outDir?: FlowOutDir
  /** Per-task identifier for the `task_id` meta field; defaults to the agent id (the first plan goal overrides it). */
  taskSlug?: string
  /** The interaction mode this task ran under; recorded in the meta summary. */
  interaction?: InteractionMode
  /** External Terminal-Bench sandbox reward (0/1), filled in after the run. */
  tbFinalReward?: number | null
  /** Optional root-cause label, e.g. from the external evaluator. */
  rootCauseHint?: string | null
}

/** In-order recorder for one agent's whole session (one task), one subfolder per agent. */
export class FlowRecorder {
  private readonly events: FlowEvent[] = []
  private readonly agentId: string
  private readonly maxRetries: number
  private readonly outDir: string
  private readonly interaction: InteractionMode
  private readonly tbFinalReward: number | null
  private readonly rootCauseHint: string | null
  private taskSlug: string
  private taskLabeled = false
  private logOpened = false
  private taskDirName: string | undefined
  private goalChanged = 0
  private stopChanged = 0
  private verifierChanged = 0
  private askIntercepted = false
  private verifierException = false
  private retryConsumed = 0
  private hasAnyVerdict = false
  private lastPass = false

  /** @param agent - the session owner; its id disambiguates the output files. */
  /** @param maxRetries - the configured failure budget, shown on FAIL verdicts. */
  /** @param options - artifact directory (defaults to the plugin folder), task slug, and meta inputs. */
  constructor(agent: Agent, maxRetries: number, options?: FlowRecorderOptions) {
    this.agentId = String(agent.id)
    this.maxRetries = maxRetries
    this.outDir = options?.outDir ?? defaultLogDir()
    this.taskSlug = options?.taskSlug ?? this.agentId
    this.interaction = options?.interaction ?? 'manual'
    this.tbFinalReward = options?.tbFinalReward ?? null
    this.rootCauseHint = options?.rootCauseHint ?? null
  }

  /**
   * The per-task artifact subfolder. Named after the goal slug plus a stable
   * agent-id suffix (`<goal>-<shortId>`), so the folder stays readable and two
   * agents with the same goal never collide; without a goal it falls back to
   * the agent id. Fixed at the first write so early events and later events
   * always land in the same folder.
   */
  private taskDir(): string {
    if (this.taskDirName === undefined) {
      this.taskDirName = this.taskSlug !== this.agentId
        ? `${this.taskSlug}-${shortAgentId(this.agentId)}`
        : this.agentId
    }
    return join(this.outDir, this.taskDirName)
  }

  /** Append one event; artifacts are rewritten per turn, on disposal, and on process exit. */
  push(event: FlowEvent): void {
    if (event.type === 'plan') {
      if (!this.taskLabeled) {
        const slug = slugify(event.goal)
        if (slug) {
          this.taskSlug = slug
          this.taskLabeled = true
        }
      }
      this.trackPlanChange(event)
    } else if (event.type === 'verdict') {
      this.hasAnyVerdict = true
      this.lastPass = event.pass
      if (event.count !== undefined) this.retryConsumed = event.count
    } else if (event.type === 'intercept' && event.kind === 'terminated') {
      this.retryConsumed = this.maxRetries
    }
    this.events.push(event)
  }

  /** Compare a newly declared plan against the previous one, counting contract drift. */
  private trackPlanChange(event: { goal: string; stop: string; verifier: string; verifierSpec?: VerifierSpec }): void {
    let previous: FlowEvent | undefined
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const candidate = this.events[i]
      if (candidate !== undefined && candidate.type === 'plan') {
        previous = candidate
        break
      }
    }
    if (!previous || previous.type !== 'plan') return
    if (previous.goal !== event.goal) this.goalChanged += 1
    if (previous.stop !== event.stop) this.stopChanged += 1
    const specA = previous.verifierSpec ?? previous.verifier
    const specB = event.verifierSpec ?? event.verifier
    if (JSON.stringify(specA) !== JSON.stringify(specB)) this.verifierChanged += 1
  }

  /** Record that an `ask_user_question` was auto-intercepted in unattended mode. */
  markAskIntercepted(): void {
    this.askIntercepted = true
  }

  /** Record that a verifier failure was an exception (syntax/throw/timeout/unspawnable), not an ordinary mismatch. */
  markVerifierException(): void {
    this.verifierException = true
  }

  /** Compute the machine-readable summary from the recorded state. */
  computeMeta(): FlowMeta {
    const terminal = this.events.some(
      event => event.type === 'intercept' && event.kind === 'terminated',
    )
    const finalVerdict: FlowMeta['final_verdict'] = terminal
      ? 'terminated'
      : this.hasAnyVerdict
        ? (this.lastPass ? 'pass' : 'fail')
        : 'fail'
    return {
      session_id: this.agentId,
      task_id: this.taskSlug,
      md_file: 'lcrd-flow.md',
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
      root_cause_hint: this.rootCauseHint,
    }
  }

  /** Append one line to this task's live `.log` file (and keep echoing to console). */
  log(line: string): void {
    console.log(line)
    try {
      mkdirSync(this.taskDir(), { recursive: true })
      if (!this.logOpened) {
        appendFileSync(
          join(this.taskDir(), 'lcrd-flow.log'),
          `# LCRD 任务日志 — Agent ${this.agentId} — 起始 ${new Date().toISOString()}\n`,
          'utf8',
        )
        this.logOpened = true
      }
      appendFileSync(join(this.taskDir(), 'lcrd-flow.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // logging must never break the session
    }
  }

  /** Render the Mermaid flowchart source. */
  renderMermaid(): string {
    const lines = ['flowchart TD']
    let index = 0
    let previous: string | undefined
    for (const event of this.events) {
      index += 1
      let id: string
      switch (event.type) {
        case 'plan':
          id = `P${index}`
          lines.push(`${id}["lcrd_plan: ${mermaidEscape(clip(event.goal, 40))}<br/>verifier=${event.verifier}"]`)
          break
        case 'tool':
          id = `T${index}`
          lines.push(`${id}["tool: ${mermaidEscape(event.name)}"]`)
          break
        case 'verdict': {
          id = `V${index}`
          const label = event.pass
            ? 'verify PASS'
            : `verify FAIL${event.count === undefined ? '' : ` ${event.count}/${this.maxRetries}`}`
          lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.reason, 60))}"}`)
          break
        }
        case 'intercept': {
          id = `I${index}`
          const label = event.kind === 'missing-plan'
            ? '拦截: 未声明计划'
            : event.kind === 'infeasible'
              ? '拦截: 计划不可行'
              : '终止: 连续失败转人工'
          lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.detail, 60))}"}`)
          break
        }
      }
      if (previous !== undefined) lines.push(`${previous} --> ${id}`)
      previous = id
    }
    const terminal = this.events.some(
      event => event.type === 'intercept' && event.kind === 'terminated',
    )
    lines.push(`F["${terminal ? '任务终止转人工' : '会话结束'}"]`)
    if (previous !== undefined) lines.push(`${previous} --> F`)
    return lines.join('\n')
  }

  /** Render the Markdown report embedding the flowchart. */
  renderMarkdown(): string {
    const terminal = this.events.some(
      event => event.type === 'intercept' && event.kind === 'terminated',
    )
    const rows = this.events.map((event, i) => {
      const detail = event.type === 'plan'
        ? `goal=${event.goal} / stop=${event.stop} / feasible=${String(event.feasibility)} / verifier=${event.verifier}`
        : event.type === 'tool'
          ? event.name
          : event.type === 'verdict'
            ? `${event.pass ? 'PASS' : 'FAIL'}${event.count === undefined ? '' : ` (${event.count}/${this.maxRetries})`}: ${event.reason}`
            : `${event.kind}: ${event.detail}`
      return `| ${i + 1} | \`${event.type}\` | ${detail.replaceAll('|', '\\|')} |`
    }).join('\n')
    return `# LCRD 执行流程

- Agent: \`${this.agentId}\`
- 时间: ${new Date().toISOString()}
- 结果: ${terminal ? '任务终止转人工' : '会话正常结束'}

\`\`\`mermaid
${this.renderMermaid()}
\`\`\`

## 事件时间线

| # | 类型 | 详情 |
|---|---|---|
${rows}
`
  }

  /**
   * Write the flowchart, report, and JSON transcript into the task subfolder.
   * Re-runnable: every call rewrites the current snapshot, so per-turn dumps
   * stay fresh until the final disposal or process-exit flush. Synchronous so
   * it also runs from a process-exit handler; never throws.
   */
  dump(): void {
    mkdirSync(this.taskDir(), { recursive: true })
    const base = join(this.taskDir(), 'lcrd-flow')
    writeFileSync(`${base}.md`, this.renderMarkdown(), 'utf8')
    writeFileSync(`${base}.mmd`, this.renderMermaid(), 'utf8')
    writeFileSync(`${base}.json`, JSON.stringify({ ...this.computeMeta(), events: this.events }, null, 2), 'utf8')
  }
}
