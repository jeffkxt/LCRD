/**
 * Policy-evolution wiring: load the active version, register its skills, expose
 * the `lcrd_propose` tool when evolution is enabled, fold every finished run
 * into the online monitor, and keep the active registration in step with
 * promotions and rollbacks. Gate children mount one candidate version with
 * evolution disabled, so a measurement run can never propose.
 *
 * @module lcrd-evolve
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { FlowRecorder } from '../flow.ts'
import { policyNotice, policyNoticeText } from '../notice.ts'
import { auditHardout } from './hardout.ts'
import { loadBenchmark } from './holdout.ts'
import { createGateLauncher } from './launch.ts'
import { observeRun as monitorObserveRun } from './monitor.ts'
import { registerProposeTool, type ProposeConfig } from './propose-tool.ts'
import { registerPolicySkills, switchPolicySkills, type PolicyRegistration } from './registry.ts'
import {
  appendPolicyTrace,
  ensureStore,
  loadSkills,
  readManifest,
  readPointer,
  setPromotionHeld,
  storePaths,
} from './store.ts'
import type { GateSample, ProposedSkill } from './types.ts'

/** Deployment-owned evolution settings, validated by the plugin Config. */
export interface EvolveSettings {
  /** Whether proposals, gates, and online monitoring run. */
  enabled: boolean
  /** Policy root. */
  policyDir: string
  /** Three-tier benchmark root; required when enabled. */
  benchmarkDir: string | undefined
  /** Command that starts the harness. */
  gateCommand: string
  /** Arguments prepended before the harness flags. */
  gateArgs: string[]
  /** Profile the gate runs under. */
  gateProfile: string
  /** Per-run timeout in milliseconds. */
  gateRunTimeoutMs: number
  /** Repeats per gate task. */
  repeats: number
  /** Holdout tasks drawn per gate. */
  holdoutSize: number
  /** Recent gates a holdout task stays ineligible for. */
  holdoutCooldown: number
  /** Promotions between sealed audits. */
  hardoutAuditEvery: number
  /** Minimum pass-rate gain. */
  minGain: number
  /** Allowed termination-rate regression. */
  maxSafetyRegression: number
  /** Allowed speculative-cheat regression. */
  maxCheatRegression: number
  /** Whole-gate token budget. */
  gateMaxTokens: number
  /** Whole-gate wall-clock budget in milliseconds. */
  gateMaxWallMs: number
  /** Per-run token ceiling. */
  runMaxTokens: number
  /** Who promotes a gated version. */
  promote: 'approval' | 'auto'
  /** Whether admission reads ground truth or the self-assessment. */
  admission: 'reward' | 'self-report'
  /** Additional admission evidence. */
  significance: 'off' | 'bootstrap'
  /** Two-sided error rate for the bootstrap interval. */
  significanceAlpha: number
  /** Whether a gate whose noise floor exceeds `minGain` refuses to admit. */
  requireDetectability?: boolean
  /** Allowed relative token-spend regression. */
  maxTokenRegression: number
  /** Proposals per task. */
  maxProposals: number
  /** Skills one proposal may carry. */
  maxSkills: number
  /** Per-skill body ceiling. */
  skillMaxBytes: number
  /** Clipped rationale length. */
  rationaleMax: number
  /** Static scan mode. */
  staticScan: 'rules' | 'rules+llm'
  /** Model for the model-assisted scan; distinct from the proposing agent's model. */
  scanModel: string | undefined
  /** Risky samples per brief section. */
  briefTopN: number
  /** Online window size. */
  rollbackWindow: number
  /** Online termination regression margin. */
  rollbackMargin: number
  /** Candidate version to mount; only set by generated gate overlays. */
  candidateVersion: string | undefined
  /** Deployment configuration restated in every gate overlay (patch replaces the whole config). */
  baseConfig: Readonly<Record<string, unknown>>
}

/** What the wiring needs from the plugin root. */
export interface EvolveOptions {
  /** Plugin context. */
  ctx: Context
  /** Validated settings. */
  settings: EvolveSettings
  /** Working directory for gate children. */
  cwd: string
  /** Lazily create the agent's flow recorder, for trace mirroring. */
  ensureFlow: (agent: Agent) => FlowRecorder
}

/** The runtime handle the plugin root keeps. */
export interface EvolveRuntime {
  /** The policy version new recorders freeze into `run.json`; null when evolution is off. */
  policyVersion: string | null
  /** Fold one finished run into the monitor and revert on regression. */
  observeRun: (agent: Agent, recorder: FlowRecorder) => Promise<void>
  /** Reset one agent's proposal budget at a new task boundary. */
  resetProposals: (agent: Agent) => void
}

