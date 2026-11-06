/**
 * Dataset conversion coverage: the failure taxonomy, the per-run row
 * construction, the DPO pair builder, and the append path.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DATASET_FILES,
  FlowRecorder,
  appendDatasetRows,
  classifyFailure,
  classifyRelaxationCause,
  classifyTrainability,
  datasetRowsForRun,
  defaultAttribution,
  dpoPairsForRun,
  ensureDatasetFiles,
  expressionsOf,
  isAttribution,
  loadAttribution,
  renderTranscriptEntry,
  withExpressions,
  withHoldRateReview,
  type DatasetRow,
  type TranscriptEntry,
} from '@deepseek-ai/dsh-experimental-lcrd'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-dataset-unit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const CN = (...codes: number[]): string => String.fromCharCode(...codes)
const agent = { id: 'session-ds', session: { header: {} }, options: {} } as never

/** A recorder holding one run: a failing declaration, a relaxation, and a pass. */
function recorderWithRun(): FlowRecorder {
  const recorder = new FlowRecorder(agent, 3, { outDir: tempDir(), protocolVersion: 1 })
  recorder.push({
    type: 'plan',
    goal: 'g1',
    stop: 's1',
    feasibility: true,
    verifier: 'assert',
    verifierSpec: { kind: 'assert', conditions: ['result !== undefined && result.length > 100'] },
    context: { failures: 0, phase: 'normal', lastReason: null, lastPass: null, lastVerifierKind: null, invalidChecks: 0 },
    callId: 'call-1',
  })
  recorder.push({ type: 'tool', name: 'read', callId: 'call-2', resultKind: 'string', resultSummary: '"ok"', errorCode: 'X' })
  recorder.push({ type: 'verdict', pass: false, reason: 'data mismatch', count: 1, verifierKind: 'assert', callId: 'call-2', tool: 'read', exceptionKind: 'eval-error' })
  recorder.push({
    type: 'plan',
    goal: 'g2',
    stop: 's2',
    feasibility: true,
    verifier: 'assert',
    verifierSpec: { kind: 'assert', conditions: ['result !== undefined'] },
    callId: 'call-3',
  })
  recorder.push({ type: 'learn', analysis: 'a', knowledge: 'k', method: 'read', criteria: 'c' })
  recorder.push({ type: 'learn-verify', learned: false, evidence: 'e', count: 1 })
  recorder.push({ type: 'intercept', kind: 'terminated', detail: 'd' })
  recorder.push({ type: 'verdict', pass: true, reason: 'ok', verifierKind: 'python' })
  return recorder
}

describe('classifyFailure', () => {
  it('attributes every known class', () => {
    expect(classifyFailure(CN(0x7f3a, 0x5c11, 0x533a, 0x5206, 0x5ea6))).toBe('assertion-invalid')
    expect(classifyFailure(CN(0x5de5, 0x5177, 0x6267, 0x884c, 0x5931, 0x8d25))).toBe('tool-isError')
    expect(classifyFailure(CN(0x8d85, 0x65f6))).toBe('python-timeout')
    expect(classifyFailure(`${CN(0x672a, 0x8fd4, 0x56de)} JSON`)).toBe('llm-bad-output')
    expect(classifyFailure(CN(0x65ad, 0x8a00, 0x4e0d, 0x6210, 0x7acb))).toBe('honest-mismatch')
    expect(classifyFailure('(result 类型: str)')).toBe('honest-mismatch')
    expect(classifyFailure('EPERM: operation not permitted')).toBe('infra-error')
    expect(classifyFailure('something else')).toBe('unclassified')
    expect(classifyFailure('x', 'exit-code')).toBe('exit-code')
    expect(classifyFailure("'VALID=True' in result", undefined, 'python')).toBe('python-check-failed')
    expect(classifyFailure('停止条件未满足', undefined, 'llm')).toBe('llm-stop-unmet')
    expect(classifyFailure('LLM 校验器判定 FAIL')).toBe('llm-stop-unmet')
    expect(classifyFailure('stop condition not met')).toBe('llm-stop-unmet')
  })

  it('lets a structured exception kind decide', () => {
    expect(classifyFailure('x', 'unspawnable')).toBe('infra-error')
    expect(classifyFailure('x', 'no-provider')).toBe('infra-error')
    expect(classifyFailure('x', 'timeout')).toBe('python-timeout')
    expect(classifyFailure('x', 'exit-code')).toBe('exit-code')
    expect(classifyFailure('x', 'bad-output')).toBe('llm-bad-output')
    expect(classifyFailure('x', 'invalid-condition')).toBe('assertion-invalid')
  })

  it('keeps an open-set fallback when no rule matches', () => {
    expect(classifyFailure('unrelated free text', undefined, 'assert')).toBe('unclassified')
  })
})

