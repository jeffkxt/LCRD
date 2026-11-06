/**
 * Record-resolution instrumentation: assertion strictness readings, relaxation
 * axes, tool summaries, and the recorder fields that make a run's transcript
 * joinable (envelope, append-only stream, meta backfill).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FlowRecorder,
  clipSummary,
  describeStrictness,
  pluginVersion,
  relaxationAxes,
  specExpressions,
  shortAgentId,
  summarizeArguments,
  summarizeResult,
  type AssertionStrictness,
} from '@deepseek-ai/dsh-experimental-lcrd'
import { probeExpression } from '../src/verifiers.ts'

/** The task subfolder one agent's artifacts land in, for a recorded goal. */
const goalDir = (agentId: string, goal: string): string => `${goal}-${shortAgentId(agentId)}`

/** One strictness reading with explicit overrides, for the axis tests. */
const strength = (overrides: Partial<AssertionStrictness>): AssertionStrictness => ({
  kind: 'assert',
  mode: 'oracle',
  expressions: 2,
  tautological: 0,
  literal: true,
  structural: true,
  usesContent: false,
  presenceOnly: false,
  maxHoldRate: null,
  discrimination: 'discriminating',
  ...overrides,
})

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-instr-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('probeExpression', () => {
  it('classifies an expression that reads no bound variable', () => {
    expect(probeExpression('true')).toBe('unbound')
  })

  it('classifies an expression that does not compile', () => {
    expect(probeExpression('result ===')).toBe('invalid')
  })

  it('classifies an expression that holds on every probe input', () => {
    expect(probeExpression('typeof isError === "boolean"')).toBe('tautological')
  })

  it('classifies an expression that fails at least one probe input', () => {
    expect(probeExpression('result === 5')).toBe('discriminating')
    expect(probeExpression('content.includes("ok")')).toBe('discriminating')
  })
})

describe('specExpressions', () => {
  it('reads the expression list of each verifier kind', () => {
    expect(specExpressions({ kind: 'assert', conditions: ['a'] })).toEqual(['a'])
    expect(specExpressions({ kind: 'python', checks: ['b'] })).toEqual(['b'])
    expect(specExpressions({ kind: 'llm' })).toEqual([])
  })
})

