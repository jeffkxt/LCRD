/**
 * LCRD hard-isolation minimal sample: the three-symbol protocol (root anchor,
 * stop symbol, rollback symbol) implemented over the harness extension points.
 * The root anchor is pinned in the system prompt, the model declares each
 * subtask plan through the `lcrd_plan` tool, and every tool result is verified
 * after execution by an exogenous verifier the model chose; failures roll back
 * with corrective feedback and terminate after a configured retry budget.
 *
 * @module lcrd-wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// Type-only: make `ctx.get('sandboxPolicy')` resolve to the policy service when
// composed — the workspace-root fallback consumes it opportunistically (the
// documented `ctx.get` pattern), never as a hard dependency.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** LCRD protocol context; readers preserve the content without this producer.
     * @persistenceAttribution
     */
    'lcrd-hard-isolation': { kind: 'lcrd-hard-isolation' } & ContextFormed
  }
}

import { registerAnchorSection } from './anchor.ts'
import { registerFileFlowSection, FILE_FLOW_DIR } from './file-flow.ts'
import { ensureTaskDir, registerFileFlowGuard } from './file-flow-guard.ts'
import { defaultLogDir } from './flow.ts'
import { defaultAttribution, withHoldRateReview } from './dataset.ts'
import { loadAttribution, type Attribution } from './attribution.ts'
import { loadHooks, type LcrdHooks } from './hooks.ts'
import type { DeclarationPolicy } from './declaration.ts'
import { createState } from './state.ts'
import { createRecorderBridge } from './recorder-bridge.ts'
import { registerPlanTool } from './plan-tool.ts'
import { registerLearnTools } from './learn-tools.ts'
import { registerStepVerify } from './step-verify.ts'
import { registerLifecycle } from './lifecycle.ts'
import { registerEvolve, type EvolveRuntime } from './evolve/index.ts'
import { dirname, join } from 'node:path'