describe('classifyRelaxationCause', () => {
  it('separates a form adaptation from a dropped substance', () => {
    expect(classifyRelaxationCause('assertion-invalid', 'eval-error', ['lost-structural'])).toBe('type-adaptation')
    expect(classifyRelaxationCause('honest-mismatch', null, ['presence-only'])).toBe('substance-dropped')
    expect(classifyRelaxationCause('llm-stop-unmet', null, ['weaker-constraint'])).toBe('substance-dropped')
    expect(classifyRelaxationCause('python-check-failed', null, ['fewer-expressions'])).toBe('substance-dropped')
    expect(classifyRelaxationCause('honest-mismatch', null, ['verifier-kind'])).toBe('undetermined')
    expect(classifyRelaxationCause('exit-code', null, ['presence-only'])).toBe('undetermined')
  })
})

describe('classifyTrainability', () => {
  const verdict = (over: Partial<DatasetRow>): DatasetRow =>
    ({ type: 'verdict', pass: false, step: 1, ts: null, ...over }) as DatasetRow

  it('keeps every context row trainable', () => {
    expect(classifyTrainability({ type: 'plan', step: 1, ts: null } as DatasetRow)).toBe('trainable')
    expect(classifyTrainability({ type: 'tool', step: 1, ts: null } as DatasetRow)).toBe('trainable')
    expect(classifyTrainability({ type: 'learn', step: 1, ts: null } as DatasetRow)).toBe('trainable')
    expect(classifyTrainability({ type: 'intercept', step: 1, ts: null } as DatasetRow)).toBe('trainable')
  })

  it('labels a passing verdict trainable unless its governing check was presence-only', () => {
    expect(classifyTrainability(verdict({ pass: true }))).toBe('trainable')
    expect(classifyTrainability(verdict({ pass: true, strictness: { presenceOnly: false } as never }))).toBe('trainable')
    expect(classifyTrainability(verdict({ pass: true, strictness: { presenceOnly: true } as never }))).toBe('needs-review')
  })

  it('labels an engine-decided check failure trainable', () => {
    expect(classifyTrainability(verdict({ failureClass: 'assertion-invalid' }))).toBe('trainable')
  })

  it('labels ambiguous failures for review', () => {
    expect(classifyTrainability(verdict({ failureClass: 'honest-mismatch' }))).toBe('needs-review')
    expect(classifyTrainability(verdict({ failureClass: 'llm-stop-unmet' }))).toBe('needs-review')
    expect(classifyTrainability(verdict({ failureClass: 'python-check-failed' }))).toBe('needs-review')
    expect(classifyTrainability(verdict({ failureClass: 'tool-isError' }))).toBe('needs-review')
    expect(classifyTrainability(verdict({ failureClass: 'unclassified' }))).toBe('needs-review')
    expect(classifyTrainability(verdict({ failureClass: undefined }))).toBe('needs-review')
  })

  it('discards environment and verifier-infra failures', () => {
    expect(classifyTrainability(verdict({ failureClass: 'infra-error' }))).toBe('discard')
    expect(classifyTrainability(verdict({ failureClass: 'python-timeout' }))).toBe('discard')
    expect(classifyTrainability(verdict({ failureClass: 'exit-code' }))).toBe('discard')
    expect(classifyTrainability(verdict({ failureClass: 'llm-bad-output' }))).toBe('discard')
  })
})

