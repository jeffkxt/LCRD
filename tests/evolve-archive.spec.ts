/**
 * The admission archive and the parent selection that reads it: every gate
 * outcome is kept as a stepping stone, quarantine removes a version from the
 * pool, and novelty keeps one early winner from owning the search.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendArchiveEntry,
  ensureStore,
  parentWeights,
  promote,
  readArchive,
  readPointer,
  rollback,
  selectParent,
  setGateOutcome,
  stageVersion,
  storePaths,
} from '../src/evolve/store.ts'
import type { ArchiveEntry } from '../src/evolve/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A policy root with the bootstrap version and an empty archive. */
async function newStore(): Promise<ReturnType<typeof storePaths>> {
  const root = mkdtempSync(join(tmpdir(), 'lcrd-archive-'))
  dirs.push(root)
  const paths = storePaths(join(root, 'policy'))
  await ensureStore(paths)
  return paths
}

/** One archive row with explicit overrides. */
const row = (overrides: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  schemaVersion: 1,
  version: 'v0002',
  parent: 'v0001',
  gateId: 'gate-1',
  admitted: true,
  score: 1,
  gain: 0.5,
  reasons: ['ok'],
  ts: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('archive ledger', () => {
  it('reads an absent archive as empty and keeps append order', async () => {
    const paths = await newStore()
    expect(await readArchive(paths)).toEqual([])
    await appendArchiveEntry(paths, row())
    await appendArchiveEntry(paths, row({ version: 'v0003', parent: 'v0002', admitted: false, gain: null, reasons: ['no gain'] }))
    const rows = await readArchive(paths)
    expect(rows.map(entry => entry.version)).toEqual(['v0002', 'v0003'])
    expect(rows[1]).toMatchObject({ admitted: false, gain: null, reasons: ['no gain'] })
  })

  it('skips a torn line instead of hiding its neighbours', async () => {
    const paths = await newStore()
    await appendArchiveEntry(paths, row())
    appendFileSync(paths.archive, '{"version":\n', 'utf8')
    await appendArchiveEntry(paths, row({ version: 'v0004' }))
    expect((await readArchive(paths)).map(entry => entry.version)).toEqual(['v0002', 'v0004'])
  })
})

describe('parentWeights', () => {
  it('treats a missing gain as zero and counts a repeated parent once per child', () => {
    const weights = parentWeights([
      row({ version: 'v0002', parent: 'v0001', gain: null }),
      row({ version: 'v0003', parent: 'v0002', gain: null }),
    ], [])
    // v0002 has one child and no recorded gain: (1 + 0) / (1 + 1).
    expect(weights).toEqual([
      { version: 'v0002', weight: 0.5 },
      { version: 'v0003', weight: 1 },
    ])
  })

  it('weights admitted versions by gain and novelty and zeroes the rest', () => {
    const entries = [
      row({ version: 'v0001', parent: null, gain: 0 }),
      row({ version: 'v0002', parent: 'v0001', gain: 0.5 }),
      row({ version: 'v0003', parent: 'v0001', gain: 0.1 }),
      row({ version: 'v0003', parent: 'v0001', gain: 0.1 }),
      row({ version: 'v0004', parent: 'v0002', gain: 0.2 }),
      row({ version: 'v0005', parent: 'v0001', admitted: false, gain: null }),
      row({ version: 'v0006', parent: 'v0001', gain: 0.3 }),
    ]
    const byVersion = new Map(parentWeights(entries, ['v0006']).map(candidate => [candidate.version, candidate.weight]))
    // v0001 is the bootstrap and carries five children, so novelty divides its gain by six.
    expect(byVersion.get('v0001')).toBeCloseTo(1 / 6)
    // v0002 carries one child (v0004), so novelty halves its weight.
    expect(byVersion.get('v0002')).toBeCloseTo(0.75)
    // A repeated admitted row keeps the stronger weight rather than doubling it.
    expect(byVersion.get('v0003')).toBeCloseTo(1.1)
    expect(byVersion.get('v0004')).toBeCloseTo(1.2)
    // A refused version and a quarantined one are records, never parents.
    expect(byVersion.has('v0005')).toBe(false)
    expect(byVersion.has('v0006')).toBe(false)
  })
})

describe('promotion from an archived parent', () => {
  /** Stage one version on top of a parent, mark it gate-passed, and return it. */
  async function staged(paths: ReturnType<typeof storePaths>, parent: string, rationale: string): Promise<string> {
    const manifest = await stageVersion(paths, {
      parent,
      authorSession: 's',
      rationale,
      benchmarkDigest: 'd',
      skills: [{ name: `skill-${rationale}`, description: 'd', content: '# body\n' }],
    })
    await setGateOutcome(paths, manifest.version, `gate-${rationale}`, 'd', 'gated-passed')
    return manifest.version
  }

  it('promotes a version whose parent is an archived version, not the active one', async () => {
    const paths = await newStore()
    const second = await staged(paths, 'v0001', 'a')
    await promote(paths, second, 1, 'operator', null)
    const third = await staged(paths, second, 'b')
    await promote(paths, third, 2, 'operator', null)
    // v0001 is the bootstrap the archive descends from, while v0003 is active.
    const fromBootstrap = await staged(paths, 'v0001', 'c')
    await promote(paths, fromBootstrap, 3, 'operator', null)
    expect((await readPointer(paths)).version).toBe(fromBootstrap)
  })

  it('refuses a parent the monitor reverted', async () => {
    const paths = await newStore()
    const second = await staged(paths, 'v0001', 'a')
    await promote(paths, second, 1, 'operator', null)
    await rollback(paths, 'regressed', null, null)
    await expect(staged(paths, second, 'b')).rejects.toThrow('is quarantined')
  })
})

describe('selectParent', () => {
  it('returns null while nothing was admitted', async () => {
    const paths = await newStore()
    expect(await selectParent(paths)).toBeNull()
    await appendArchiveEntry(paths, row({ admitted: false, gain: null }))
    expect(await selectParent(paths)).toBeNull()
  })

  it('samples by weight and offers the other candidates', async () => {
    const paths = await newStore()
    await appendArchiveEntry(paths, row({ version: 'v0002', gain: 0.5 }))
    await appendArchiveEntry(paths, row({ version: 'v0003', parent: 'v0001', gain: 0.1 }))
    await appendArchiveEntry(paths, row({ version: 'v0004', parent: 'v0001', gain: 0.2 }))
    const lowest = await selectParent(paths, () => 0)
    expect(lowest?.version).toBe('v0002')
    expect(lowest?.alternatives).toEqual(['v0004', 'v0003'])
    const highest = await selectParent(paths, () => 0.999)
    expect(highest?.version).toBe('v0003')
  })

  it('never samples a quarantined version', async () => {
    const paths = await newStore()
    await appendArchiveEntry(paths, row({ version: 'v0002', gain: 0.9 }))
    await appendArchiveEntry(paths, row({ version: 'v0003', parent: 'v0001', gain: 0.1 }))
    writeFileSync(
      paths.quarantine,
      JSON.stringify([{ version: 'v0002', ts: 't', reason: 'r', metrics: null, metricsBaseline: null }]),
      'utf8',
    )
    expect((await selectParent(paths, () => 0))?.version).toBe('v0003')
  })
})