/** A runtime that does nothing, used when evolution is off. */
const INERT: EvolveRuntime = {
  policyVersion: null,
  observeRun: async () => {},
  resetProposals: () => {},
}

/**
 * Load the active policy, register its skills, and optionally register the
 * proposal tool and monitor.
 * @param options - context, settings, model, cwd, and the recorder bridge.
 * @returns the runtime handle; inert when evolution is off and no candidate is mounted.
 * @throws when evolution is enabled without a benchmark, a skill service, or a coherent budget.
 */
export async function registerEvolve(options: EvolveOptions): Promise<EvolveRuntime> {
  const { ctx, settings } = options
  if (!settings.enabled && settings.candidateVersion === undefined) return INERT
  if (settings.enabled && settings.benchmarkDir === undefined) {
    throw new Error('lcrd-hard-isolation: `evolveBenchmarkDir` is required when `evolveEnabled` is true')
  }
  if (settings.runMaxTokens > settings.gateMaxTokens) {
    throw new Error('lcrd-hard-isolation: `evolveRunMaxTokens` must not exceed `evolveGateMaxTokens`')
  }
  const paths = storePaths(settings.policyDir)
  const pointer = await ensureStore(paths)
  const target = settings.candidateVersion ?? pointer.version
  const manifest = await readManifest(paths, target)
  if (manifest.status === 'quarantined') {
    throw new Error(`lcrd evolve: policy version ${target} is quarantined and cannot be mounted`)
  }
  let currentSkills = await loadSkills(paths, target)
  let registration: PolicyRegistration = registerPolicySkills(ctx, target, currentSkills)
  let current = target
  /** Notices waiting for the next tool decision of one agent. */
  const pendingNotices = new Map<Agent, UserMessage[]>()

  /**
   * Queue one policy transition notice: log it immediately and deliver it to
   * the model through the existing `additionalContexts` channel.
   * @param agent - the session that owns the transition.
   * @param action - promoted or rolled back.
   * @param from - the previously active version.
   * @param to - the now active version.
   * @param reason - the gate, approval, or regression reason.
   */
  const queueNotice = (
    agent: Agent,
    action: 'promoted' | 'rolled-back',
    from: string,
    to: string,
    reason: string,
  ): void => {
    const text = policyNoticeText(action, from, to, reason)
    try { options.ensureFlow(agent).log(text) } catch { /* logging must not break a tool */ }
    const queued = pendingNotices.get(agent) ?? []
    queued.push(policyNotice(action, from, to, reason))
    pendingNotices.set(agent, queued)
  }

  const record = (agent: Agent, action: 'proposed' | 'gated' | 'promoted' | 'rolled-back' | 'audit', version: string, detail: string): void => {
    // The store owns the authoritative transition records for promote/rollback.
    if (action !== 'promoted' && action !== 'rolled-back') {
      /* v8 ignore next -- best-effort trace: a failed append must not break a tool */
      void appendPolicyTrace(paths, { action, version, detail }).catch(() => {})
    }
    try { options.ensureFlow(agent).log(`[LCRD] policy ${action}: ${version} ${detail}`) } catch { /* logging must not break a tool */ }
  }

  const activate = async (version: string, skills: readonly ProposedSkill[]): Promise<void> => {
    registration = switchPolicySkills(ctx, registration, version, skills, currentSkills)
    current = version
    currentSkills = [...skills]
    await maybeAudit(version)
  }

  const launch = createGateLauncher({
    command: settings.gateCommand,
    args: settings.gateArgs,
    profile: settings.gateProfile,
    timeoutMs: settings.gateRunTimeoutMs,
  })

  const gateBudget = {
    repeats: settings.repeats,
    runMaxTokens: settings.runMaxTokens,
    maxTokens: settings.gateMaxTokens,
    maxWallMs: settings.gateMaxWallMs,
    admission: settings.admission,
    minGain: settings.minGain,
    maxTokenRegression: settings.maxTokenRegression,
    significance: settings.significance,
    significanceAlpha: settings.significanceAlpha,
    requireDetectability: settings.requireDetectability ?? true,
    rewardTimeoutMs: settings.gateRunTimeoutMs,
    policyDir: paths.root,
    baseConfig: settings.baseConfig,
    /* v8 ignore next -- enabled registrations always carry benchmarkDir */
    benchmarkDir: settings.benchmarkDir ?? '',
  }

  /** Run a sealed audit when the promotion count reaches the configured cadence. */
  async function maybeAudit(version: string): Promise<void> {
    /* v8 ignore next -- enabled registrations always carry benchmarkDir */
    if (settings.benchmarkDir === undefined) return
    try {
      const now = await readPointer(paths)
      const promotions = now.history.filter(entry => entry.gateId !== null).length
      if (settings.hardoutAuditEvery <= 0 || promotions % settings.hardoutAuditEvery !== 0) return
      const benchmark = await loadBenchmark(settings.benchmarkDir)
      const manifest = await readManifest(paths, version)
      /* v8 ignore next -- activation only promotes proposals, which name a parent */
      if (manifest.parent === null) return
      const audit = await auditHardout({
        paths,
        config: gateBudget,
        version,
        baselineVersion: manifest.parent,
        benchmark,
        launch,
      })
      await appendPolicyTrace(paths, {
        action: 'audit',
        version,
        detail: audit.pass ? audit.reasons.join('; ') : `${audit.reasons.join('; ')} (promotions held)`,
      })
      if (!audit.pass) await setPromotionHeld(paths, true)
    } catch { /* an audit failure must not break a promotion that already committed */ }
  }

  const proposals = new WeakMap<Agent, number>()

  if (settings.enabled && settings.benchmarkDir !== undefined) {
    const proposeConfig: ProposeConfig = {
      maxProposals: settings.maxProposals,
      maxSkills: settings.maxSkills,
      skillMaxBytes: settings.skillMaxBytes,
      rationaleMax: settings.rationaleMax,
      staticScan: settings.staticScan,
      promote: settings.promote,
      gate: {
        repeats: settings.repeats,
        holdoutSize: settings.holdoutSize,
        holdoutCooldown: settings.holdoutCooldown,
        minGain: settings.minGain,
        maxSafetyRegression: settings.maxSafetyRegression,
        maxCheatRegression: settings.maxCheatRegression,
        maxTokens: settings.gateMaxTokens,
        maxWallMs: settings.gateMaxWallMs,
        runMaxTokens: settings.runMaxTokens,
        admission: settings.admission,
        maxTokenRegression: settings.maxTokenRegression,
        requireDetectability: settings.requireDetectability ?? true,
        rewardTimeoutMs: settings.gateRunTimeoutMs,
        policyDir: paths.root,
        baseConfig: settings.baseConfig,
        benchmarkDir: settings.benchmarkDir,
      },
      benchmarkDir: settings.benchmarkDir,
      briefTopN: settings.briefTopN,
    }
    registerProposeTool(ctx, {
      ctx,
      paths,
      config: proposeConfig,
      proposals,
      hooks: { activate, record, notice: queueNotice },
      launch,
      scanModel: settings.scanModel,
    })
    // Fold a queued policy notice onto the next tool decision of that agent.
    // Both accept and block variants carry `additionalContexts`, so the notice
    // survives a rejected tool call and never needs a new session event.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const downstream = await next()
      const agent = exec.agent
      if (agent === undefined) return downstream
      const queued = pendingNotices.get(agent)
      if (queued === undefined || queued.length === 0) return downstream
      pendingNotices.delete(agent)
      return { ...downstream, additionalContexts: [...queued, ...(downstream.additionalContexts ?? [])] }
    })
    // Verify the benchmark at load so a broken corpus fails before a session
    // spends tokens on a proposal it cannot gate.
    await loadBenchmark(settings.benchmarkDir)
  }

  return {
    /** The live active version, so a recorder created after a transition freezes the new one. */
    get policyVersion(): string | null { return current },
    resetProposals: (agent: Agent): void => { proposals.delete(agent) },
    observeRun: async (agent: Agent, recorder: FlowRecorder): Promise<void> => {
      if (!settings.enabled) return
      const meta = recorder.computeRunMeta()
      const sample: GateSample = {
        taskId: meta.task_id,
        repeat: 1,
        version: current,
        recorded: true,
        reward: meta.tb_final_reward,
        termination: meta.termination,
        finalVerdict: meta.final_verdict,
        relaxTypes: meta.relax_types,
        planCount: meta.plan_count,
        tokens: meta.tokens,
        hookInterceptions: meta.hook_interceptions,
        pathViolations: meta.path_violations,
      }
      const outcome = await monitorObserveRun(paths, current, sample, {
        window: settings.rollbackWindow,
        rollbackMargin: settings.rollbackMargin,
        maxCheatRegression: settings.maxCheatRegression,
      }).catch(() => null)
      if (outcome === null || !outcome.rolledBack || outcome.to === undefined || outcome.from === undefined) return
      try {
        const restored = await loadSkills(paths, outcome.to)
        registration = switchPolicySkills(ctx, registration, outcome.to, restored, currentSkills)
        current = outcome.to
        currentSkills = restored
        /* v8 ignore next -- a rolled-back outcome always carries a reason */
        const reason = outcome.reason ?? ''
        queueNotice(agent, 'rolled-back', outcome.from, outcome.to, reason)
        record(agent, 'rolled-back', outcome.from, reason)
      } catch { /* the store already reverted; a registration failure must not undo it */ }
    },
  }
}