describe('withHoldRateReview', () => {
  const verdict = (over: Partial<DatasetRow>): DatasetRow =>
    ({ type: 'verdict', pass: false, step: 1, ts: null, ...over }) as DatasetRow

  it('delegates the other attribution decisions to the base bundle', () => {
    const wrapped = withHoldRateReview(defaultAttribution, 0.9)
    expect(wrapped.classifyFailure('断言失败')).toBe(defaultAttribution.classifyFailure('断言失败'))
    expect(wrapped.classifyRelaxationCause('honest-mismatch', null, ['weaker-constraint']))
      .toBe(defaultAttribution.classifyRelaxationCause('honest-mismatch', null, ['weaker-constraint']))
  })

  it('returns the base bundle unchanged without a ceiling', () => {
    expect(withHoldRateReview(defaultAttribution, undefined)).toBe(defaultAttribution)
  })

  it('downgrades a passing high-hold-rate verdict to needs-review', () => {
    const wrapped = withHoldRateReview(defaultAttribution, 0.9)
    expect(wrapped.classifyTrainability(verdict({
      pass: true,
      strictness: { presenceOnly: false, maxHoldRate: 0.95 } as never,
    }))).toBe('needs-review')
    expect(wrapped.classifyTrainability(verdict({
      pass: true,
      strictness: { presenceOnly: false, maxHoldRate: 0.9 } as never,
    }))).toBe('needs-review')
  })

  it('keeps the base label when the rate, pass flag, or row type does not qualify', () => {
    const wrapped = withHoldRateReview(defaultAttribution, 0.9)
    expect(wrapped.classifyTrainability(verdict({
      pass: true,
      strictness: { presenceOnly: false, maxHoldRate: 0.5 } as never,
    }))).toBe('trainable')
    expect(wrapped.classifyTrainability(verdict({
      pass: true,
      strictness: { presenceOnly: false, maxHoldRate: null } as never,
    }))).toBe('trainable')
    expect(wrapped.classifyTrainability(verdict({
      pass: true,
      strictness: { presenceOnly: false, maxHoldRate: undefined } as never,
    }))).toBe('trainable')
    expect(wrapped.classifyTrainability(verdict({
      pass: false,
      failureClass: 'assertion-invalid',
      strictness: { presenceOnly: false, maxHoldRate: 0.95 } as never,
    }))).toBe('trainable')
    expect(wrapped.classifyTrainability(verdict({
      pass: false,
      failureClass: 'honest-mismatch',
      strictness: { presenceOnly: false, maxHoldRate: 0.95 } as never,
    }))).toBe('needs-review')
    expect(wrapped.classifyTrainability({ type: 'plan', step: 1, ts: null } as DatasetRow)).toBe('trainable')
  })
})

describe('the attribution hook', () => {
  it('recognizes a complete bundle and rejects a partial one', () => {
    const complete = {
      classifyFailure,
      classifyRelaxationCause,
      classifyTrainability,
    }
    expect(isAttribution(complete)).toBe(true)
    expect(isAttribution({ classifyFailure })).toBe(false)
    expect(isAttribution(null)).toBe(false)
    expect(isAttribution('nope')).toBe(false)
  })

  it('threads a custom bundle through datasetRowsForRun', () => {
    const custom = {
      classifyFailure: () => 'infra-error' as const,
      classifyRelaxationCause: () => 'undetermined' as const,
      classifyTrainability: () => 'discard' as const,
    }
    const rows = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [
        { type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['result !== undefined'] }, seq: 1, ts: 't' } as never,
        { type: 'tool', name: 'read', resultKind: 'string', resultSummary: '"ok"', seq: 2, ts: 't' } as never,
        { type: 'verdict', pass: false, reason: '不成立', seq: 3, ts: 't' } as never,
      ],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    }, custom)
    expect(rows.records[2]).toMatchObject({ failureClass: 'infra-error', trainability: 'discard' })
  })

  it('loads a bundle from a module file and rejects an invalid export', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'attribution.mjs')
    writeFileSync(modulePath, [
      'export default {',
      "  classifyFailure: () => 'tool-isError',",
      "  classifyRelaxationCause: () => 'type-adaptation',",
      "  classifyTrainability: () => 'needs-review',",
      '}',
      '',
    ].join('\n'), 'utf8')
    const loaded = await loadAttribution(modulePath)
    expect(loaded.classifyFailure('x')).toBe('tool-isError')
    const badPath = join(dir, 'bad.mjs')
    writeFileSync(badPath, 'export default { classifyFailure: () => 1 }', 'utf8')
    await expect(loadAttribution(badPath)).rejects.toThrow('must export classifyFailure')
  })

  it('loads a relative path and a bare data-URL module with named exports', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'named.mjs')
    writeFileSync(modulePath, [
      "export const classifyFailure = () => 'python-timeout'",
      "export const classifyRelaxationCause = () => 'undetermined'",
      "export const classifyTrainability = () => 'discard'",
      '',
    ].join('\n'), 'utf8')
    const fromRelative = await loadAttribution('./named.mjs', dir)
    expect(fromRelative.classifyFailure('x')).toBe('python-timeout')
    // A bare specifier (no path marker) imports as-is; named exports feed the bundle.
    const dataUrl = `data:text/javascript,${encodeURIComponent([
      "export const classifyFailure = () => 'infra-error'",
      "export const classifyRelaxationCause = () => 'type-adaptation'",
      "export const classifyTrainability = () => 'discard'",
    ].join(';'))}`
    const fromBare = await loadAttribution(dataUrl)
    expect(fromBare.classifyFailure('x')).toBe('infra-error')
    expect(fromBare.classifyTrainability({} as DatasetRow)).toBe('discard')
  })
})

