/**
 * Process-exit flush coverage: the one-shot headless profile exits the process
 * instead of disposing agents, so `flushOnExit` must rewrite the artifacts and
 * export the dataset rows for every recorder still held, exactly once.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FlowRecorder } from '@deepseek-ai/dsh-experimental-lcrd'
import { flushOnExit } from '../src/lifecycle.ts'
import { createState } from '../src/state.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-exit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** The rows one dataset file holds. */
const rowsOf = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)

describe('flushOnExit', () => {
  it('exports every held recorder once, and skips one without a session', () => {
    const logDir = tempDir()
    const datasetDir = join(tempDir(), 'dataset')
    const state = createState()
    const session = { header: {}, events: [] } as never
    const agent = { id: 'session-exit', session, options: {} } as never
    const recorder = new FlowRecorder(agent, 3, { outDir: logDir })
    recorder.push({
      type: 'plan',
      goal: 'g',
      stop: 's',
      feasibility: true,
      verifier: 'assert',
      verifierSpec: { kind: 'assert', conditions: ['result !== undefined'] },
      callId: 'call-1',
    })
    recorder.push({ type: 'tool', name: 'read', callId: 'call-2', resultKind: 'string' })
    recorder.push({ type: 'verdict', pass: true, reason: 'ok', verifierKind: 'assert', callId: 'call-2', tool: 'read' })
    state.allRecorders.add(recorder)
    state.recorderSessions.set(recorder, session)
    // A recorder the session map does not know about is flushed for artifacts only.
    const orphan = new FlowRecorder({ id: 'session-orphan', session, options: {} } as never, 3, { outDir: logDir })
    orphan.push({ type: 'plan', goal: 'g2', stop: 's2', feasibility: true, verifier: 'assert' })
    state.allRecorders.add(orphan)

    const deps = { state, bridge: { ensureFlow: () => recorder }, datasetExport: 'run' as const, datasetDir }
    flushOnExit(deps)
    const rows = rowsOf(join(datasetDir, 'dataset.jsonl'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ type: 'plan', callId: 'call-1' })
    expect(rows[2]).toMatchObject({ type: 'verdict', pass: true, verifierKind: 'assert' })
    // Both recorders' artifacts are on disk.
    expect(readdirSync(logDir)).toHaveLength(2)
    for (const folder of readdirSync(logDir)) {
      expect(existsSync(join(logDir, folder, 'lcrd-flow.json'))).toBe(true)
    }
    // A second exit flush must not append the same run again.
    flushOnExit(deps)
    expect(rowsOf(join(datasetDir, 'dataset.jsonl'))).toHaveLength(3)
    // With export off, exit only rewrites artifacts.
    const offDir = join(tempDir(), 'dataset-off')
    flushOnExit({ ...deps, datasetExport: 'off', datasetDir: offDir })
    expect(existsSync(offDir)).toBe(false)
  })
})