describe('describeStrictness', () => {
  it('reads structural field access and a pinned literal', () => {
    const reading = describeStrictness({ kind: 'assert', conditions: ["result.get('downloaded') === true"] })
    expect(reading).toMatchObject({
      kind: 'assert',
      expressions: 1,
      literal: true,
      structural: true,
      usesContent: false,
      presenceOnly: false,
      discrimination: 'discriminating',
    })
  })

  it('reads a presence-only check that pins nothing', () => {
    const reading = describeStrictness({ kind: 'assert', conditions: ['result !== undefined', 'content !== undefined'] })
    expect(reading).toMatchObject({ literal: false, structural: false, presenceOnly: true })
  })

  it('counts tautological expressions and reports the aggregate reading', () => {
    const reading = describeStrictness({ kind: 'assert', conditions: ['typeof isError === "boolean"'] })
    expect(reading).toMatchObject({ tautological: 1, discrimination: 'tautological' })
  })

  it('reports the weakest expression of a declaration', () => {
    expect(describeStrictness({ kind: 'assert', conditions: ['result === 5', '1 === 1'] }).discrimination).toBe('unbound')
    expect(describeStrictness({ kind: 'assert', conditions: ['result === 5', 'result ==='] }).discrimination).toBe('invalid')
    expect(describeStrictness({ kind: 'assert', conditions: ['result === 5'] }).discrimination).toBe('discriminating')
  })

  it('reads a probe declaration as an unmeasured prediction', () => {
    expect(describeStrictness({ kind: 'assert', mode: 'probe', conditions: ['result === 5'] })).toMatchObject({
      mode: 'probe',
      discrimination: 'unchecked',
      tautological: 0,
      maxHoldRate: null,
    })
    expect(describeStrictness({ kind: 'assert', conditions: ['result === 5'] })).toMatchObject({
      mode: 'oracle',
      discrimination: 'discriminating',
    })
  })

  it('reports no relaxation across a binding-mode switch', () => {
    const oracle = strength({ mode: 'oracle', presenceOnly: false, literal: true, structural: true, maxHoldRate: 0.2 })
    const probe = strength({ mode: 'probe', presenceOnly: true, literal: false, structural: false, maxHoldRate: null })
    expect(relaxationAxes(oracle, probe)).toEqual([])
    expect(relaxationAxes(probe, oracle)).toEqual([])
  })

  it('reads content use and leaves the python and llm probes unchecked', () => {
    expect(describeStrictness({ kind: 'assert', conditions: ['content.includes("x")'] }).usesContent).toBe(true)
    expect(describeStrictness({ kind: 'python', checks: ['result is not None'] })).toMatchObject({
      kind: 'python',
      expressions: 1,
      discrimination: 'unchecked',
      maxHoldRate: null,
    })
    expect(describeStrictness({ kind: 'llm' })).toMatchObject({
      kind: 'llm',
      expressions: 0,
      presenceOnly: false,
      discrimination: 'unchecked',
      maxHoldRate: null,
    })
  })

  it('measures the hold rate of a probed declaration', () => {
    // A tautology holds on every probe input; a pinned check holds on almost none.
    expect(describeStrictness({ kind: 'assert', conditions: ['typeof isError === "boolean"'] }).maxHoldRate).toBe(1)
    expect(describeStrictness({ kind: 'assert', conditions: ['result === 5'] }).maxHoldRate).toBe(0)
    // The weakest expression decides the declaration's reading.
    const mixed = describeStrictness({ kind: 'assert', conditions: ['result === 5', 'result !== undefined'] })
    expect(mixed.maxHoldRate).toBeGreaterThan(0.9)
  })

  it('leaves the rate unmeasured when no expression can be probed', () => {
    expect(describeStrictness({ kind: 'assert', conditions: ['1 === 1'] }).maxHoldRate).toBeNull()
  })

  it('reads an empty declaration as empty rather than tautological', () => {
    // An empty list is not a tautology: there is no expression to probe, and the
    // engine rejects the declaration outright.
    expect(describeStrictness({ kind: 'assert', conditions: [] })).toMatchObject({
      expressions: 0,
      tautological: 0,
      presenceOnly: false,
      maxHoldRate: null,
      discrimination: 'empty',
    })
    expect(describeStrictness({ kind: 'python', checks: [] })).toMatchObject({ expressions: 0, discrimination: 'empty' })
  })
})

describe('relaxationAxes', () => {
  it('names every axis a declaration can loosen along', () => {
    expect(relaxationAxes(strength({}), strength({ kind: 'llm', expressions: 0 })))
      .toEqual(['verifier-kind', 'fewer-expressions'])
    expect(relaxationAxes(strength({}), strength({ presenceOnly: true, structural: false, literal: false })))
      .toEqual(['presence-only', 'lost-structural', 'dropped-literals'])
    expect(relaxationAxes(strength({ expressions: 3 }), strength({ expressions: 2 })))
      .toEqual(['fewer-expressions'])
    expect(relaxationAxes(strength({ usesContent: false }), strength({ usesContent: true })))
      .toEqual(['substring-text'])
  })

  it('reports the quantitative constraint drop and ignores unmeasured rates', () => {
    expect(relaxationAxes(strength({ maxHoldRate: 0 }), strength({ maxHoldRate: 0.9 }))).toEqual(['weaker-constraint'])
    expect(relaxationAxes(strength({ maxHoldRate: 0.9 }), strength({ maxHoldRate: 0 }))).toEqual([])
    // A python or llm declaration cannot be probed, so no rate comparison happens.
    expect(relaxationAxes(strength({ maxHoldRate: null }), strength({ maxHoldRate: 1 }))).toEqual([])
  })

  it('reports no axis when the check keeps or raises its strength', () => {
    expect(relaxationAxes(strength({}), strength({ expressions: 3 }))).toEqual([])
    expect(relaxationAxes(strength({ literal: false }), strength({ literal: true }))).toEqual([])
  })
})