describe('transcript helpers', () => {
  it('renders text, tool calls, sources, and error flags', () => {
    expect(renderTranscriptEntry({ role: 'user', text: 'hi', source: 'plugin' })).toBe('<user source=plugin>\nhi')
    expect(renderTranscriptEntry({ role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: '{}', callId: 'c' }] }))
      .toBe('<assistant>\n<tool-call name=lcrd_plan>{}</tool-call>')
    expect(renderTranscriptEntry({ role: 'tool', text: 'boom', isError: true })).toBe('<tool>\nboom\n(error result)')
  })

  it('replaces expressions for both code verifiers and refuses the rest', () => {
    expect(withExpressions('{"verifier":{"kind":"assert","conditions":["old"]}}', ['new']))
      .toBe('{"verifier":{"kind":"assert","conditions":["new"]}}')
    expect(withExpressions('{"verifier":{"kind":"python","checks":["old"]}}', ['new']))
      .toBe('{"verifier":{"kind":"python","checks":["new"]}}')
    expect(withExpressions('{"verifier":{"kind":"llm"}}', ['new'])).toBeNull()
    expect(withExpressions('{"goal":"g"}', ['new'])).toBeNull()
    expect(withExpressions('not json', ['new'])).toBeNull()
  })

  it('reads the expressions of each verifier kind', () => {
    const plan = (spec: { kind: 'assert'; conditions: string[] } | { kind: 'python'; checks: string[] } | { kind: 'llm' }): never =>
      ({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: spec.kind, verifierSpec: spec, seq: 1, ts: 't' }) as never
    expect(expressionsOf(plan({ kind: 'assert', conditions: ['a'] }))).toEqual(['a'])
    expect(expressionsOf(plan({ kind: 'python', checks: ['b'] }))).toEqual(['b'])
    expect(expressionsOf(plan({ kind: 'llm' }))).toEqual([])
    expect(expressionsOf({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', seq: 1, ts: 't' } as never)).toEqual([])
  })
})

describe('datasetRowsForRun', () => {
  it('converts one recorder run into rows, keeping every label', () => {
    const rows = recorderWithRun().datasetRows()
    expect(rows.records).toHaveLength(8)
    expect(rows.records[0]).toMatchObject({ type: 'plan', goal: 'g1', verifier: 'assert', callId: 'call-1', repeatPlan: false })
    expect(rows.records[0]?.context).toMatchObject({ failures: 0 })
    expect(rows.records[1]).toMatchObject({ type: 'tool', tool: 'read', resultKind: 'string', errorCode: 'X' })
    expect(rows.records[2]).toMatchObject({ type: 'verdict', pass: false, failureClass: 'assertion-invalid', verifierKind: 'assert', exceptionKind: 'eval-error' })
    expect(rows.records[3]).toMatchObject({ type: 'plan', goal: 'g2', relaxation: ['presence-only', 'lost-structural', 'dropped-literals', 'weaker-constraint'] })
    expect(rows.records[4]).toMatchObject({ type: 'learn', analysis: 'a', criteria: 'c' })
    expect(rows.records[5]).toMatchObject({ type: 'learn-verify', learned: false, evidence: 'e', count: 1 })
    expect(rows.records[6]).toMatchObject({ type: 'intercept', intercept: 'terminated', detail: 'd' })
    expect(rows.records[7]).toMatchObject({ type: 'verdict', pass: true, verifierKind: 'python', trainability: 'needs-review' })
    expect(rows.relaxations).toHaveLength(1)
    expect(rows.relaxations[0]).toMatchObject({
      step: 4,
      afterFailure: 1,
      failureClass: 'assertion-invalid',
      failureExceptionKind: 'eval-error',
      precedingResultKind: 'string',
      cause: 'type-adaptation',
      previousExpressions: ['result !== undefined && result.length > 100'],
      expressions: ['result !== undefined'],
    })
    expect(rows.run).toMatchObject({ has_run_meta: true, task_group: 'g1', interaction: 'manual' })
  })

  it('builds rows without a recorder, for an empty run', () => {
    const rows = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    })
    expect(rows.records).toEqual([])
    expect(rows.relaxations).toEqual([])
  })

  it('tolerates declarations without a strictness reading or a verifier kind', () => {
    const plan = (conditions: string[], extra: Record<string, unknown>): never => ({
      type: 'plan',
      goal: 'g',
      stop: 's',
      feasibility: true,
      verifier: 'assert',
      verifierSpec: { kind: 'assert', conditions },
      seq: 1,
      ts: 't',
      ...extra,
    }) as never
    const rows = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [
        plan(['a'], {}),
        plan(['b'], { seq: 2, ts: 't2', relaxation: ['presence-only'], strictness: undefined }),
        { type: 'tool', name: 'read', seq: 3, ts: 't3' } as never,
        { type: 'verdict', pass: false, reason: 'nope', seq: 4, ts: 't4' } as never,
      ],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    })
    expect(rows.records[2]).toMatchObject({ type: 'tool', resultKind: undefined })
    expect(rows.records[3]).toMatchObject({ type: 'verdict', count: undefined, verifierKind: 'assert', failureClass: 'unclassified' })
    expect(rows.relaxations[0]).toMatchObject({ fromKind: null, previousExpressions: ['a'], expressions: ['b'] })
  })

  it('skips a relaxation whose previous declaration carried no expressions', () => {
    const rows = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [
        { type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'llm', verifierSpec: { kind: 'llm' }, seq: 1, ts: 't' } as never,
        { type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['x'] }, relaxation: ['verifier-kind'], seq: 2, ts: 't' } as never,
      ],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    })
    expect(rows.relaxations[0]?.previousExpressions).toEqual([])
    expect(dpoPairsForRun({ rows, transcript: [], planIndexByStep: new Map(), runId: 'r' })).toEqual([])
  })
})