/** The per-task flow recorder, its default log directory, and its folder-suffix helper (flow-export API). */
export { FlowRecorder, defaultLogDir, pluginVersion, planFingerprint, shortAgentId } from './flow.ts'
/** The policy-transition notice text and message, for operator tooling and deployment tests. */
export { policyNotice, policyNoticeText } from './notice.ts'
/** The recorded-event vocabulary: envelope, schema version, stream and run-meta file names. */
export { FLOW_SCHEMA_VERSION, FLOW_STREAM_FILE, RUN_META_FILE } from './flow.ts'
export type { FlowEvent, FlowEventEnvelope, PlanContext, RecordedFlowEvent, RunMeta } from './flow.ts'
/** The version of the injected protocol text and corrective notices. */
export { PROTOCOL_VERSION } from './anchor.ts'
/** The exogenous verifier API: payload rendering, the code verifier, the plan-time probes, and the shared condition rejection. */
export { conditionRejection, probeExpression, probeHoldRate, resultPayload, verifyAssert } from './verifiers.ts'
export type { ConditionProbe, VerifyPayload } from './verifiers.ts'
/** The record-resolution instrumentation API: assertion strictness, relaxation axes, and tool summaries. */
export { clipSummary, describeStrictness, relaxationAxes, specExpressions, summarizeArguments, summarizeResult } from './instrumentation.ts'
export type { AssertionStrictness, RelaxationAxis, ResultSummary } from './instrumentation.ts'
/** The dataset API: the failure taxonomy, per-run row construction, the append path, and the hold-rate review wrapper. */
export {
  DATASET_FILES,
  appendDatasetRows,
  classifyFailure,
  classifyRelaxationCause,
  classifyTrainability,
  datasetRowsForRun,
  dpoPairsForRun,
  ensureDatasetFiles,
  expressionsOf,
  renderTranscriptEntry,
  withExpressions,
  withHoldRateReview,
} from './dataset.ts'
export type {
  DatasetRow,
  DpoPair,
  FailureClass,
  RelaxationCause,
  RelaxationRow,
  RunRow,
  RunRows,
  Trainability,
  TranscriptEntry,
} from './dataset.ts'
/** The attribution hook: the replaceable failure/relaxation/trainability classifier bundle and its loader. */
export { defaultAttribution } from './dataset.ts'
export { isAttribution, loadAttribution } from './attribution.ts'
export type { Attribution } from './attribution.ts'
/** The policy-hook seam: the deployment module inspecting LCRD's own plan and verified results. */
export { isLcrdHooks, loadHooks } from './hooks.ts'
export type {
  LcrdHooks,
  PlanCheckDecision,
  PlanCheckInput,
  ResultCheckDecision,
  ResultCheckInput,
} from './hooks.ts'
/** The step-plan and learning vocabulary the protocol tools accept and the flow artifacts record. */
export type { LearnDeclaration, LearnVerdict, StepPlan, Verdict, VerdictExceptionKind, VerifierSpec } from './types.ts'
export { verifierMode } from './types.ts'
/** The file-flow path classifier: hard isolation applies only to task-context paths under `task-flow/`. */
export { classifyFlowPath, fileFlowSectionText } from './file-flow.ts'
export type { FlowPathClass } from './file-flow.ts'
/** The policy store operators need for offline promotion, rollback, and inspection. */
export {
  appendRejectedEdit,
  ensureStore,
  listVersions,
  loadSkills,
  promote,
  readHoldoutHistory,
  readManifest,
  readPointer,
  readQuarantine,
  readRejectedEdits,
  rejectedEditsPath,
  rollback,
  setGateOutcome,
  setPromotionHeld,
  stageVersion,
  storePaths,
  versionPath,
  writeGateArtifact,
} from './evolve/store.ts'
/** Gate and sealed-audit entry points, for offline tooling and deployment tests. */
export { admittedMetrics, aggregate, decide, renderOverlay, runGate, runTasks } from './evolve/gate.ts'
/** The gain report: paired samples, a seeded bootstrap interval, and an explicit verdict. */
export { bootstrapMeanCI, pairSamples, pairedDeltas, pairedRuns, renderGainReport } from './evolve/report.ts'
export type { GainReport, GainReportJson, GainVerdict, PairedRun } from './evolve/report.ts'
/** The noise floor: descriptive statistics and the normal-approximation minimum detectable gain. */
export {
  mean,
  minDetectableGain,
  normalQuantile,
  percentile,
  renderNoiseReport,
  requiredPairs,
  sampleSd,
  summarizeNoise,
} from './evolve/significance.ts'
export type { NoiseSummary } from './evolve/significance.ts'
export { auditHardout } from './evolve/hardout.ts'
export { loadBenchmark, selectHoldout } from './evolve/holdout.ts'
export { createGateLauncher } from './evolve/launch.ts'
export type { LauncherConfig } from './evolve/launch.ts'
export { evaluateWindow, observeRun, readPolicyScore } from './evolve/monitor.ts'
export type {
  BenchmarkSpec,
  BenchmarkTask,
  GateMetrics,
  GateReport,
  GateSample,
  PolicyManifest,
  PolicyPointer,
  QuarantineEntry,
  RejectedEdit,
  RejectedEditStage,
  RelaxType,
} from './evolve/types.ts'
export type { GateConfig, GateLaunchRequest, SignificanceEvidence } from './evolve/gate.ts'
export type { GateLauncher } from './evolve/gate.ts'

export const name = 'lcrd-hard-isolation'
export const inject = ['systemPrompt', 'tools', 'llm', 'fs']

/** Plugin config, validated by the same-named schemastery schema. */

import { Config } from './config.ts'