describe('recorded summaries', () => {
  it('clips a summary to the transcript budget', () => {
    expect(clipSummary('short')).toBe('short')
    const long = 'x'.repeat(300)
    expect(clipSummary(long)).toHaveLength(241)
    expect(clipSummary(long).endsWith('…')).toBe(true)
  })

  it('renders arguments as JSON and marks an unserializable value', () => {
    expect(summarizeArguments({ path: 'a.txt' })).toBe('{"path":"a.txt"}')
    expect(summarizeArguments(undefined)).toBe('undefined')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(summarizeArguments(circular)).toBe('(unserializable arguments)')
  })

  it('projects a result into its runtime kind and value', () => {
    expect(summarizeResult({ isError: false, value: 5, content: [{ type: 'text', text: 'ok' }] }))
      .toEqual({ kind: 'number', summary: '5', error: undefined, errorCode: undefined })
    expect(summarizeResult({ isError: false, value: null, content: [{ type: 'text', text: 'ok' }] }).kind).toBe('null')
    expect(summarizeResult({ isError: false, value: [1], content: [{ type: 'text', text: 'ok' }] }).kind).toBe('array')
    expect(summarizeResult({ isError: false, content: [{ type: 'text', text: 'ok' }], value: { a: 1 } }).kind).toBe('object')
    expect(summarizeResult({ isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'boom' }] }))
      .toEqual({ kind: 'error', summary: 'boom', error: 'boom', errorCode: undefined })
  })

  it('keeps the machine-routable error code of a failed call', () => {
    const failed = summarizeResult({
      isError: true,
      error: { message: 'no sandbox', info: { name: 'SandboxError', code: 'SANDBOX_UNAVAILABLE' } },
      content: [{ type: 'text', text: 'no sandbox' }],
    })
    expect(failed.errorCode).toBe('SANDBOX_UNAVAILABLE')
  })
})

/** Typed view of the instrumentation fields these tests read from the snapshot. */
interface DumpInstrumentation {
  events: {
    seq: number
    ts: string
    type: string
    strictness?: AssertionStrictness
    relaxation?: string[]
    callId?: string
    resultKind?: string
  }[]
  schema_version: number
  events_file: string
  relaxation_count: number
  anchor_digest: string | null
  tb_final_reward: number | null
  root_cause_hint: string | null
}