describe('dpoPairsForRun', () => {
  const transcript: TranscriptEntry[] = [
    { role: 'user', text: 'do it' },
    { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: '{"verifier":{"kind":"assert","conditions":["tight"]}}', callId: 'c1' }] },
    { role: 'tool', text: 'boom' },
    { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: '{"verifier":{"kind":"assert","conditions":["loose"]}}', callId: 'c2' }] },
  ]

  it('pairs the relaxed declaration against the restored check', () => {
    const rows = recorderWithRun().datasetRows()
    const pairs = dpoPairsForRun({ rows, transcript, planIndexByStep: new Map([[4, 3]]), runId: 'session-ds' })
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.chosen).toContain('result !== undefined && result.length > 100')
    expect(pairs[0]?.rejected).toContain('"conditions":["loose"]')
    expect(pairs[0]?.prompt).toBe('<user>\ndo it\n<assistant>\n<tool-call name=lcrd_plan>{"verifier":{"kind":"assert","conditions":["tight"]}}</tool-call>\n<tool>\nboom')
    expect(pairs[0]?.meta).toMatchObject({ run_id: 'session-ds', step: 4, synthetic: true, repeat_declaration: false })
  })

  it('skips declarations the transcript cannot resolve', () => {
    const rows = recorderWithRun().datasetRows()
    expect(dpoPairsForRun({ rows, transcript, planIndexByStep: new Map(), runId: 'r' })).toEqual([])
    expect(dpoPairsForRun({ rows, transcript, planIndexByStep: new Map([[4, 0]]), runId: 'r' })).toEqual([])
    const llmTranscript: TranscriptEntry[] = [
      { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: '{"verifier":{"kind":"llm"}}', callId: 'c3' }] },
    ]
    expect(dpoPairsForRun({ rows, transcript: llmTranscript, planIndexByStep: new Map([[4, 0]]), runId: 'r' })).toEqual([])
  })

  it('skips a run without a relaxation at all', () => {
    const recorder = new FlowRecorder(agent, 3, { outDir: tempDir() })
    recorder.push({ type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['only'] } })
    const rows = recorder.datasetRows()
    expect(rows.relaxations).toEqual([])
    expect(dpoPairsForRun({ rows, transcript, planIndexByStep: new Map([[1, 3]]), runId: 'r' })).toEqual([])
  })
})