/**
 * Install the protocol. `plans` holds each agent's latest declared step plan,
 * `failures` counts its consecutive verifier failures, and `terminated` marks
 * agents whose retry budget is exhausted (further tool results are blocked
 * with a short notice instead of re-verifying).
 * @param ctx - plugin context; all registrations are disposed with it.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const maxRetries = config.maxRetries as number
  const pythonCommand = config.pythonCommand as string
  const pythonTimeoutMs = config.pythonTimeoutMs as number
  const verifierModel = config.verifierModel
  const logDir = config.logDir
  const interaction = config.interaction as 'auto' | 'auth' | 'manual'
  const learningEnabled = config.learningEnabled as boolean
  const learningThreshold = config.learningThreshold as number
  const maxLearningAttempts = config.maxLearningAttempts as number
  const learningToolSet = new Set(config.learningTools as string[])
  const fileFlowEnabled = config.fileFlowEnabled as boolean
  const fileFlowPathViolationsMax = config.fileFlowPathViolationsMax as number
  const workspaceRoot = config.workspaceRoot
  const fileFlowToolSet = new Set(config.fileFlowTools as string[])
  const failedCheckConsumesRetry = config.failedCheckConsumesRetry as boolean
  const datasetExport = config.datasetExport as 'off' | 'run'
  const datasetDir = config.datasetDir ?? join(dirname(logDir ?? defaultLogDir()), 'dataset')
  /** The task-flow root: a sibling of the flow-log directory, so task context persists beside the logs. */
  const taskFlowRoot = join(dirname(config.logDir ?? defaultLogDir()), FILE_FLOW_DIR)
  /** Versioned policy store root and the mounted candidate (gate children only). */
  const evolvePolicyDir = config.evolvePolicyDir ?? join(dirname(config.logDir ?? defaultLogDir()), 'policy')
  const evolveRuntimeRef: { current: EvolveRuntime | undefined } = { current: undefined }
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error('lcrd-hard-isolation: `maxRetries` must be an integer >= 1')
  }
  if (!Number.isInteger(pythonTimeoutMs) || pythonTimeoutMs < 1000) {
    throw new Error('lcrd-hard-isolation: `pythonTimeoutMs` must be an integer >= 1000')
  }
  if (!Number.isInteger(learningThreshold) || learningThreshold < 1) {
    throw new Error('lcrd-hard-isolation: `learningThreshold` must be an integer >= 1')
  }
  if (!Number.isInteger(maxLearningAttempts) || maxLearningAttempts < 1) {
    throw new Error('lcrd-hard-isolation: `maxLearningAttempts` must be an integer >= 1')
  }
  if (!Number.isInteger(fileFlowPathViolationsMax) || fileFlowPathViolationsMax < 1) {
    throw new Error('lcrd-hard-isolation: `fileFlowPathViolationsMax` must be an integer >= 1')
  }
  if (config.declarationMaxHoldRate !== undefined && !(config.declarationMaxHoldRate > 0 && config.declarationMaxHoldRate <= 1)) {
    throw new Error('lcrd-hard-isolation: `declarationMaxHoldRate` must be in (0, 1]')
  }
  for (const [name, value, minimum] of [
    ['evolveGateRunTimeoutMs', config.evolveGateRunTimeoutMs as number, 1000],
    ['evolveRepeats', config.evolveRepeats as number, 1],
    ['evolveHoldoutSize', config.evolveHoldoutSize as number, 1],
    ['evolveHoldoutCooldown', config.evolveHoldoutCooldown as number, 0],
    ['evolveHardoutAuditEvery', config.evolveHardoutAuditEvery as number, 0],
    ['evolveGateMaxTokens', config.evolveGateMaxTokens as number, 1],
    ['evolveGateMaxWallMs', config.evolveGateMaxWallMs as number, 1_000],
    ['evolveRunMaxTokens', config.evolveRunMaxTokens as number, 1],
    ['evolveMaxProposals', config.evolveMaxProposals as number, 0],
    ['evolveMaxSkills', config.evolveMaxSkills as number, 1],
    ['evolveSkillMaxBytes', config.evolveSkillMaxBytes as number, 1],
    ['evolveRationaleMax', config.evolveRationaleMax as number, 1],
    ['evolveBriefTopN', config.evolveBriefTopN as number, 1],
    ['evolveRollbackWindow', config.evolveRollbackWindow as number, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`lcrd-hard-isolation: \`${name}\` must be an integer >= ${minimum}`)
    }
  }
  for (const [name, value] of [
    ['evolveMinGain', config.evolveMinGain as number],
    ['evolveMaxSafetyRegression', config.evolveMaxSafetyRegression as number],
    ['evolveMaxCheatRegression', config.evolveMaxCheatRegression as number],
    ['evolveMaxTokenRegression', config.evolveMaxTokenRegression as number],
    ['evolveRollbackMargin', config.evolveRollbackMargin as number],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`lcrd-hard-isolation: \`${name}\` must be a non-negative number`)
    }
  }
  const evolveEnabled = config.evolveEnabled as boolean
  const evolveCandidateVersion = config.evolveCandidateVersion
  if (evolveEnabled && config.evolveBenchmarkDir === undefined) {
    throw new Error('lcrd-hard-isolation: `evolveBenchmarkDir` is required when `evolveEnabled` is true')
  }
  if ((config.evolveRunMaxTokens as number) > (config.evolveGateMaxTokens as number)) {
    throw new Error('lcrd-hard-isolation: `evolveRunMaxTokens` must not exceed `evolveGateMaxTokens`')
  }
  const evolveScanModel = config.evolveScanModel ?? config.verifierModel
  if (config.evolveStaticScan === 'rules+llm' && evolveScanModel === undefined) {
    throw new Error('lcrd-hard-isolation: `evolveStaticScan: rules+llm` requires `evolveScanModel` (or `verifierModel`)')
  }
  /** The declaration-time gates: presence-only rejection and the optional hold-rate ceiling. */
  const declarationPolicy: DeclarationPolicy = {
    rejectPresenceOnly: config.rejectPresenceOnly as boolean,
    maxHoldRate: config.declarationMaxHoldRate,
  }
  /**
   * The attribution bundle: a configured module owns its labels wholesale and
   * is never wrapped; the log-heuristic default gains the hold-rate review
   * only when a ceiling is configured (no-op when it is not).
   */
  const attribution: Attribution = config.attributionModule !== undefined
    ? await loadAttribution(config.attributionModule)
    : withHoldRateReview(defaultAttribution, config.declarationMaxHoldRate)
  /** The policy hook: a configured module, or none (plain protocol). */
  const hooks: LcrdHooks | undefined = config.hooksModule === undefined
    ? undefined
    : await loadHooks(config.hooksModule)

  const state = createState()
  const {
    plans,
    failures,
    failedPlanKeys,
    hookInterceptions,
    terminalExecutions,
    lastVerdict,
    exportedRecorders,
    transcripts,
    pendingTokens,
    invalidChecks,
    terminated,
    learning,
    pathViolations,
    taskDirs,
    guardDenied,
    flows,
    sessionRecorders,
    recorderSessions,
    allRecorders,
  } = state

  /** The approval policy the interaction mode maps to (`'never'` auto-rejects; `'ask'` delegates). */
  const approvalPolicy: ApprovalPolicy = interaction === 'auto' ? 'never' : 'ask'

  const { ensureFlow, flush, recordTool, recordHookInterception, noteVerdict, planContext } = createRecorderBridge(
    state,
    {
      logDir,
      interaction,
      learningEnabled,
      learningThreshold,
      maxLearningAttempts,
      maxRetries,
      config,
      attribution,
      approvalPolicy,
      policyVersion: () => evolveRuntimeRef.current?.policyVersion ?? null,
    },
  )

  /** Bound task-dir creator: `ensureTaskDir` for this plugin instance's fs seam and state. */
  const ensureTaskDirForAgent = (agent: Agent): Promise<string> =>
    ensureTaskDir(ctx, taskDirs, taskFlowRoot, agent)

  registerLifecycle(ctx, {
    state: {
      transcripts, pendingTokens, sessionRecorders, recorderSessions, flows, exportedRecorders, allRecorders,
      plans, failures, failedPlanKeys, learning, lastVerdict,
      invalidChecks, hookInterceptions, pathViolations, taskDirs, terminated,
    },
    bridge: { ensureFlow },
    datasetExport,
    datasetDir,
    onRunFinished: (agent, recorder) => { void evolveRuntimeRef.current?.observeRun(agent, recorder) },
  })

  registerAnchorSection(ctx)

  // Policy evolution: load the active (or candidate) version's skills before
  // any agent runs, and expose the proposal tool and online monitor only when
  // the deployment enabled it. A gate child mounts one candidate with
  // evolution off, so a measurement run can never propose.
  evolveRuntimeRef.current = await registerEvolve({
    ctx,
    settings: {
      enabled: evolveEnabled,
      policyDir: evolvePolicyDir,
      benchmarkDir: config.evolveBenchmarkDir,
      gateCommand: config.evolveGateCommand as string,
      gateArgs: config.evolveGateArgs as string[],
      gateProfile: config.evolveGateProfile as string,
      gateRunTimeoutMs: config.evolveGateRunTimeoutMs as number,
      repeats: config.evolveRepeats as number,
      holdoutSize: config.evolveHoldoutSize as number,
      holdoutCooldown: config.evolveHoldoutCooldown as number,
      hardoutAuditEvery: config.evolveHardoutAuditEvery as number,
      minGain: config.evolveMinGain as number,
      maxSafetyRegression: config.evolveMaxSafetyRegression as number,
      maxCheatRegression: config.evolveMaxCheatRegression as number,
      gateMaxTokens: config.evolveGateMaxTokens as number,
      gateMaxWallMs: config.evolveGateMaxWallMs as number,
      runMaxTokens: config.evolveRunMaxTokens as number,
      promote: config.evolvePromote as 'approval' | 'auto',
      admission: config.evolveAdmission as 'reward' | 'self-report',
      significance: config.evolveSignificance as 'off' | 'bootstrap',
      significanceAlpha: config.evolveSignificanceAlpha as number,
      requireDetectability: config.evolveRequireDetectability as boolean,
      maxTokenRegression: config.evolveMaxTokenRegression as number,
      maxProposals: config.evolveMaxProposals as number,
      maxSkills: config.evolveMaxSkills as number,
      skillMaxBytes: config.evolveSkillMaxBytes as number,
      rationaleMax: config.evolveRationaleMax as number,
      staticScan: config.evolveStaticScan as 'rules' | 'rules+llm',
      scanModel: evolveScanModel,
      briefTopN: config.evolveBriefTopN as number,
      rollbackWindow: config.evolveRollbackWindow as number,
      rollbackMargin: config.evolveRollbackMargin as number,
      candidateVersion: evolveCandidateVersion,
      baseConfig: Object.assign({}, config) as Readonly<Record<string, unknown>>,
    },
    cwd: workspaceRoot ?? process.cwd(),
    ensureFlow,
  })
  if (evolveEnabled) {
    // A new user command is a fresh task boundary for the proposal budget too.
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (messages.some(message => message.source.kind === 'user')) evolveRuntimeRef.current?.resetProposals(agent)
      return next()
    })
  }

  // File-backed task flow is opt-in for minimal deployments: the model keeps
  // the task breakdown and progress on disk through bash/str_replace_editor.
  // Standard deployments leave it off and keep the plain in-context flow.
  let fsWorkRoot = ''
  /**
   * The workspace root for one agent: explicit config, the session's
   * validated cwd, the deployment's sandbox workspace root (the authoritative
   * workspace-write boundary), DSH_CWD, then the fs root.
   */
  const resolveWorkRoot = (agent?: Agent): string => {
    const sandboxRoot = ctx.get('sandboxPolicy')?.workspaceRoot
    return workspaceRoot ?? agent?.session.header.cwd ?? sandboxRoot ?? process.env.DSH_CWD ?? fsWorkRoot
  }
  if (fileFlowEnabled) {
    // Resolve the fs backend's own working root once as the final fallback;
    // the harness's validated session cwd takes precedence via the
    // per-agent provider, so the model places task products in the chosen
    // workspace instead of a guessed alias such as /repo. Capture the
    // service before the async gap so a fiber disposed while resolve is
    // still pending does not re-enter an inactive context in the callback.
    const fs = ctx.fs
    void fs.resolve('.').then(
      (target) => { fsWorkRoot = fs.processPath(target) },
      /* v8 ignore next 2 -- the fs root is unresolvable only when the backend fails */
      () => { /* unresolvable fs root: the section omits the workspace line */ },
    )
    registerFileFlowSection(ctx, taskFlowRoot, resolveWorkRoot)
    registerFileFlowGuard(ctx, {
      state: { taskDirs, guardDenied, pathViolations, terminated },
      bridge: { ensureFlow, flush, recordTool },
      taskFlowRoot,
      fileFlowToolSet,
      fileFlowPathViolationsMax,
      resolveWorkRoot,
    })
  }

  registerPlanTool(ctx, {
    state: { plans, failures, failedPlanKeys, terminated, terminalExecutions, taskDirs },
    bridge: { ensureFlow, flush, recordHookInterception, planContext },
    declarationPolicy,
    hooks,
    maxRetries,
    fileFlowEnabled,
    ensureTaskDir: ensureTaskDirForAgent,
  })

  // The learning symbol: after consecutive verifier failures reach the
  // configured threshold, direct retries pause and the model must declare
  // learning rounds through lcrd_learn / lcrd_learn_verify. The declaration
  // and the self-evaluation are model-authored data; the re-solve still runs
  // the exogenous verifier, which is the only check that can complete the
  // task and reset the learning budget.
  if (learningEnabled) {
    registerLearnTools(ctx, {
      state: { learning, terminated },
      bridge: { ensureFlow, flush },
      maxLearningAttempts,
      learningToolSet,
    })
  }

  registerStepVerify(ctx, {
    state: { guardDenied, terminalExecutions, terminated, learning, plans, failures, failedPlanKeys, invalidChecks },
    bridge: { ensureFlow, flush, recordTool, recordHookInterception, noteVerdict },
    ctx,
    interaction,
    learningEnabled,
    learningThreshold,
    maxLearningAttempts,
    maxRetries,
    pythonCommand,
    pythonTimeoutMs,
    verifierModel,
    failedCheckConsumesRetry,
    learningToolSet,
    hooks,
    runMaxTokens: evolveCandidateVersion === undefined ? undefined : config.evolveRunMaxTokens,
  })
}
