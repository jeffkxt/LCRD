/**
 * Formatting helpers shared by the flow recorder: the terminal-intercept test
 * and the Mermaid/Markdown text escapes. Pure functions with no recorder
 * state, so both the recorder and its renderer can use them.
 */

/** Whether an intercept kind ends the task for human review. */
export function isTerminalIntercept(kind: string): boolean {
  return kind === 'terminated' || kind === 'hook-terminated'
}

/** Escape one label for the Mermaid flowchart source. */
export function mermaidEscape(text: string): string {
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
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