describe('appendDatasetRows', () => {
  it('appends the run rows to the four files, twice without overwriting', () => {
    const dir = tempDir()
    const rows = recorderWithRun().datasetRows()
    appendDatasetRows(dir, rows, [])
    appendDatasetRows(dir, rows, [])
    ensureDatasetFiles(dir)
    const read = (file: string): unknown[] =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(read(DATASET_FILES.dataset)).toHaveLength(16)
    expect(read(DATASET_FILES.relaxations)).toHaveLength(2)
    expect(read(DATASET_FILES.runs)).toHaveLength(2)
    expect(read(DATASET_FILES.dpo)).toEqual([])
  })

  it('writes DPO pairs when the run produced a relaxation', () => {
    const dir = tempDir()
    const rows = recorderWithRun().datasetRows()
    const transcript: TranscriptEntry[] = [
      { role: 'assistant', text: '', toolCalls: [{ name: 'lcrd_plan', arguments: '{"verifier":{"kind":"assert","conditions":["loose"]}}', callId: 'c' }] },
    ]
    const pairs = dpoPairsForRun({ rows, transcript, planIndexByStep: new Map([[4, 0]]), runId: 'r' })
    appendDatasetRows(dir, rows, pairs)
    const lines = readFileSync(join(dir, DATASET_FILES.dpo), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ meta: { run_id: 'r', step: 4 } })
  })

  it('splits rows into trainable and needs-review files by trainability', () => {
    const dir = tempDir()
    const rows = recorderWithRun().datasetRows()
    const honest = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [
        { type: 'plan', goal: 'g', stop: 's', feasibility: true, verifier: 'assert', verifierSpec: { kind: 'assert', conditions: ['result !== undefined'] }, seq: 1, ts: 't' } as never,
        { type: 'verdict', pass: false, reason: '断言不成立', seq: 2, ts: 't', exceptionKind: undefined } as never,
        { type: 'verdict', pass: false, reason: 'EPERM: not permitted', seq: 3, ts: 't', exceptionKind: 'unspawnable' } as never,
      ],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    })
    appendDatasetRows(dir, { records: [...rows.records, ...honest.records], relaxations: rows.relaxations, run: rows.run }, [])
    const read = (file: string): unknown[] =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    const allTrainable = read(DATASET_FILES.trainable).every(row =>
      (row as DatasetRow).trainability === 'trainable')
    const allNeeds = read(DATASET_FILES.needsReview).every(row =>
      (row as DatasetRow).trainability === 'needs-review')
    expect(allTrainable).toBe(true)
    expect(allNeeds).toBe(true)
    expect(read(DATASET_FILES.trainable)).toContainEqual(
      expect.objectContaining({ failureClass: 'assertion-invalid' }),
    )
    expect(read(DATASET_FILES.needsReview)).toContainEqual(
      expect.objectContaining({ failureClass: 'honest-mismatch' }),
    )
    const allRows = [...read(DATASET_FILES.trainable), ...read(DATASET_FILES.needsReview)]
    expect(allRows).not.toContainEqual(expect.objectContaining({ failureClass: 'infra-error' }))
  })

  it('skips the trainable file when a run has no trainable rows', () => {
    const dir = tempDir()
    const reviewOnly = datasetRowsForRun({
      runId: 'r',
      sessionId: 's',
      taskId: 't',
      taskGroup: 't',
      events: [
        { type: 'verdict', pass: false, reason: '断言不成立', seq: 1, ts: 't', exceptionKind: undefined } as never,
        { type: 'verdict', pass: false, reason: '工具执行失败', seq: 2, ts: 't', exceptionKind: undefined } as never,
      ],
      meta: { session_id: 's', task_id: 't' } as never,
      run: { session_id: 's', task_id: 't' } as never,
    })
    appendDatasetRows(dir, { records: reviewOnly.records, relaxations: [], run: reviewOnly.run }, [])
    ensureDatasetFiles(dir)
    const read = (file: string): unknown[] =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(read(DATASET_FILES.trainable)).toEqual([])
    expect(read(DATASET_FILES.needsReview)).toHaveLength(2)
  })

  it('splits an unstamped row through the default bundle', () => {
    const dir = tempDir()
    const unstamped = { type: 'verdict', pass: false, reason: '不成立', step: 1, ts: null } as DatasetRow
    appendDatasetRows(dir, {
      records: [unstamped],
      relaxations: [],
      run: { run_id: 'r', task_group: 't', session_id: 's' } as never,
    }, [])
    ensureDatasetFiles(dir)
    const read = (file: string): unknown[] =>
      readFileSync(join(dir, file), 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    // The default bundle routes an honest mismatch to needs-review even without a stamp.
    expect(read(DATASET_FILES.needsReview)).toHaveLength(1)
    expect(read(DATASET_FILES.trainable)).toEqual([])
  })
})
