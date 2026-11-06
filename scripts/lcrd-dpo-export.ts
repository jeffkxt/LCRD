/**
 * LCRD DPO export: aligns the local session logs with the LCRD dataset and
 * writes DPO pairs.
 *
 * A pair is one declaration that loosened its own check (the model's real
 * output, `rejected`) against the same declaration with the pre-relaxation
 * check restored (`chosen`, constructed — flagged `synthetic: true` in meta).
 * The prompt is the model-visible transcript up to that declaration, rebuilt
 * from the session log: `user/message`, `assistant/message`, `tool/call`, and
 * `tool/result` events in order.
 *
 * Usage:
 *   pnpm run lcrd:dpo                        # default paths, substance-dropped pairs
 *   pnpm run lcrd:dpo -- --causes all --sample 1
 *   pnpm run lcrd:dpo -- --dataset <corpus dir> --sessions <sessions root>
 *
 * The dataset corpus is produced by `datasetExport: run` or by the repository's
 * dataset export tooling; this script only aligns it with session logs.
 *
 * @module lcrd-dpo-export
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

/** Default dataset directory written by the plugin's `datasetExport: run` config. */
export const DEFAULT_DATASET_DIR = 'packages/experimental/lcrd/dataset'

/**
 * The Harness home sessions root.
 * @returns the absolute sessions directory.
 */
export function defaultSessionsDir(): string {
  return join(homedir(), '.dsh', 'sessions')
}

/** One dataset record (only the fields this exporter reads). */
interface DatasetRecord {
  run_id: string
  type: string
  step: number
  goal?: string
  stop?: string
  verifier?: string
  relaxation?: string[]
}

/** One relaxation record (only the fields this exporter reads). */
interface RelaxationRecord {
  run_id: string
  session_id: string
  step: number
  afterFailure: number
  failureClass: string | null
  cause: string
  axes: string[]
  previousExpressions: string[]
  expressions: string[]
  goal: string | null
}

/** One message in the rebuilt transcript. */
interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool'
  /** Plain text of the message; empty when it carried only a tool call. */
  text: string
  /** Tool calls the assistant made in this message. */
  toolCalls?: { name: string; arguments: string; callId: string }[]
  callId?: string
  isError?: boolean
  /** Message source kind, so engine-injected notices stay identifiable. */
  source?: string
}

/** One `lcrd_plan` declaration found in a session log. */
interface PlanCall {
  /** Raw `arguments` JSON exactly as the model produced it. */
  arguments: string
  /** Transcript index of the assistant message carrying the call. */
  messageIndex: number
  goal: string | null
  /** Whether the tool result was an error, meaning the engine rejected the declaration. */
  rejected: boolean
}

/** One exported DPO pair. */
export interface DpoPair {
  prompt: string | TranscriptMessage[]
  chosen: string | TranscriptMessage[]
  rejected: string | TranscriptMessage[]
  meta: Record<string, unknown>
}

/** The event payload: durable logs wrap it under `data`. */
interface SessionEventData {
  content?: unknown
  source?: { kind?: string }
  toolCallId?: unknown
  isError?: unknown
  message?: unknown
  callId?: unknown
  name?: unknown
  arguments?: unknown
  error?: { name?: string; code?: string }
}

/** One session log line: the header or a wrapped `SessionEvent`; only the fields read here. */
interface SessionEventLine extends SessionEventData {
  type: string
  /** Event payload; the header line has none. */
  data?: SessionEventData & { message?: { content?: unknown; source?: { kind?: string }; toolCallId?: unknown; isError?: unknown } }
}

/** Read one field as a string, ignoring any non-string value. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The payload of one event line, or the line itself for an unwrapped log. */
function payloadOf(event: SessionEventLine): SessionEventData {
  return event.data ?? event
}

/**
 * Read one JSONL file into parsed records, skipping blank lines.
 * @param path - the file to read.
 * @returns the parsed records; empty when the file is absent.
 */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T)
}

