/**
 * The `lcrd_propose` tool: validate a proposed policy version, run the static
 * safety scan, stage the immutable version, gate it on the rotating holdout
 * subset, build the review brief, and promote it only through the configured
 * authority. Rejections happen before a version directory exists, so a bad
 * proposal never influences anything.
 *
 * @module lcrd-evolve-propose
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseString } from '../declaration.ts'
import { buildBrief, diffSkills } from './brief.ts'
import { runGate, type GateConfig, type GateLauncher } from './gate.ts'
import { loadBenchmark } from './holdout.ts'
import { skillNameTaken } from './registry.ts'
import { scanSkill, scanSkillWithModel } from './static-check.ts'
import {
  appendArchiveEntry,
  appendRejectedEdit,
  ensureStore,
  loadSkills,
  promote,
  quarantineHints,
  readHoldoutHistory,
  readManifest,
  readPointer,
  readQuarantine,
  readRejectedEdits,
  selectParent,
  stageVersion,
  setGateOutcome,
  writeGateArtifact,
  type StorePaths,
} from './store.ts'
import type { GateReport, PolicyManifest, ProposedSkill, StaticFinding } from './types.ts'

/** Propose-tool configuration. */
export interface ProposeConfig {
  /** Proposals allowed per task boundary. */
  maxProposals: number
  /** Skills one proposal may carry. */
  maxSkills: number
  /** Maximum bytes per skill body. */
  skillMaxBytes: number
  /** Clipped rationale length recorded in the manifest. */
  rationaleMax: number
  /** Whether the optional model scan runs after the rules. */
  staticScan: 'rules' | 'rules+llm'
  /** Who may promote a gated version. */
  promote: 'approval' | 'auto'
  /** Gate thresholds and budget. */
  gate: Omit<GateConfig, 'gateId' | 'seed'>
  /** The benchmark root. */
  benchmarkDir: string
  /** How many risky samples the brief renders. */
  briefTopN: number
}

/** The wiring the tool needs that lives outside the store. */
export interface ProposeHooks {
  /** Register a promoted version's skills and record it as active; awaited so the sealed audit settles before the tool returns. */
  activate: (version: string, skills: readonly ProposedSkill[]) => void | Promise<void>
  /** Append one policy-lifecycle trace record and mirror it to the flow log. */
  record: (agent: Agent, action: 'proposed' | 'gated' | 'promoted', version: string, detail: string) => void
  /** Queue the system notice for one active-policy transition. */
  notice: (agent: Agent, action: 'promoted' | 'rolled-back', from: string, to: string, reason: string) => void
}

/** Everything the tool closes over. */
export interface ProposeDeps {
  /** Plugin context, for the model scan and the approval service. */
  ctx: Context
  /** Store locations. */
  paths: StorePaths
  /** Configuration. */
  config: ProposeConfig
  /** Per-agent proposal budget. */
  proposals: WeakMap<Agent, number>
  /** Wiring callbacks. */
  hooks: ProposeHooks
  /** The gate launcher port. */
  launch: GateLauncher
  /** Optional dedicated model for the static scan; required by `rules+llm`. */
  scanModel: string | undefined
}

/** One proposed skill as the tool receives it. */
interface RawSkill {
  name?: unknown
  description?: unknown
  content?: unknown
}

/**
 * Narrow the tool's `skills` argument to validated proposals.
 * @param raw - the raw argument value.
 * @param maxBytes - the per-skill body ceiling.
 * @param maxSkills - how many skills one proposal may carry.
 * @returns the validated skills.
 * @throws when the list is empty, too long, or a member is malformed.
 */
export function parseProposedSkills(raw: unknown, maxBytes: number, maxSkills: number): ProposedSkill[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('lcrd_propose: skills 必须是非空数组')
  if (raw.length > maxSkills) throw new Error(`lcrd_propose: 一次最多提交 ${maxSkills} 个 skill`)
  const skills: ProposedSkill[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) throw new Error('lcrd_propose: skills 的每一项必须是对象')
    const skill = entry as RawSkill
    const name = parseString(skill.name, 'skills[].name')
    const description = parseString(skill.description, 'skills[].description')
    const content = parseString(skill.content, 'skills[].content')
    if (seen.has(name)) throw new Error(`lcrd_propose: skill 名称重复: ${name}`)
    seen.add(name)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > maxBytes) throw new Error(`lcrd_propose: skill ${name} 正文 ${bytes} 字节,超过上限 ${maxBytes}`)
    skills.push({ name, description, content })
  }
  return skills
}

