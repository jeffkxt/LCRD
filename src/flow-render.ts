/**
 * The flow renderer: the Mermaid flowchart and the Markdown report derived from
 * one recorder state. Kept apart from the recorder so a presentation change
 * never touches the record path.
 */
import type { RecordedFlowEvent } from './flow.ts'
import { clip, isTerminalIntercept, mermaidEscape } from './flow-format.ts'

/** The recorder state one render reads. */
export interface FlowRenderState {
  /** Ordered protocol events. */
  readonly events: readonly RecordedFlowEvent[]
  /** Consecutive failures that terminate the task. */
  readonly maxRetries: number
  /** Learning rounds before human review. */
  readonly maxLearningAttempts: number
  /** Session id the artifacts name. */
  readonly agentId: string
}

export function renderMermaidFlow(state: FlowRenderState): string {
  const lines = ['flowchart TD']
  let index = 0
  let previous: string | undefined
  for (const event of state.events) {
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
          : `verify FAIL${event.count === undefined ? '' : ` ${event.count}/${state.maxRetries}`}`
        lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.reason, 60))}"}`)
        break
      }
      case 'learn':
        id = `L${index}`
        lines.push(`${id}["lcrd_learn: ${mermaidEscape(clip(event.analysis, 30))}<br/>learn=${mermaidEscape(clip(event.method, 30))}"]`)
        break
      case 'learn-verify': {
        id = `LV${index}`
        const label = event.learned
          ? 'learn PASS'
          : `learn FAIL${event.count === undefined ? '' : ` ${event.count}/${state.maxLearningAttempts}`}`
        lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.evidence, 60))}"}`)
        break
      }
      case 'intercept': {
        id = `I${index}`
        const label = event.kind === 'missing-plan'
          ? '拦截: 未声明计划'
          : event.kind === 'infeasible'
            ? '拦截: 计划不可行'
            : event.kind === 'hook-denied'
              ? '拦截: 策略拒绝声明'
              : event.kind === 'hook-blocked'
                ? '拦截: 策略拒绝结果'
                : event.kind === 'hook-error'
                  ? '拦截: 策略检查异常'
                  : event.kind === 'hook-terminated'
                    ? '终止: 策略终止转人工'
                    : '终止: 连续失败转人工'
        lines.push(`${id}{"${mermaidEscape(label)}<br/>${mermaidEscape(clip(event.detail, 60))}"}`)
        break
      }
    }
    if (previous !== undefined) lines.push(`${previous} --> ${id}`)
    previous = id
  }
  const terminal = state.events.some(
    event => event.type === 'intercept' && isTerminalIntercept(event.kind),
  )
  lines.push(`F["${terminal ? '任务终止转人工' : '会话结束'}"]`)
  if (previous !== undefined) lines.push(`${previous} --> F`)
  return lines.join('\n')
}


export function renderMarkdownFlow(state: FlowRenderState): string {
  const terminal = state.events.some(
    event => event.type === 'intercept' && isTerminalIntercept(event.kind),
  )
  const rows = state.events.map((event, i) => {
    const detail = event.type === 'plan'
      ? `goal=${event.goal} / stop=${event.stop} / feasible=${String(event.feasibility)} / verifier=${event.verifier}`
      : event.type === 'tool'
        ? event.name
        : event.type === 'verdict'
          ? `${event.pass ? 'PASS' : 'FAIL'}${event.count === undefined ? '' : ` (${event.count}/${state.maxRetries})`}: ${event.reason}`
          : event.type === 'learn'
            ? `analysis=${event.analysis} / knowledge=${event.knowledge} / method=${event.method} / criteria=${event.criteria}`
            : event.type === 'learn-verify'
              ? `${event.learned ? 'PASS' : 'FAIL'}${event.count === undefined ? '' : ` (${event.count}/${state.maxLearningAttempts})`}: ${event.evidence}`
              : `${event.kind}: ${event.detail}`
    return `| ${i + 1} | \`${event.type}\` | ${detail.replaceAll('|', '\\|')} |`
  }).join('\n')
  return `# LCRD 执行流程

- Agent: \`${state.agentId}\`
- 时间: ${new Date().toISOString()}
- 结果: ${terminal ? '任务终止转人工' : '会话正常结束'}

\`\`\`mermaid
${renderMermaidFlow(state)}
\`\`\`

## 事件时间线

| # | 类型 | 详情 |
|---|---|---|
${rows}
`
}