/**
 * Decode every Zstandard frame of an append-only session log.
 * @param file - the `session*.jsonl.zstd` path.
 * @returns the parsed log lines, header first.
 */
function decodeSessionLog(file: string): SessionEventLine[] {
  const buffer = readFileSync(file)
  const { frames } = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  let text = ''
  try {
    for (const plain of decoder.decode(buffer, frames)) text += plain.toString('utf8')
  } finally {
    decoder.close()
  }
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as SessionEventLine)
}

/**
 * Join the text blocks of one message's content.
 * @param content - the message content, a block array in the durable log.
 * @returns the concatenated text blocks.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * Rebuild the model-visible transcript and the `lcrd_plan` declarations of one session.
 * @param file - the session log path.
 * @returns the ordered transcript and every plan declaration found in it.
 */
function readSession(file: string): { messages: TranscriptMessage[]; plans: PlanCall[] } {
  const events = decodeSessionLog(file)
  const messages: TranscriptMessage[] = []
  const plans: PlanCall[] = []
  /** callId to plan index, so a rejected declaration can be marked when its result arrives. */
  const planOfCall = new Map<string, number>()
  for (const event of events) {
    const payload = payloadOf(event)
    if (event.type === 'user/message' && payload.message !== undefined) {
      const message = payload.message as { content?: unknown; source?: { kind?: string } }
      messages.push({
        role: 'user',
        text: textOf(message.content),
        ...(message.source?.kind === undefined ? {} : { source: message.source.kind }),
      })
    } else if (event.type === 'assistant/message' && payload.message !== undefined) {
      // Only the model's text: its tool calls have their own `tool/call` events,
      // so carrying the embedded blocks too would duplicate every call.
      const message = payload.message as { content?: unknown }
      messages.push({ role: 'assistant', text: textOf(message.content) })
    } else if (event.type === 'tool/call') {
      // The model's call is logged as its own event, carrying the raw arguments.
      const callId = asString(payload.callId)
      const name = asString(payload.name)
      const rawArguments = asString(payload.arguments)
      messages.push({ role: 'assistant', text: '', toolCalls: [{ name, arguments: rawArguments, callId }] })
      if (name === 'lcrd_plan') {
        plans.push({ arguments: rawArguments, messageIndex: messages.length - 1, goal: goalOf(rawArguments), rejected: false })
        planOfCall.set(callId, plans.length - 1)
      }
    } else if (event.type === 'tool/result' && payload.message !== undefined) {
      const result = payload.message as { content?: unknown; toolCallId?: unknown; isError?: unknown }
      const callId = asString(result.toolCallId) || asString(payload.toolCallId)
      const isError = result.isError === true || payload.error !== undefined
      const index = planOfCall.get(callId)
      if (index !== undefined && isError) {
        const call = plans[index]
        if (call !== undefined) call.rejected = true
      }
      messages.push({ role: 'tool', text: textOf(result.content), callId, isError })
    }
  }
  return { messages, plans }
}

/**
 * Read the `goal` field out of one raw `lcrd_plan` arguments string.
 * @param rawArguments - the model's raw arguments JSON.
 * @returns the declared goal, or null when the JSON is unusable.
 */
function goalOf(rawArguments: string): string | null {
  try {
    const parsed = JSON.parse(rawArguments) as { goal?: unknown }
    return typeof parsed.goal === 'string' ? parsed.goal : null
  } catch {
    return null
  }
}

/**
 * The expression list of one raw declaration.
 * @param rawArguments - the model's raw arguments JSON.
 * @returns the declared expressions, or an empty list for an unsupported kind.
 */