/** Clip one hint so a long gate reason cannot flood the tool result. */
function clipHint(text: string): string {
  const max = 240
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Render the rejected-edit and quarantine history attached to a rejection or
 * gated result, so the model reads the causes without opening the store.
 * @param paths - the store locations.
 * @returns leading newline plus the newest reasons, or an empty string.
 */
async function hintText(paths: StorePaths): Promise<string> {
  const rejected = await readRejectedEdits(paths, 3).catch(() => [])
  const rejectedLines = rejected.map(edit => `- ${edit.version} (${edit.stage}): ${clipHint(edit.reasons.join('; '))}`)
  const hints = await quarantineHints(paths, 3)
  const sections: string[] = []
  if (rejectedLines.length > 0) sections.push(`\n最近被拒记录:\n${rejectedLines.join('\n')}`)
  if (hints.length > 0) sections.push(`\n最近隔离记录:\n${hints.map(hint => `- ${clipHint(hint)}`).join('\n')}`)
  return sections.join('')
}

/**
 * Render a finding list for a rejection message.
 * @param findings - the blocking findings.
 * @returns the clipped one-line summary.
 */
function renderFindings(findings: readonly StaticFinding[]): string {
  return findings
    .slice(0, 6)
    .map(finding => `${finding.severity}:${finding.rule}@${String(finding.line)}`)
    .join(', ')
}

/**
 * Record one gate outcome in the archive ledger, so parent selection can weigh
 * the approaches the gate refused as well as the ones it admitted.
 * @param paths - the store locations.
 * @param manifest - the version the gate judged.
 * @param parent - the version it was proposed against.
 * @param gateId - the gate identity.
 * @param report - the gate report; null when the gate never produced one.
 * @param reasons - why the gate refused, or why it aborted.
 */
async function recordArchive(
  paths: StorePaths,
  manifest: PolicyManifest,
  parent: string,
  gateId: string,
  report: GateReport | null,
  reasons: readonly string[],
): Promise<void> {
  const metrics: Record<GateReport['admission'], { candidate: number | null; baseline: number | null }> = {
    reward: { candidate: report?.candidate.rewardRate ?? null, baseline: report?.baseline.rewardRate ?? null },
    'self-report': { candidate: report?.candidate.passRate ?? null, baseline: report?.baseline.passRate ?? null },
  }
  const metric = report === null ? { candidate: null, baseline: null } : metrics[report.admission]
  await appendArchiveEntry(paths, {
    schemaVersion: 1,
    version: manifest.version,
    parent,
    gateId,
    admitted: report?.pass === true,
    score: metric.candidate,
    gain: metric.candidate === null || metric.baseline === null ? null : metric.candidate - metric.baseline,
    reasons: [...reasons],
    ts: new Date().toISOString(),
  })
}

/**
 * Register the `lcrd_propose` tool.
 * @param ctx - the plugin context whose tool registry receives the tool.
 * @param deps - store, config, hooks, and launcher.
 */
export function registerProposeTool(ctx: Context, deps: ProposeDeps): void {
  const { paths, config, proposals, hooks, launch } = deps
  ctx.tools.register(defineTool({
    name: 'lcrd_propose',
    description: 'Propose a new policy version of this agent\'s own skill set. Only available when the deployment enables policy evolution. '
      + 'The proposal is statically scanned for injection, identity negation, authority escalation, hidden text, and benchmark leakage; '
      + 'a blocking finding rejects it before any version exists. An accepted proposal then runs the offline gate on a rotating holdout '
      + 'subset, comparing this version against the current one. A gated version is promoted only through the configured authority '
      + '(a human approval by default); promotion switches the registered skills for later steps and sessions. '
      + 'If a previous version was quarantined, read the returned quarantineHints and avoid repeating that problem. '
      + 'Rejected proposals are also recorded; the next proposal reads their rules, lines, and gate reasons.',
    parameters: {
      rationale: { type: 'string', required: true, description: '为什么这套策略能提升任务表现;会被记录进 manifest 供人工审阅' },
      parent_version: { type: 'string', required: true, description: '本次提案基于的策略版本;必须取自引擎给出的候选父版本(当前版本始终在候选内),用于记录谱系并决定 skill 差异' },
      skills: {
        type: 'array',
        required: true,
        description: '要注册的 skill 列表;每个 skill 会在提案通过后进入模型可见的 skill 目录',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'kebab-case skill 名称,不得与现有 skill 重名' },
            description: { type: 'string', required: true, description: '模型可见的目录摘要,说明何时使用' },
            content: { type: 'string', required: true, description: 'Markdown 指令正文;不得包含越权指令、身份否定、隐藏文本或测试集引用' },
          },
        },
      },
    },
    /* jscpd:ignore-start -- protocol tools share the output/render/execute-head shape */
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('lcrd_propose requires an agent-scoped execution')
      /* jscpd:ignore-end */
      const used = proposals.get(agent) ?? 0
      if (used >= config.maxProposals) {
        throw new Error(`lcrd_propose: 本次任务已提交 ${used} 次提案,达到上限 ${config.maxProposals}`)
      }

      // The budget is charged only after cheap validation: a malformed call
      // must not consume an attempt that the gate would have paid for.
      const rationale = parseString(args.rationale, 'rationale').slice(0, config.rationaleMax)
      const parent = parseString(args.parent_version, 'parent_version')
      const skills = parseProposedSkills(args.skills, config.skillMaxBytes, config.maxSkills)

      await ensureStore(paths)
      const pointer = await readPointer(paths)
      // The revision read before staging is the CAS expectation. Re-reading it
      // just before promotion would always match and hide a concurrent switch.
      const revisionAtStart = pointer.revision
      // The engine proposes the parent, the model confirms: an archived version may
      // be a better starting point than the active one, and the active version is
      // always admissible so a refused or empty archive never blocks a proposal.
      const selection = await selectParent(paths)
      const candidates = selection === null
        ? [pointer.version]
        : [...new Set([selection.version, ...selection.alternatives, pointer.version])]
      if (!candidates.includes(parent)) {
        throw new Error(`lcrd_propose: parent_version ${parent} 不在本次可选父版本内(候选: ${candidates.join(', ')});换一个候选父版本重试`)
      }
      if (pointer.promotionHeld) {
        throw new Error(`lcrd_propose: hard-out 审计已暂停 promote;在处理该告警前不再接受提案${await hintText(paths)}`)
      }
      const parentManifest = await readManifest(paths, parent)
      // Only a promoted version is a usable baseline: a gated-passed version that
      // never went live, and a version the monitor reverted, are records rather
      // than starting points.
      if (parentManifest.status !== 'promoted') {
        throw new Error(`lcrd_propose: 父版本 ${parent} 状态为 ${parentManifest.status},不能作为基线`)
      }
      for (const skill of skills) {
        if (await skillNameTaken(deps.ctx, skill.name)) {
          throw new Error(`lcrd_propose: skill 名称 ${skill.name} 已被现有 skill 占用`)
        }
      }

      // Static scan before any version exists: a rejected proposal leaves the
      // store untouched, so it can never influence a later session. The skill
      // description is prompt-visible too, so it is scanned with the body.
      const findings: { skill: string; findings: StaticFinding[] }[] = []
      for (const skill of skills) {
        const text = `${skill.description}\n${skill.content}`
        const found = scanSkill(text)
        if (config.staticScan === 'rules+llm') {
          found.push(...await scanSkillWithModel(deps.ctx, agent, deps.scanModel, text, exec.signal))
        }
        findings.push({ skill: skill.name, findings: found })
      }
      const blocking = findings.flatMap(group => group.findings.filter(finding => finding.severity === 'block'))
      if (blocking.length > 0) {
        await appendRejectedEdit(paths, {
          schemaVersion: 1,
          version: 'unstaged',
          parent,
          ts: new Date().toISOString(),
          stage: 'static-scan',
          reasons: [renderFindings(blocking)],
          findings,
          metrics: null,
        })
        throw new Error(`lcrd_propose: 静态检查拒绝该提案(${renderFindings(blocking)}),未创建版本`)
      }

      proposals.set(agent, used + 1)
      const benchmark = await loadBenchmark(config.benchmarkDir)
      const manifest = await stageVersion(paths, {
        parent,
        authorSession: String(agent.id),
        rationale,
        benchmarkDigest: benchmark.digest,
        skills,
      })
      hooks.record(agent, 'proposed', manifest.version, `parent=${parent} skills=${skills.map(skill => skill.name).join(',')}`)

      const gateId = `${manifest.version}-${Date.now().toString(36)}`
      const history = await readHoldoutHistory(paths)
      let report
      try {
        report = await runGate({
          paths,
          config: { ...config.gate, gateId, seed: `${manifest.version}:${gateId}` },
          candidate: manifest,
          // Admission always compares against the active policy: a candidate that
          // descends from an archived parent must still beat what is live now.
          baselineVersion: pointer.version,
          benchmark,
          benchmarkDir: config.benchmarkDir,
          history,
          launch,
        })
      } catch (error) {
        /* v8 ignore next -- gate failures are Error instances */
        const message = error instanceof Error ? error.message : String(error)
        await appendRejectedEdit(paths, {
          schemaVersion: 1,
          version: manifest.version,
          parent,
          ts: new Date().toISOString(),
          stage: 'gate-aborted',
          reasons: [message],
          metrics: null,
        })
        await setGateOutcome(paths, manifest.version, gateId, benchmark.digest, 'gate-aborted')
        await recordArchive(paths, manifest, parent, gateId, null, [message])
        hooks.record(agent, 'gated', manifest.version, `aborted: ${message}`)
        throw new Error(`lcrd_propose: 门禁无法完成(${message}),版本 ${manifest.version} 标记为 gate-aborted`)
      }

      const quarantine = await readQuarantine(paths)
      const parentSkills = parentManifest.parent === null ? [] : await loadSkills(paths, parent)
      const brief = buildBrief({
        report,
        findings,
        quarantine,
        rationale,
        parentRationale: parentManifest.rationale,
        skillDiff: diffSkills(parentSkills, skills),
        promotionHeld: pointer.promotionHeld,
        topN: config.briefTopN,
      })
      const briefPath = await writeGateArtifact(paths, manifest.version, gateId, 'brief.md', brief.markdown)
      await writeGateArtifact(paths, manifest.version, gateId, 'brief.json', `${JSON.stringify(brief.json, null, 2)}\n`)
      hooks.record(agent, 'gated', manifest.version, `gate=${gateId} pass=${String(report.pass)} ${report.reasons.join('; ')}`)

      if (report.outcome === 'gate-aborted') {
        await recordArchive(paths, manifest, parent, gateId, report, report.reasons)
        await appendRejectedEdit(paths, {
          schemaVersion: 1,
          version: manifest.version,
          parent,
          ts: new Date().toISOString(),
          stage: 'gate-aborted',
          reasons: report.reasons,
          metrics: { baseline: report.baseline, candidate: report.candidate },
        })
        return `提案 ${manifest.version} 门禁中止(仪器无效): ${report.reasons.join('; ')}。candidate 未运行;版本保持 gate-aborted。预审面板: ${briefPath}${await hintText(paths)}`
      }

      if (!report.pass) {
        await recordArchive(paths, manifest, parent, gateId, report, report.reasons)
        await appendRejectedEdit(paths, {
          schemaVersion: 1,
          version: manifest.version,
          parent,
          ts: new Date().toISOString(),
          stage: 'gate-failed',
          reasons: report.reasons,
          metrics: { baseline: report.baseline, candidate: report.candidate },
        })
        return `提案 ${manifest.version} 未通过门禁: ${report.reasons.join('; ')}。版本未生效;预审面板: ${briefPath}${await hintText(paths)}`
      }

      await recordArchive(paths, manifest, parent, gateId, report, report.reasons)
      const approval = await decidePromotion(deps, agent, manifest.version, gateId, briefPath, report.reasons.join('; '), exec.signal)
      if (!approval.allowed) {
        return `提案 ${manifest.version} 通过门禁,但${approval.reason};版本保持 gated-passed,可由运维离线 promote。预审面板: ${briefPath}${await hintText(paths)}`
      }

      const promoted = await promote(paths, manifest.version, revisionAtStart, String(agent.id), gateId)
      const promotedSkills = await loadSkills(paths, manifest.version)
      await hooks.activate(manifest.version, promotedSkills)
      hooks.record(agent, 'promoted', manifest.version, `gate=${gateId} revision=${promoted.revision}`)
      hooks.notice(agent, 'promoted', parent, manifest.version, 'gate_passed')
      return `提案 ${manifest.version} 已通过门禁并 promote(指针 revision ${promoted.revision})。新的 skill 集合已注册,从下一步起生效。预审面板: ${briefPath}`
    },
  }))
}

