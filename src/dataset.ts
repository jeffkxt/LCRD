/**
 * Dataset rows for one finished run, built in-process from the recorder's own
 * events: the conversion, the failure taxonomy, and the DPO pair construction
 * shared by the in-process export and the corpus-level scripts.
 *
 * @module lcrd-dataset
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssertionStrictness, RelaxationAxis } from './instrumentation.ts'
import type { RecordedFlowEvent, RunMeta, PlanContext } from './flow.ts'
import type { FlowMeta } from './flow.ts'
import type { Attribution } from './attribution.ts'
import type { RelaxType } from './types.ts'

/** The failure classes a verdict reason is attributed to, for dataset grouping. */
export type FailureClass =
  /** The model's own check was rejected as invalid. */
  | 'assertion-invalid'
  /** The tool itself failed, so no check could be satisfied. */
  | 'tool-isError'
  /** The check was evaluated and did not hold. */
  | 'honest-mismatch'
  /** The python verifier script exceeded its timeout. */
  | 'python-timeout'
  /** The python verifier script exited non-zero. */
  | 'exit-code'
  /** A python check expression was evaluated against the result and did not hold. */
  | 'python-check-failed'
  /** The llm verifier judged the stop condition unmet (or the pinned FAIL fallback). */
  | 'llm-stop-unmet'
  /** The llm verifier did not return a usable JSON verdict. */
  | 'llm-bad-output'
  /** The failure came from the environment or configuration, not from the model's work. */
  | 'infra-error'
  /** A reason matching no known class; kept distinct rather than guessed at. */
  | 'unclassified'

/** Reason fragments an llm verifier records when it judges the stop condition unmet. */
const LLM_STOP_UNMET = /停止条件|未满足|未得到满足|stop condition|work incomplete|not met|LLM 校验器判定 FAIL/u

/**
 * Attribute one failed verdict to a failure class from its recorded reason,
 * the verifier's structured exception kind, and (when present) the verifier
 * that produced the verdict.
 * @param reason - the verifier's recorded failure reason.
 * @param exceptionKind - the verifier's exception kind, when it threw.
 * @param verifierKind - the verifier that recorded the verdict (`assert` | `python` | `llm`), when known.
 * @returns the failure class, or `unclassified` when no rule matches.
 */