function expressionsOf(rawArguments: string): string[] {
  try {
    const parsed = JSON.parse(rawArguments) as { verifier?: { kind?: unknown; conditions?: unknown; checks?: unknown } | null }
    const verifier = parsed.verifier
    if (verifier === undefined || verifier === null) return []
    const list = verifier.kind === 'assert' ? verifier.conditions : verifier.kind === 'python' ? verifier.checks : undefined
    return Array.isArray(list) ? list.map(entry => String(entry)) : []
  } catch {
    return []
  }
}

/**
 * Whether one raw declaration carries exactly this expression list.
 * @param rawArguments - the model's raw arguments JSON.
 * @param expressions - the recorded expression list to compare against.
 * @returns true when the declaration's verifier carries the same expressions.
 */
function hasExpressions(rawArguments: string, expressions: readonly string[]): boolean {
  const list = expressionsOf(rawArguments)
  return list.length === expressions.length && list.every((value, index) => value === expressions[index])
}

/**
 * Replace the expressions of one raw `lcrd_plan` arguments string, keeping every other field.
 * @param rawArguments - the model's raw arguments JSON.
 * @param expressions - the expression list to install.
 * @returns the rewritten arguments, or null for an unsupported verifier kind.
 */
function withExpressions(rawArguments: string, expressions: readonly string[]): string | null {
  try {
    const parsed = JSON.parse(rawArguments) as { verifier?: { kind?: unknown; conditions?: unknown; checks?: unknown } | null }
    const verifier = parsed.verifier
    if (verifier === undefined || verifier === null) return null
    if (verifier.kind === 'assert') verifier.conditions = [...expressions]
    else if (verifier.kind === 'python') verifier.checks = [...expressions]
    else return null
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

/**
 * Render one transcript message as text for the string format.
 * @param message - the transcript message.
 * @returns the rendered text with its role tag.
 */
function renderMessage(message: TranscriptMessage): string {
  const lines = [`<${message.role}${message.source === undefined ? '' : ` source=${message.source}`}>`]
  if (message.text.length > 0) lines.push(message.text)
  for (const call of message.toolCalls ?? []) lines.push(`<tool-call name=${call.name}>${call.arguments}</tool-call>`)
  if (message.isError === true) lines.push('(error result)')
  return lines.join('\n')
}

/**
 * Build the DPO pair for one relaxation.
 * @param relaxation - the relaxation record naming the declaration to compare.
 * @param plan - the relaxed declaration found in the session log.
 * @param prompt - the transcript before that declaration.
 * @param format - `trl` renders strings, `messages` keeps message arrays.
 * @returns the pair, or the reason it could not be built.
 */
export function buildPair(
  relaxation: RelaxationRecord,
  plan: PlanCall,
  prompt: TranscriptMessage[],
  format: 'trl' | 'messages',
): { pair: DpoPair } | { skip: string } {
  if (relaxation.previousExpressions.length === 0) return { skip: 'no-previous-expressions' }
  const repaired = withExpressions(plan.arguments, relaxation.previousExpressions)
  if (repaired === null) return { skip: 'unsupported-verifier-kind' }
  const chosenMessage: TranscriptMessage = {
    role: 'assistant',
    text: '',
    toolCalls: [{ name: 'lcrd_plan', arguments: repaired, callId: 'chosen' }],
  }
  const rejectedMessage: TranscriptMessage = {
    role: 'assistant',
    text: '',
    toolCalls: [{ name: 'lcrd_plan', arguments: plan.arguments, callId: 'rejected' }],
  }
  const meta: Record<string, unknown> = {
    run_id: relaxation.run_id,
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
    /** True when the prompt already carries a declaration with the same goal and the same check. */
    repeat_declaration: (() => {
      const wanted = expressionsOf(plan.arguments)
      const wantedGoal = goalOf(plan.arguments)
      return prompt.some(message => (message.toolCalls ?? []).some(call =>
        goalOf(call.arguments) === wantedGoal && hasExpressions(call.arguments, wanted)))
    })(),
  }
  if (format === 'messages') return { pair: { prompt, chosen: [chosenMessage], rejected: [rejectedMessage], meta } }
  return {
    pair: {
      prompt: prompt.map(renderMessage).join('\n'),
      chosen: renderMessage(chosenMessage),
      rejected: renderMessage(rejectedMessage),
      meta,
    },
  }
}

/**
 * Locate a session log under the Harness home: session directories appear with
 * and without the `session-` prefix, so both spellings are tried.
 * @param root - the sessions root.
 * @param uuid - the session id with any `session-` prefix already stripped.
 * @returns the log path, or null when the session is absent.
 */
function findSessionFile(root: string, uuid: string): string | null {
  if (!existsSync(root)) return null
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const dirName of [`session-${uuid}`, uuid]) {
      const dir = join(root, project.name, dirName)
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        // Session logs carry a layout version in the name (`session.v4.jsonl.zstd`).
        if (file.startsWith('session') && file.includes('.jsonl')) return join(dir, file)
      }
    }
  }
  return null
}