/**
 * Ask the configured authority whether a gated version may become current.
 * `auto` promotes without asking; `approval` requests one human decision, and
 * an absent approval service or any non-grant keeps the version gated.
 * @param deps - the tool dependencies.
 * @param agent - the proposing agent.
 * @param version - the candidate version.
 * @param gateId - its gate.
 * @param briefPath - the review brief the approver can open.
 * @param summary - the gate's one-line reasons.
 * @param signal - the tool call's cancellation.
 * @returns whether promotion is allowed and, when not, why.
 */
async function decidePromotion(
  deps: ProposeDeps,
  agent: Agent,
  version: string,
  gateId: string,
  briefPath: string,
  summary: string,
  signal: AbortSignal,
): Promise<{ allowed: boolean; reason: string }> {
  if (deps.config.promote === 'auto') return { allowed: true, reason: 'auto' }
  const approval = deps.ctx.get('approval')
  if (approval === undefined) return { allowed: false, reason: '部署未组合审批服务' }
  const outcome = await approval.request({
    agent,
    toolName: 'lcrd_propose',
    reason: `Promote LCRD policy ${version} (gate ${gateId})? ${summary} Brief: ${briefPath}`,
    signal,
  })
  return outcome === 'allowed-once'
    ? { allowed: true, reason: 'approved' }
    : { allowed: false, reason: `审批结果为 ${outcome}` }
}