export function classifyFailure(reason: string, exceptionKind?: string, verifierKind?: string): FailureClass {
  if (exceptionKind === 'unspawnable' || exceptionKind === 'no-provider') return 'infra-error'
  if (exceptionKind === 'timeout') return 'python-timeout'
  if (exceptionKind === 'exit-code') return 'exit-code'
  if (exceptionKind === 'bad-output') return 'llm-bad-output'
  if (exceptionKind === 'invalid-condition' || exceptionKind === 'eval-error') return 'assertion-invalid'
  if (/缺少区分度|求值失败|必须引用/u.test(reason)) return 'assertion-invalid'
  if (/不支持|unsupported|EPERM|EACCES|ENOENT|not permitted/u.test(reason)) return 'infra-error'
  if (/工具执行失败/u.test(reason)) return 'tool-isError'
  if (/超时/u.test(reason)) return 'python-timeout'
  if (/未返回 JSON|JSON 解析失败/u.test(reason)) return 'llm-bad-output'
  if (/不成立/u.test(reason) || /\(result 类型: /u.test(reason)) return 'honest-mismatch'
  if (verifierKind === 'llm' || LLM_STOP_UNMET.test(reason)) return 'llm-stop-unmet'
  if (verifierKind === 'python') return 'python-check-failed'
  return 'unclassified'
}

/** How one relaxation came about, judged from the recorded facts. */
export type RelaxationCause =
  /** The check threw against the real value, so its form had to change. */
  | 'type-adaptation'
  /** The work was judged incomplete, and the next check dropped strength instead of changing method. */
  | 'substance-dropped'
  /** Neither pattern applies: the reader decides from the two expression lists. */
  | 'undetermined'

/** The axes that mean the declaration gave up part of its check. */
const STRENGTH_AXES: RelaxationAxis[] = ['fewer-expressions', 'presence-only', 'lost-structural', 'dropped-literals', 'weaker-constraint']

/** Failure classes whose preceding mismatch means the next check dropped strength. */
const SUBSTANCE_DROPPED_CLASSES: readonly FailureClass[] = ['honest-mismatch', 'llm-stop-unmet', 'python-check-failed']

/**
 * Attribute one relaxation to a cause from the recorded facts.
 * @param failureClass - the class of the failure the declaration followed.
 * @param failureExceptionKind - the verifier's exception kind on that failure.
 * @param axes - the axes the declaration relaxed along.
 * @returns the attributed cause.
 */
export function classifyRelaxationCause(
  failureClass: FailureClass | null,
  failureExceptionKind: string | null,
  axes: RelaxationAxis[],
): RelaxationCause {
  if (failureExceptionKind === 'eval-error') return 'type-adaptation'
  if (failureClass !== null && SUBSTANCE_DROPPED_CLASSES.includes(failureClass) && axes.some(axis => STRENGTH_AXES.includes(axis))) {
    return 'substance-dropped'
  }
  return 'undetermined'
}

/** Exception kinds that mean the engine or environment rejected the check itself. */
const ENVIRONMENT_EXCEPTIONS: readonly string[] = [
  'invalid-condition', 'eval-error', 'unspawnable', 'no-provider', 'timeout', 'exit-code', 'bad-output',
]

/** The recorded facts one relaxation-type judgment reads. */
export interface RelaxTypeInput {
  /** Class of the failure the declaration followed; null when none preceded it. */
  failureClass: FailureClass | null
  /** The verifier's exception kind on that failure, when it threw. */
  failureExceptionKind: string | null
  /** The axes along which the declaration relaxed. */
  axes: readonly RelaxationAxis[]
  /** The new declaration's strictness reading. */
  strictness: AssertionStrictness | undefined
  /** The previous declaration's strictness reading. */
  previousStrictness: AssertionStrictness | undefined
}

/**
 * Classify one relaxation as a legitimate specification adjustment, an expected
 * rewrite after an environmental rejection, or a speculative strength drop.
 * The first two are informational; only the third is penalized by the gate and
 * the online monitor. The judgment reads recorded fields only, so an old corpus
 * can be re-labelled without replaying the run.
 * @param input - the preceding failure, the relaxed axes, and both strictness readings.
 * @returns the relaxation type.
 */
export function classifyRelaxType(input: RelaxTypeInput): RelaxType {
  if (input.failureExceptionKind !== null && ENVIRONMENT_EXCEPTIONS.includes(input.failureExceptionKind)) {
    return 'environment_fault'
  }
  if (input.failureClass === 'infra-error' || input.failureClass === 'assertion-invalid') {
    return 'environment_fault'
  }
  const droppedStrength = input.axes.some(axis => STRENGTH_AXES.includes(axis))
  if (!droppedStrength) return 'spec_adjust'
  const previousRate = input.previousStrictness?.maxHoldRate
  const rate = input.strictness?.maxHoldRate
  const rateRose = previousRate !== null && previousRate !== undefined && rate !== null && rate !== undefined && rate > previousRate
  if (rateRose || input.strictness?.presenceOnly === true) return 'speculative_cheat'
  if (input.strictness?.discrimination === 'tautological' || input.strictness?.discrimination === 'unbound') {
    return 'speculative_cheat'
  }
  // A strength drop with no failure at all, or right after an honest mismatch,
  // is the speculative pattern the protocol forbids.
  if (input.failureClass === null) return 'speculative_cheat'
  if (SUBSTANCE_DROPPED_CLASSES.includes(input.failureClass)) return 'speculative_cheat'
  return 'spec_adjust'
}

/**
 * Whether one dataset row is usable for training without downstream filtering.
 * `trainable` rows carry a label the engine decided deterministically; `needs-review`
 * rows depend on a human or LLM judge because the label is ambiguous; `discard` rows
 * are environment or tooling noise that says nothing about the model's behavior.
 */
export type Trainability = 'trainable' | 'needs-review' | 'discard'
/** One dataset row: the recorded event plus its run identity and derived labels. */
// jscpd:ignore-start -- field list mirrors scripts/lcrd-dataset.ts DatasetRecord by design
export interface DatasetRow {
  run_id: string
  session_id: string
  task_id: string
  task_group: string
  step: number
  ts: string | null
  type: string
  goal: string | undefined
  stop: string | undefined
  feasibility: boolean | undefined
  verifier: string | undefined
  strictness: AssertionStrictness | undefined
  relaxation: RelaxationAxis[] | undefined
  /** Why the declaration relaxed, when it did: only `speculative_cheat` is penalized. */
  relaxType: RelaxType | undefined
  context: PlanContext | undefined
  tool: string | undefined
  callId: string | undefined
  argsSummary: string | undefined
  resultKind: string | undefined
  resultSummary: string | undefined
  errorCode: string | undefined
  pass: boolean | undefined
  reason: string | undefined
  count: number | undefined
  verifierKind: string | undefined
  failureClass: FailureClass | undefined
  infraFailure: boolean | undefined
  exceptionKind: string | undefined
  repeatPlan: boolean | undefined
  /** True when a probe prediction missed; the result was accepted and no retry was consumed. */
  predictionMissed: boolean | undefined
  analysis: string | undefined
  knowledge: string | undefined
  method: string | undefined
  criteria: string | undefined
  learned: boolean | undefined
  evidence: string | undefined
  intercept: string | undefined
  detail: string | undefined
  /** Whether this row trains directly or awaits human/LLM review, assigned by {@link classifyTrainability}. */
  trainability: Trainability | undefined
}
// jscpd:ignore-end

/** One declaration that loosened its own check after a failed verdict. */
// jscpd:ignore-start -- field list mirrors scripts/lcrd-dataset.ts RelaxationRecord by design
export interface RelaxationRow {
  run_id: string
  session_id: string
  step: number
  afterFailure: number
  failureClass: FailureClass | null
  failureExceptionKind: string | null
  precedingResultKind: string | null
  cause: RelaxationCause
  /** Why it relaxed: only `speculative_cheat` is penalized by the gate and monitor. */
  relax_type: RelaxType
  fromKind: string | null
  toKind: string | null
  axes: RelaxationAxis[]
  previousExpressions: string[]
  expressions: string[]
  goal: string | null
}
// jscpd:ignore-end

/** One run-level row: what ran, under which configuration. */
export interface RunRow extends RunMeta {
  /** Grouping key for dataset splits: the anchor digest when recorded, else the task id. */
  task_group: string
  /** Whether the run carried a `run.json`; always true for the in-process export. */
  has_run_meta: boolean
  /** The interaction mode the run was recorded under. */
  interaction: string
}

/** One DPO pair: the declaration that loosened its check against the tightened one. */
export interface DpoPair {
  prompt: string
  chosen: string
  rejected: string
  meta: Record<string, unknown>
}

/** The rows one finished run contributes. */
export interface RunRows {
  records: DatasetRow[]
  relaxations: RelaxationRow[]
  run: RunRow
}

/**
 * The expressions one recorded declaration evaluates.
 * @param plan - the recorded plan event.
 * @returns the declared expressions; empty for the llm verifier.
 */
export function expressionsOf(plan: Extract<RecordedFlowEvent, { type: 'plan' }>): string[] {
  const verifier = plan.verifierSpec
  if (verifier === undefined) return []
  return verifier.kind === 'assert' ? verifier.conditions : verifier.kind === 'python' ? verifier.checks : []
}

/**
 * Convert one finished run's recorded events into dataset rows. The recorder has
 * already stamped strictness, relaxation, repeat-plan and context on each plan
 * and the verdict referent on each verdict, so no re-derivation is needed.
 * @param input - the run identity, its recorded events, and its metadata.
 * @param attribution - the attribution bundle to classify with; defaults to the log heuristics.
 * @returns the run's dataset rows, relaxation rows, and run-level row.
 */
export function datasetRowsForRun(
  input: {
    runId: string
    sessionId: string
    taskId: string
    taskGroup: string
    events: readonly RecordedFlowEvent[]
    meta: FlowMeta
    run: RunMeta
  },
  attribution: Attribution = defaultAttribution,
): RunRows {
  const records: DatasetRow[] = []
  const relaxations: RelaxationRow[] = []
  let previousExpressions: string[] = []
  let previousStrictness: AssertionStrictness | undefined
  let currentKind: string | undefined
  let currentResultKind: string | null = null
  /** Strictness of the most recent plan, so a verdict row can name the check that governed it. */
  let currentStrictness: AssertionStrictness | undefined
  let failureCount = 0
  let failureClass: FailureClass | null = null
  let failureExceptionKind: string | null = null
  for (const event of input.events) {
    const row: DatasetRow = {
      run_id: input.runId,
      session_id: input.sessionId,
      task_id: input.taskId,
      task_group: input.taskGroup,
      step: event.seq,
      // jscpd:ignore-start -- default-field init mirrors scripts/lcrd-dataset.ts by design
      ts: event.ts,
      type: event.type,
      goal: undefined,
      stop: undefined,
      feasibility: undefined,
      verifier: undefined,
      strictness: undefined,
      relaxation: undefined,
      relaxType: undefined,
      context: undefined,
      tool: undefined,
      callId: undefined,
      argsSummary: undefined,
      resultKind: undefined,
      resultSummary: undefined,
      errorCode: undefined,
      pass: undefined,
      reason: undefined,
      count: undefined,
      verifierKind: undefined,
      failureClass: undefined,
      infraFailure: undefined,
      exceptionKind: undefined,
      repeatPlan: undefined,
      predictionMissed: undefined,
      analysis: undefined,
      knowledge: undefined,
      method: undefined,
      criteria: undefined,
      learned: undefined,
      evidence: undefined,
      intercept: undefined,
      detail: undefined,
      trainability: undefined,
    }
    // jscpd:ignore-end
    if (event.type === 'plan') {
      const expressions = expressionsOf(event)
      row.goal = event.goal
      row.stop = event.stop
      row.feasibility = event.feasibility
      row.verifier = event.verifier
      row.strictness = event.strictness
      row.relaxation = event.relaxation
      row.context = event.context
      row.repeatPlan = event.repeatPlan === true
      row.callId = event.callId
      if (event.relaxation !== undefined && event.relaxation.length > 0) {
        const relaxType = event.relaxType ?? classifyRelaxType({
          failureClass,
          failureExceptionKind,
          axes: event.relaxation,
          strictness: event.strictness,
          previousStrictness,
        })
        row.relaxType = relaxType
        relaxations.push({
          run_id: input.runId,
          session_id: input.sessionId,
          step: event.seq,
          afterFailure: failureCount,
          failureClass,
          failureExceptionKind,
          precedingResultKind: currentResultKind,
          cause: attribution.classifyRelaxationCause(failureClass, failureExceptionKind, event.relaxation),
          relax_type: relaxType,
          fromKind: event.strictness?.kind ?? null,
          toKind: event.verifier,
          axes: event.relaxation,
          previousExpressions,
          expressions,
          goal: event.goal,
        })
      }
      previousExpressions = expressions
      previousStrictness = event.strictness
      currentKind = event.verifier
      currentStrictness = event.strictness
    } else if (event.type === 'tool') {
      row.tool = event.name
      row.callId = event.callId
      row.argsSummary = event.argsSummary
      row.resultKind = event.resultKind
      row.resultSummary = event.resultSummary
      row.errorCode = event.errorCode
      if (event.resultKind !== undefined) currentResultKind = event.resultKind
    } else if (event.type === 'verdict') {
      row.pass = event.pass
      row.reason = event.reason
      row.count = event.count
      row.verifierKind = event.verifierKind ?? currentKind
      row.exceptionKind = event.exceptionKind
      row.predictionMissed = event.predictionMissed
      row.strictness = currentStrictness
      if (event.pass) {
        failureCount = 0
        failureClass = null
        failureExceptionKind = null
      } else {
        failureCount = event.count ?? failureCount + 1
        failureClass = attribution.classifyFailure(event.reason, event.exceptionKind, event.verifierKind ?? currentKind)
        failureExceptionKind = event.exceptionKind ?? null
        row.failureClass = failureClass
        row.infraFailure = failureClass === 'infra-error'
      }
    } else if (event.type === 'learn') {
      row.analysis = event.analysis
      row.knowledge = event.knowledge
      row.method = event.method
      row.criteria = event.criteria
    } else if (event.type === 'learn-verify') {
      row.learned = event.learned
      row.evidence = event.evidence
      row.count = event.count
    } else {
      row.intercept = event.kind
      row.detail = event.detail
    }
    row.trainability = attribution.classifyTrainability(row)
    records.push(row)
  }
  return {
    records,
    relaxations,
    run: { ...input.run, task_group: input.taskGroup, has_run_meta: true, interaction: input.meta.human_interaction_mode },
  }
}

/** The dataset files one export appends to. */
export const DATASET_FILES = {
  dataset: 'dataset.jsonl',
  relaxations: 'relaxations.jsonl',
  runs: 'runs.jsonl',
  dpo: 'dpo.jsonl',
  trainable: 'trainable.jsonl',
  needsReview: 'needs_review.jsonl',
} as const

/**
 * Classify one dataset row's trainability from its recorded type and, for a
 * verdict, its failure class and strictness. Context rows (plan/tool/learn/intercept)
 * carry no label of their own and are trainable so a downstream sequence can be
 * rebuilt; a verdict is trainable when the engine judged it (pass, assertion-invalid),
 * needs review when the label is ambiguous (honest-mismatch, llm-stop-unmet,
 * python-check-failed, tool-isError, unclassified, or a pass whose governing
 * check was presence-only), and discarded when the environment or the verifier
 * infra, not the model, caused it (infra-error, python-timeout, exit-code,
 * llm-bad-output).
 * @param row - one dataset row.
 * @returns the trainability verdict.
 */
export function classifyTrainability(
  row: Pick<DatasetRow, 'type' | 'pass' | 'failureClass' | 'strictness'>,
): Trainability {
  if (row.type !== 'verdict') return 'trainable'
  if (row.pass === true) {
    return row.strictness?.presenceOnly === true ? 'needs-review' : 'trainable'
  }
  switch (row.failureClass) {
    case 'infra-error':
    case 'python-timeout':
    case 'exit-code':
    case 'llm-bad-output':
      return 'discard'
    case 'assertion-invalid':
      return 'trainable'
    case 'honest-mismatch':
    case 'llm-stop-unmet':
    case 'python-check-failed':
    case 'tool-isError':
    case 'unclassified':
      return 'needs-review'
    case undefined:
      return 'needs-review'
  }
}

/** The default attribution bundle: the log-heuristic taxonomy in this module. */
export const defaultAttribution: Attribution = {
  classifyFailure,
  classifyRelaxationCause,
  classifyRelaxType,
  classifyTrainability,
}

/**
 * Downgrade `trainable` rows whose measured declaration was too weak to trust
 * as positive training data: a passing assert whose probe hold rate meets the
 * configured ceiling passes LCRD's discrimination gate yet still holds on most
 * probe inputs, so the pass may reflect a loose check rather than the work.
 * Only run when the declaration-level `declarationMaxHoldRate` gate is off —
 * with that gate on, such a declaration never becomes effective, so no
 * recorded verdict can carry its hold rate; the live path is re-exporting a
 * corpus that was recorded before the gate was turned on.
 * @param base - the attribution bundle supplying the base labels.
 * @param declarationMaxHoldRate - the configured hold-rate ceiling; undefined returns `base` unchanged.
 * @returns the wrapped bundle, or `base` when no ceiling is configured.
 */
export function withHoldRateReview(base: Attribution, declarationMaxHoldRate: number | undefined): Attribution {
  if (declarationMaxHoldRate === undefined) return base
  const classifyRelaxType = base.classifyRelaxType?.bind(base)
  return {
    classifyFailure: (reason, exceptionKind, verifierKind) => base.classifyFailure(reason, exceptionKind, verifierKind),
    classifyRelaxationCause: (failureClass, failureExceptionKind, axes) =>
      base.classifyRelaxationCause(failureClass, failureExceptionKind, axes),
    ...classifyRelaxType === undefined ? {} : { classifyRelaxType: (input: RelaxTypeInput) => classifyRelaxType(input) },
    classifyTrainability: (row): Trainability => {
      const label = base.classifyTrainability(row)
      const rate = row.strictness?.maxHoldRate
      if (label === 'trainable' && row.type === 'verdict' && row.pass === true && rate !== null && rate !== undefined && rate >= declarationMaxHoldRate) {
        return 'needs-review'
      }
      return label
    },
  }
}

/**
 * Append one run's rows to the dataset files, creating the directory when needed.
 * The full stream goes to `dataset.jsonl` unchanged; each row also lands in
 * `trainable.jsonl` or `needs_review.jsonl` by its stamped trainability label
 * (falling back to the default attribution for rows built without one), and
 * discarded rows appear only in the full stream, never in a training subset.
 * @param datasetDir - the directory holding the dataset files.
 * @param rows - the run's dataset rows and DPO pairs.
 * @param pairs - the DPO pairs built for this run.
 */
export function appendDatasetRows(datasetDir: string, rows: RunRows, pairs: readonly DpoPair[]): void {
  mkdirSync(datasetDir, { recursive: true })
  const lines = (values: readonly unknown[]): string => values.map(value => `${JSON.stringify(value)}\n`).join('')
  appendFileSync(join(datasetDir, DATASET_FILES.dataset), lines(rows.records), 'utf8')
  appendFileSync(join(datasetDir, DATASET_FILES.relaxations), lines(rows.relaxations), 'utf8')
  appendFileSync(join(datasetDir, DATASET_FILES.runs), lines([rows.run]), 'utf8')
  if (pairs.length > 0) appendFileSync(join(datasetDir, DATASET_FILES.dpo), lines(pairs), 'utf8')
  const trainabilityOf = (row: DatasetRow): Trainability =>
    row.trainability ?? defaultAttribution.classifyTrainability(row)
  const trainable = rows.records.filter(row => trainabilityOf(row) === 'trainable')
  const needsReview = rows.records.filter(row => trainabilityOf(row) === 'needs-review')
  if (trainable.length > 0) appendFileSync(join(datasetDir, DATASET_FILES.trainable), lines(trainable), 'utf8')
  if (needsReview.length > 0) appendFileSync(join(datasetDir, DATASET_FILES.needsReview), lines(needsReview), 'utf8')
}

/**
 * Ensure the dataset files exist so a later append opens a real file.
 * @param datasetDir - the directory holding the dataset files.
 */
export function ensureDatasetFiles(datasetDir: string): void {
  mkdirSync(datasetDir, { recursive: true })
  for (const file of Object.values(DATASET_FILES)) {
    const path = join(datasetDir, file)
    if (!existsSync(path)) writeFileSync(path, '', 'utf8')
  }
}

/** One message of the model-visible transcript the pair's prompt is rendered from. */
export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolCalls?: { name: string; arguments: string; callId: string }[]
  callId?: string
  isError?: boolean
  /** Message source kind, so engine-injected notices stay identifiable. */
  source?: string
}