/**
 * Align one relaxation with its session log and its declaration.
 * @param relaxation - the relaxation record.
 * @param sessionsRoot - the sessions root.
 * @param plansByRun - dataset plan records grouped by run, in order.
 * @param sessionCache - decoded sessions, so each log is read once.
 * @returns the session and the declaration, or the reason the alignment failed.
 */
function align(
  relaxation: RelaxationRecord,
  sessionsRoot: string,
  plansByRun: Map<string, DatasetRecord[]>,
  sessionCache: Map<string, { messages: TranscriptMessage[]; plans: PlanCall[] } | null>,
): { session: { messages: TranscriptMessage[]; plans: PlanCall[] }; plan: PlanCall } | { skip: string } {
  const uuid = relaxation.session_id.replace(/^session-/, '')
  const sessionFile = findSessionFile(sessionsRoot, uuid)
  if (sessionFile === null) return { skip: 'no-session-log' }
  if (!sessionCache.has(uuid)) sessionCache.set(uuid, readSession(sessionFile))
  const session = sessionCache.get(uuid)
  if (session === null || session === undefined) return { skip: 'unreadable-session-log' }
  const accepted = session.plans.filter(plan => !plan.rejected)
  if (accepted.length === 0) return { skip: 'no-plan-calls-in-session' }
  // The dataset records one plan event per accepted declaration in order, so the
  // declaration's position there is the primary key; its identity (goal plus the
  // exact expression list) then verifies the alignment instead of assuming it.
  const datasetPlans = plansByRun.get(relaxation.run_id) ?? []
  const position = datasetPlans.findIndex(record => record.step === relaxation.step)
  if (position === -1) return { skip: 'plan-not-in-dataset' }
  const plan = accepted[position]
  if (plan === undefined) return { skip: 'plan-position-out-of-range' }
  if (relaxation.goal !== null && plan.goal !== relaxation.goal) return { skip: 'goal-mismatch' }
  if (!hasExpressions(plan.arguments, relaxation.expressions)) return { skip: 'check-mismatch' }
  return { session, plan }
}

/**
 * Export the dataset's relaxations as DPO pairs.
 * @param datasetDir - directory holding `dataset.jsonl` and `relaxations.jsonl`.
 * @param sessionsRoot - the Harness home sessions root.
 * @param options - cause filter, output format, incremental run filter, and already-exported keys.
 * @returns the pairs, the skip counts, and how many relaxations were selected.
 */
