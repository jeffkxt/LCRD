/**
 * Human pre-review brief for a gated candidate: one page that surfaces the
 * verdict, the rotating draw, the token spend, the risky static findings, the
 * speculative relaxations and unhealthy runs, the parent's quarantine history,
 * and the skill diff. The reviewer reads exceptions instead of every skill
 * body; the raw report stays beside it.
 *
 * @module lcrd-evolve-brief
 */
import type { GateReport, GateSample, ProposedSkill, QuarantineEntry, StaticFinding } from './types.ts'

/** One skill's line-level change against the parent version. */
export interface SkillDiff {
  /** Skill name. */
  name: string
  /** Lines present now but not before. */
  added: number
  /** Lines present before but not now. */
  removed: number
}

/** Input for one brief. */
export interface BriefInput {
  /** The gate report. */
  report: GateReport
  /** Static findings grouped by skill name. */
  findings: readonly { skill: string; findings: readonly StaticFinding[] }[]
  /** Quarantine history of the whole policy chain. */
  quarantine: readonly QuarantineEntry[]
  /** The candidate's own justification. */
  rationale: string
  /** The parent version's justification, when it has one. */
  parentRationale: string | null
  /** Line-level skill changes against the parent. */
  skillDiff: readonly SkillDiff[]
  /** Whether the hard-out audit currently blocks promotions. */
  promotionHeld: boolean
  /** How many risky samples each section renders. */
  topN: number
}

/** One rendered brief. */
export interface Brief {
  /** The Markdown page. */
  markdown: string
  /** The same content as structured data, for tooling and tests. */
  json: Record<string, unknown>
}

/** Count non-empty lines of one body. */
function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
  return counts
}

/**
 * Compute per-skill line changes between two versions.
 * @param previous - the parent version's skills.
 * @param next - the candidate's skills.
 * @returns one diff per changed, added, or removed skill name.
 */
export function diffSkills(previous: readonly ProposedSkill[], next: readonly ProposedSkill[]): SkillDiff[] {
  const before = new Map(previous.map(skill => [skill.name, lineCounts(skill.content)]))
  const after = new Map(next.map(skill => [skill.name, lineCounts(skill.content)]))
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  const diffs: SkillDiff[] = []
  for (const name of names) {
    const oldLines = before.get(name) ?? new Map<string, number>()
    const newLines = after.get(name) ?? new Map<string, number>()
    let added = 0
    let removed = 0
    for (const [line, count] of newLines) added += Math.max(0, count - (oldLines.get(line) ?? 0))
    for (const [line, count] of oldLines) removed += Math.max(0, count - (newLines.get(line) ?? 0))
    if (added > 0 || removed > 0 || !before.has(name) || !after.has(name)) diffs.push({ name, added, removed })
  }
  return diffs
}

/** Render one sample as a bullet. */
function renderSample(sample: GateSample): string {
  return `- \`${sample.taskId}\` #${String(sample.repeat)} (${sample.version}): ${sample.termination}/${sample.finalVerdict}, `
    + `speculative-cheat ${String(sample.relaxTypes.speculative_cheat)}/${String(sample.planCount)} plans, ${String(sample.tokens)} tokens`
}

/** The one-line verdict. */
function verdictLine(report: GateReport): string {
  if (report.outcome === 'gate-aborted') {
    return 'ABORTED — the gate did not produce a candidate verdict; candidate was not run; see report.json.'
  }
  const gain = report.candidate.passRate - report.baseline.passRate
  return `${report.pass ? 'PASS' : 'FAIL'} — pass-rate ${report.baseline.passRate.toFixed(3)} → ${report.candidate.passRate.toFixed(3)} `
    + `(${gain >= 0 ? '+' : ''}${gain.toFixed(3)}), termination ${report.baseline.terminatedRate.toFixed(3)} → ${report.candidate.terminatedRate.toFixed(3)}, `
    + `cheat ${report.baseline.cheatRate.toFixed(3)} → ${report.candidate.cheatRate.toFixed(3)}`
}

/**
 * Build the one-page brief.
 * @param input - report, findings, history, rationale, and diff.
 * @returns the Markdown and structured forms.
 */
export function buildBrief(input: BriefInput): Brief {
  const { report, topN } = input
  const findings = input.findings.flatMap(group => group.findings.map(finding => ({ skill: group.skill, ...finding })))
  const riskyFindings = findings
    .sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'block' ? -1 : 1))
    .slice(0, topN)
  const unhealthy = report.samples
    .filter(sample => sample.termination !== 'completed' || sample.relaxTypes.speculative_cheat > 0)
    .sort((left, right) => right.relaxTypes.speculative_cheat - left.relaxTypes.speculative_cheat)
    .slice(0, topN)
  const quarantined = input.quarantine.slice(-topN)
  const lines: string[] = [
    `# LCRD policy gate brief — ${report.version}`,
    '',
    `- Gate: \`${report.gateId}\` (baseline \`${report.baselineVersion}\`)`,
    `- Verdict: ${verdictLine(report)}`,
    `- Detectable gain: ${report.detectability === null ? '—' : report.detectability.toFixed(3)} vs threshold ${report.minGain.toFixed(3)}`,
    `- Reasons: ${report.reasons.join('; ')}`,
    `- Tokens: baseline ${String(report.baseline.tokens)}, candidate ${String(report.candidate.tokens)}`,
    `- Holdout draw (${String(report.selectedTasks.length)} tasks, cooldown-aware): ${report.selectedTasks.map(id => `\`${id}\``).join(', ')}`,
    `- Promotions held by hard-out audit: ${input.promotionHeld ? 'YES' : 'no'}`,
    '',
    `**Candidate rationale:** ${input.rationale}`,
    '',
    `**Parent rationale:** ${input.parentRationale ?? '(bootstrap)'}`,
    '',
    '## Static check',
    '',
  ]
  if (riskyFindings.length === 0) lines.push('No static findings.', '')
  for (const finding of riskyFindings) {
    lines.push(`- **${finding.severity}** \`${finding.rule}\` in \`${finding.skill}:${String(finding.line)}\` — ${finding.excerpt}`)
  }
  lines.push('', '## Runs worth reading', '')
  if (unhealthy.length === 0) lines.push('Every run completed without a speculative relaxation.', '')
  for (const sample of unhealthy) lines.push(renderSample(sample))
  lines.push('', '## Quarantine history', '')
  if (quarantined.length === 0) lines.push('None.', '')
  for (const entry of quarantined) lines.push(`- \`${entry.version}\` (${entry.ts}): ${entry.reason}`)
  lines.push('', '## Skill changes', '')
  if (input.skillDiff.length === 0) lines.push('No line changes.')
  for (const diff of input.skillDiff) lines.push(`- \`${diff.name}\`: +${String(diff.added)} / -${String(diff.removed)} lines`)
  lines.push('')
  return {
    markdown: lines.join('\n'),
    json: {
      version: report.version,
      gateId: report.gateId,
      baselineVersion: report.baselineVersion,
      pass: report.pass,
      outcome: report.outcome,
      reasons: report.reasons,
      metrics: { baseline: report.baseline, candidate: report.candidate },
      selectedTasks: report.selectedTasks,
      promotionHeld: input.promotionHeld,
      rationale: input.rationale,
      parentRationale: input.parentRationale,
      findings: riskyFindings,
      unhealthy,
      quarantine: quarantined,
      skillDiff: input.skillDiff,
    },
  }
}