/**
 * Render one transcript entry as text.
 * @param entry - the transcript entry.
 * @returns the rendered text with its role tag.
 */
export function renderTranscriptEntry(entry: TranscriptEntry): string {
  const lines = [`<${entry.role}${entry.source === undefined ? '' : ` source=${entry.source}`}>`]
  if (entry.text.length > 0) lines.push(entry.text)
  for (const call of entry.toolCalls ?? []) lines.push(`<tool-call name=${call.name}>${call.arguments}</tool-call>`)
  if (entry.isError === true) lines.push('(error result)')
  return lines.join('\n')
}

/**
 * Replace the expressions of one raw `lcrd_plan` arguments string.
 * @param rawArguments - the model's raw arguments JSON.
 * @param expressions - the expression list to install.
 * @returns the rewritten arguments, or null for an unsupported verifier kind.
 */
export function withExpressions(rawArguments: string, expressions: readonly string[]): string | null {
  try {
    const parsed = JSON.parse(rawArguments) as { verifier?: { kind?: unknown } | null }
    const verifier = parsed.verifier
    if (verifier === undefined || verifier === null) return null
    if (verifier.kind === 'assert') (verifier as { conditions?: unknown }).conditions = [...expressions]
    else if (verifier.kind === 'python') (verifier as { checks?: unknown }).checks = [...expressions]
    else return null
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

/**
 * Build the DPO pairs of one run: each relaxation's real declaration against the
 * same declaration with the pre-relaxation check restored.
 * @param input - the run's rows, its transcript, and the plan step to transcript index.
 * @returns the pairs; relaxations whose declaration is missing are left out.
 */
export function dpoPairsForRun(input: {
  rows: RunRows
  transcript: readonly TranscriptEntry[]
  /** Transcript index of the assistant entry carrying each plan step's declaration. */
  planIndexByStep: ReadonlyMap<number, number>
  runId: string
}): DpoPair[] {
  const pairs: DpoPair[] = []
  for (const relaxation of input.rows.relaxations) {
    if (relaxation.previousExpressions.length === 0) continue
    const index = input.planIndexByStep.get(relaxation.step)
    if (index === undefined) continue
    const call = input.transcript[index]?.toolCalls?.find(candidate => candidate.name === 'lcrd_plan')
    if (call === undefined) continue
    const repaired = withExpressions(call.arguments, relaxation.previousExpressions)
    if (repaired === null) continue
    const prompt = input.transcript.slice(0, index)
    const chosen: TranscriptEntry = { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: repaired, callId: 'chosen' }] }
    const rejected: TranscriptEntry = { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: call.arguments, callId: 'rejected' }] }
    pairs.push({
      prompt: prompt.map(renderTranscriptEntry).join('\n'),
      chosen: renderTranscriptEntry(chosen),
      rejected: renderTranscriptEntry(rejected),
      meta: {
        run_id: input.runId,
        step: relaxation.step,
        goal: relaxation.goal,
        after_failure: relaxation.afterFailure,
        failure_class: relaxation.failureClass,
        cause: relaxation.cause,
        axes: relaxation.axes,
        rejected_expressions: relaxation.expressions,
        chosen_expressions: relaxation.previousExpressions,
        synthetic: true,
        repair: 'restore-previous-check',
        repeat_declaration: prompt.some(entry =>
          (entry.toolCalls ?? []).some(candidate => candidate.name === 'lcrd_plan' && candidate.arguments === call.arguments)),
      },
    })
  }
  return pairs
}