export function exportPairs(
  datasetDir: string,
  sessionsRoot: string,
  options: {
    causes: string[]
    format: 'trl' | 'messages'
    limit?: number
    /** When given, only these runs are exported (incremental runs). */
    runFilter?: (runId: string) => boolean
    /** Pairs already exported, keyed `${run_id}\u0000${step}`, so reruns never duplicate them. */
    exclude?: Set<string>
  },
): { pairs: DpoPair[]; skipped: Record<string, number>; relaxations: number } {
  const relaxations = readJsonl<RelaxationRecord>(join(datasetDir, 'relaxations.jsonl'))
  const records = readJsonl<DatasetRecord>(join(datasetDir, 'dataset.jsonl'))
  const plansByRun = new Map<string, DatasetRecord[]>()
  for (const record of records) {
    if (record.type !== 'plan') continue
    const list = plansByRun.get(record.run_id) ?? []
    list.push(record)
    plansByRun.set(record.run_id, list)
  }
  const selected = relaxations.filter(relaxation =>
    options.causes.includes(relaxation.cause) && (options.runFilter === undefined || options.runFilter(relaxation.run_id)))
  const sessionCache = new Map<string, { messages: TranscriptMessage[]; plans: PlanCall[] } | null>()
  const pairs: DpoPair[] = []
  const skipped: Record<string, number> = {}
  const count = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  for (const relaxation of selected) {
    if (options.limit !== undefined && pairs.length >= options.limit) break
    if (options.exclude?.has(`${relaxation.run_id}\u0000${relaxation.step}`) === true) continue
    const aligned = align(relaxation, sessionsRoot, plansByRun, sessionCache)
    if ('skip' in aligned) {
      count(aligned.skip)
      continue
    }
    const prompt = aligned.session.messages.slice(0, aligned.plan.messageIndex)
    const built = buildPair(relaxation, aligned.plan, prompt, options.format)
    if ('skip' in built) {
      count(built.skip)
      continue
    }
    pairs.push(built.pair)
  }
  return { pairs, skipped, relaxations: selected.length }
}

/** Read one `--name value` argument. */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Read one `--name value` argument.
 * @param name - the flag, including its leading dashes.
 * @param fallback - the value used when the flag is absent.
 * @returns the flag's value or the fallback.
 */
function argOr(name: string, fallback: string): string {
  return argOf(name) ?? fallback
}

/** The causes every export mode understands. */
const ALL_CAUSES = ['substance-dropped', 'type-adaptation', 'undetermined']

/**
 * Parse one `--causes` value.
 * @param value - `all` or a comma-separated cause list.
 * @returns the selected causes.
 */
export function parseCauses(value: string): string[] {
  return value === 'all' ? ALL_CAUSES : value.split(',').map(cause => cause.trim())
}

/** Export the pairs and print the run summary. */
export function main(): void {
  const datasetDir = resolve(argOr('--dataset', DEFAULT_DATASET_DIR))
  const sessionsRoot = resolve(argOr('--sessions', defaultSessionsDir()))
  const out = resolve(argOr('--out', join(DEFAULT_DATASET_DIR, 'dpo.jsonl')))
  const format = argOr('--format', 'trl') === 'messages' ? 'messages' : 'trl'
  const causes = parseCauses(argOr('--causes', 'substance-dropped'))
  const limitArg = argOf('--limit')
  const { pairs, skipped, relaxations } = exportPairs(datasetDir, sessionsRoot, {
    causes,
    format,
    ...(limitArg === undefined ? {} : { limit: Number(limitArg) }),
  })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, pairs.map(pair => `${JSON.stringify(pair)}\n`).join(''), 'utf8')
  console.log(`lcrd-dpo: ${pairs.length} pairs from ${relaxations} relaxations (causes: ${causes.join(',')}) -> ${out}`)
  console.log(`  skipped: ${Object.entries(skipped).map(([reason, count]) => `${reason}=${count}`).join(' ') || 'none'}`)
  const flagged = pairs.filter(pair => (pair.meta as { repeat_declaration?: boolean }).repeat_declaration === true).length
  console.log(`  prompt already carries an equivalent declaration: ${flagged}/${pairs.length} (meta.repeat_declaration)`)
  const sample = Number(argOr('--sample', '0'))
  for (const pair of pairs.slice(0, sample)) console.log(`--- sample ---\n${JSON.stringify(pair, null, 2)}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