describe('FlowRecorder instrumentation', () => {
  const agent = { id: 'session-instr', session: { header: {} }, options: {} } as never
  const snapshot = (dir: string, folder: string): DumpInstrumentation =>
    JSON.parse(readFileSync(join(dir, folder, 'lcrd-flow.json'), 'utf8')) as DumpInstrumentation
  const plan = (conditions: string[]): Parameters<FlowRecorder['push']>[0] => ({
    type: 'plan',
    goal: 'g',
    stop: 's',
    feasibility: true,
    verifier: 'assert',
    verifierSpec: { kind: 'assert', conditions },
  })

  it('stamps the envelope and reads each declaration, counting the relaxed ones', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    recorder.push(plan(["result.get('a') === 1", 'result === 5']))
    recorder.push(plan(['result !== undefined']))
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.dump()
    const json = snapshot(dir, goalDir('session-instr', 'g'))
    expect(json.events[0]).toMatchObject({
      seq: 1,
      strictness: { kind: 'assert', expressions: 2, literal: true, structural: true, presenceOnly: false, discrimination: 'discriminating' },
      relaxation: [],
    })
    expect(json.events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(json.events[1]).toMatchObject({
      seq: 2,
      strictness: { expressions: 1, literal: false, structural: false, presenceOnly: true, discrimination: 'discriminating' },
      relaxation: ['fewer-expressions', 'presence-only', 'lost-structural', 'dropped-literals', 'weaker-constraint'],
    })
    expect(json.events[2]).toMatchObject({ type: 'plan', relaxation: [] })
    expect(json.events[2]?.strictness).toBeUndefined()
    expect(json.relaxation_count).toBe(1)
    expect(json.schema_version).toBe(4)
    expect(json.events_file).toBe('lcrd-flow.jsonl')
  })

  it('counts protocol round-trips per tool call', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    recorder.push(plan(['result !== undefined']))
    recorder.push({ type: 'tool', name: 'read', callId: 'c1' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok', callId: 'c1', tool: 'read' })
    recorder.push({ type: 'tool', name: 'read', callId: 'c2' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok', callId: 'c2', tool: 'read' })
    recorder.dump()
    const json = snapshot(dir, goalDir('session-instr', 'g'))
    // One declaration and two verdicts across two tool calls: 1.5 round-trips per call.
    expect(json).toMatchObject({ plan_count: 1, tool_calls: 2, verdicts: 2, overhead_ratio: 1.5 })
  })

  it('appends one JSON line per event to a stream that dumps never rewrite', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({ type: 'tool', name: 'read', callId: 'call-1', argsSummary: '{"path":"a"}', resultKind: 'string', resultSummary: '"ok"' })
    const streamFile = join(dir, goalDir('session-instr', 'g'), 'lcrd-flow.jsonl')
    const appended = readFileSync(streamFile, 'utf8')
    recorder.dump()
    expect(readFileSync(streamFile, 'utf8')).toBe(appended)
    const lines = appended.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 1, type: 'plan' })
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      seq: 2,
      type: 'tool',
      name: 'read',
      callId: 'call-1',
      resultKind: 'string',
      resultSummary: '"ok"',
    })
  })

  it('keeps an external meta backfill across dumps, with constructor options winning', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    recorder.push({ type: 'tool', name: 'read' })
    recorder.dump()
    const file = join(dir, 'session-instr', 'lcrd-flow.json')
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    json['tb_final_reward'] = 1
    json['root_cause_hint'] = 'verifier_code_generation_bug'
    writeFileSync(file, JSON.stringify(json), 'utf8')
    expect(recorder.computeMeta()).toMatchObject({
      tb_final_reward: 1,
      root_cause_hint: 'verifier_code_generation_bug',
    })
    recorder.dump()
    expect((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['tb_final_reward']).toBe(1)
    const pinned = new FlowRecorder(agent, 3, { outDir: dir, tbFinalReward: 0, rootCauseHint: 'pinned' })
    expect(pinned.computeMeta()).toMatchObject({ tb_final_reward: 0, root_cause_hint: 'pinned' })
  })

  it('reads no backfill from a missing, corrupt, or wrongly typed snapshot', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder({ id: 'session-wrong', session: { header: {} }, options: {} } as never, 3, { outDir: dir })
    expect(recorder.computeMeta().tb_final_reward).toBeNull()
    const file = join(dir, 'session-wrong', 'lcrd-flow.json')
    mkdirSync(join(dir, 'session-wrong'), { recursive: true })
    writeFileSync(file, 'not json', 'utf8')
    expect(recorder.computeMeta().root_cause_hint).toBeNull()
    writeFileSync(file, JSON.stringify({ tb_final_reward: 'high', root_cause_hint: 7 }), 'utf8')
    expect(recorder.computeMeta()).toMatchObject({ tb_final_reward: null, root_cause_hint: null })
  })

  it('reports the first anchor digest and excerpt, and only those', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: tempDir() })
    expect(recorder.computeMeta()).toMatchObject({ anchor_digest: null, anchor_excerpt: null })
    recorder.markAnchorDigest('aaaa', '把 a.py 建好')
    recorder.markAnchorDigest('bbbb', '别的任务')
    expect(recorder.computeMeta()).toMatchObject({ anchor_digest: 'aaaa', anchor_excerpt: '把 a.py 建好' })
    expect(recorder.computeRunMeta().anchor_excerpt).toBe('把 a.py 建好')
  })
})

/** One recorded event as read back from the append-only stream. */
interface StreamEvent {
  type: string
  callId?: string
  tool?: string
  verifierKind?: string
  exceptionKind?: string
  errorMessage?: string
  errorCode?: string
  resultKind?: string
  repeatPlan?: boolean
  context?: { failures: number; phase: string; lastPass: boolean | null; lastReason: string | null; invalidChecks: number }
}

/** Read the recorded events of the single run folder under a flow-log directory. */
function readStream(logDir: string): StreamEvent[] {
  const folders = readdirSync(logDir)
  expect(folders).toHaveLength(1)
  return readFileSync(join(logDir, folders[0] as string, 'lcrd-flow.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as StreamEvent)
}

describe('run metadata and decision context', () => {
  const agent = { id: 'session-run', session: { header: { cwd: 'D:/work' } }, options: { model: 'm-1', provider: 'p-1' } } as never
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lcrd-run-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  it('writes the run metadata with the configuration, model, versions, and cwd', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, {
      outDir: dir,
      config: { maxRetries: 3, learningEnabled: false },
      protocolVersion: 7,
      pluginVersion: '9.9.9',
    })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.dump()
    const run = JSON.parse(readFileSync(join(dir, goalDir('session-run', 'g'), 'run.json'), 'utf8')) as Record<string, unknown>
    expect(run).toMatchObject({
      schema_version: 4,
      plugin_version: '9.9.9',
      protocol_version: 7,
      session_id: 'session-run',
      task_id: 'g',
      config: { maxRetries: 3, learningEnabled: false },
      model: 'm-1',
      provider: 'p-1',
      platform: process.platform,
      cwd: 'D:/work',
      final_verdict: 'fail',
      termination: 'incomplete',
      anchor_digest: null,
    })
    expect(String(run['started_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(String(run['ended_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // The meta carries the same runtime identity as the run file.
    const json = JSON.parse(readFileSync(join(dir, goalDir('session-run', 'g'), 'lcrd-flow.json'), 'utf8')) as Record<string, unknown>
    expect(json).toMatchObject({ plugin_version: '9.9.9', protocol_version: 7, model: 'm-1', provider: 'p-1', platform: process.platform })
  })

  it('defaults the plugin version to the package manifest and the protocol version to zero', () => {
    // No output directory and no events: the recorder only reads its defaults here.
    const bare = new FlowRecorder(agent, 3)
    expect(bare.computeRunMeta()).toMatchObject({ plugin_version: pluginVersion(), protocol_version: 0, config: undefined })
  })

  it('reports termination by the protocol, by a passing verdict, and as incomplete', () => {
    const stub = (): never => ({ id: 'session-term', session: { header: {} }, options: {} }) as never
    const terminated = new FlowRecorder(stub(), 3, { outDir: tempDir() })
    terminated.push({ type: 'intercept', kind: 'terminated', detail: 'd' })
    expect(terminated.computeRunMeta().termination).toBe('terminated')
    const completed = new FlowRecorder(stub(), 3, { outDir: tempDir() })
    completed.push({ type: 'verdict', pass: true, reason: 'ok' })
    expect(completed.computeRunMeta().termination).toBe('completed')
    expect(new FlowRecorder(stub(), 3, { outDir: tempDir() }).computeRunMeta().termination).toBe('incomplete')
  })

  it('marks a declaration that repeats the previous one', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    const plan = { type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' } as const
    recorder.push(plan)
    recorder.push(plan)
    const events = readStream(dir)
    expect(events[0]).toMatchObject({ type: 'plan', repeatPlan: false })
    expect(events[1]).toMatchObject({ type: 'plan', repeatPlan: true })
    expect(recorder.computeMeta().repeat_plan_count).toBe(1)
  })

  it('streams the verdict referent, its exception kind, and a failed call error detail', () => {
    const dir = tempDir()
    const recorder = new FlowRecorder(agent, 3, { outDir: dir })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert' })
    recorder.push({
      type: 'tool',
      name: 'read',
      callId: 'call-9',
      argsSummary: '{"path":"a"}',
      resultKind: 'error',
      resultSummary: 'boom',
      errorMessage: 'no sandbox',
      errorCode: 'SANDBOX_UNAVAILABLE',
    })
    recorder.push({
      type: 'verdict',
      pass: false,
      reason: 'nope',
      count: 1,
      verifierKind: 'assert',
      callId: 'call-9',
      tool: 'read',
      exceptionKind: 'unspawnable',
    })
    const events = readStream(dir)
    expect(events[1]).toMatchObject({
      type: 'tool',
      callId: 'call-9',
      resultKind: 'error',
      errorMessage: 'no sandbox',
      errorCode: 'SANDBOX_UNAVAILABLE',
    })
    expect(events[2]).toMatchObject({ type: 'verdict', callId: 'call-9', tool: 'read', verifierKind: 'assert', exceptionKind: 'unspawnable' })
  })
})
