/**
 * Policy store: bootstrap, immutable staging, pointer CAS, promotion,
 * rollback/quarantine, score windows, and path/name rejection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendHoldoutSelection,
  appendPolicyTrace,
  appendScore,
  assertSkillName,
  assertVersionName,
  ensureStore,
  listVersions,
  loadSkills,
  normalizeGateId,
  promote,
  quarantineHints,
  readHoldoutHistory,
  readManifest,
  readPointer,
  readPolicyTrace,
  readQuarantine,
  readScore,
  rollback,
  setGateOutcome,
  setPromotionHeld,
  skillDigest,
  stageVersion,
  storePaths,
  versionPath,
} from '../src/evolve/store.ts'

const dirs: string[] = []

/** A fresh policy root. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lcrd-store-'))
  dirs.push(root)
  return join(root, 'policy')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Stage one skill version for tests. */
async function stageV2(root: string, content = '# skill\nline\n'): Promise<string> {
  const paths = storePaths(root)
  await ensureStore(paths)
  const manifest = await stageVersion(paths, {
    parent: 'v0001',
    authorSession: 's-1',
    rationale: 'test',
    benchmarkDigest: 'digest-1',
    skills: [{ name: 'better-plan', description: 'use it', content }],
  })
  return manifest.version
}

describe('policy store', () => {
  it('bootstraps v0001 and a revision-1 pointer once', async () => {
    const paths = storePaths(freshRoot())
    const first = await ensureStore(paths)
    expect(first.version).toBe('v0001')
    expect(first.revision).toBe(1)
    expect(first.history).toHaveLength(1)
    expect(await listVersions(paths)).toEqual(['v0001'])
    const manifest = await readManifest(paths, 'v0001')
    expect(manifest).toMatchObject({ parent: null, gateId: null, status: 'promoted', skills: [] })
    const second = await ensureStore(paths)
    expect(second.revision).toBe(1)
  })

  it('rejects a store whose versions exist but pointer is missing', async () => {
    const paths = storePaths(freshRoot())
    await ensureStore(paths)
    rmSync(paths.current)
    await expect(ensureStore(paths)).rejects.toThrow('is missing but versions exist')
  })

  it('rejects malformed pointers and version names', async () => {
    const paths = storePaths(freshRoot())
    await ensureStore(paths)
    writeFileSync(paths.current, JSON.stringify({ revision: 0, version: 'v0001', history: [], promotionHeld: false }))
    await expect(readPointer(paths)).rejects.toThrow('pointer revision')
    writeFileSync(paths.current, JSON.stringify({ revision: 1, version: 'v0001', history: {}, promotionHeld: false }))
    await expect(readPointer(paths)).rejects.toThrow('history must be an array')
    writeFileSync(paths.current, JSON.stringify({ revision: 1, version: 'v0001', history: [], promotionHeld: 'no' }))
    await expect(readPointer(paths)).rejects.toThrow('promotionHeld')
    expect(() => { assertVersionName('v1') }).toThrow('invalid version name')
    expect(() => { assertVersionName('../v0002') }).toThrow('invalid version name')
    expect(() => versionPath(paths, 'v0001')).not.toThrow()
    expect(() => normalizeGateId('..')).toThrow('invalid gate id')
    expect(normalizeGateId('v0002-abc')).toBe('v0002-abc')
  })

  it('stages an immutable version with skills and a manifest', async () => {
    const root = freshRoot()
    const paths = storePaths(root)
    await ensureStore(paths)
    const manifest = await stageVersion(paths, {
      parent: 'v0001',
      authorSession: 's-1',
      rationale: 'because',
      benchmarkDigest: 'd-1',
      skills: [
        { name: 'a-skill', description: 'first', content: '# one\n' },
        { name: 'b-skill', description: 'second', content: '# two\n' },
      ],
    })
    expect(manifest.version).toBe('v0002')
    expect(manifest.status).toBe('proposed')
    expect(manifest.skills.map(skill => skill.name)).toEqual(['a-skill', 'b-skill'])
    expect(manifest.skills[0]?.digest).toBe(skillDigest('# one\n'))
    expect(manifest.skills[0]?.bytes).toBe(Buffer.byteLength('# one\n'))
    expect(await loadSkills(paths, 'v0002')).toEqual([
      { name: 'a-skill', description: 'first', content: '# one\n' },
      { name: 'b-skill', description: 'second', content: '# two\n' },
    ])
  })

  it('rejects invalid or mismatched proposals', async () => {
    const paths = storePaths(freshRoot())
    await ensureStore(paths)
    const base = { parent: 'v0001', authorSession: null, rationale: 'r', benchmarkDigest: 'd' }
    await expect(stageVersion(paths, { ...base, skills: [] })).rejects.toThrow('at least one skill')
    await expect(stageVersion(paths, { ...base, skills: [{ name: 'Bad_Name', description: 'd', content: 'c' }] }))
      .rejects.toThrow('invalid skill name')
    await expect(stageVersion(paths, {
      ...base,
      skills: [
        { name: 'dup', description: 'd', content: 'c' },
        { name: 'dup', description: 'd', content: 'c' },
      ],
    })).rejects.toThrow('duplicate skill name')
    await expect(stageVersion(paths, { ...base, skills: [{ name: 'ok', description: ' ', content: 'c' }] }))
      .rejects.toThrow('empty description')
    await expect(stageVersion(paths, { ...base, skills: [{ name: 'ok', description: 'd', content: '  ' }] }))
      .rejects.toThrow('empty body')
    await expect(stageVersion(paths, { ...base, parent: 'v0009', skills: [{ name: 'ok', description: 'd', content: 'c' }] }))
      .rejects.toThrow('is not current')
  })

  it('rejects a reserved skill name', () => {
    expect(() => { assertSkillName('runtime') }).toThrow('reserved')
    expect(() => { assertSkillName('x'.repeat(65)) }).toThrow('invalid skill name')
    expect(() => { assertSkillName('good-name') }).not.toThrow()
  })

  it('promotes a gated version at the expected revision and rejects stale ones', async () => {
    const root = freshRoot()
    const version = await stageV2(root)
    const paths = storePaths(root)
    await expect(promote(paths, version, 1, 's-1', 'gate-1')).rejects.toThrow('not gated-passed')
    await setGateOutcome(paths, version, 'gate-1', 'digest-1', 'gated-passed')
    await expect(promote(paths, version, 9, 's-1', 'gate-1')).rejects.toThrow('pointer moved')
    const promoted = await promote(paths, version, 1, 's-1', 'gate-1')
    expect(promoted).toEqual({ version, revision: 2 })
    const pointer = await readPointer(paths)
    expect(pointer.version).toBe(version)
    expect(pointer.history.at(-1)).toMatchObject({ version, gateId: 'gate-1', promotedBy: 's-1' })
    expect((await readManifest(paths, version)).status).toBe('promoted')
  })

  it('holds promotions after the sealed audit', async () => {
    const root = freshRoot()
    const version = await stageV2(root)
    const paths = storePaths(root)
    await setGateOutcome(paths, version, 'gate-1', 'digest-1', 'gated-passed')
    const held = await setPromotionHeld(paths, true)
    expect(held.promotionHeld).toBe(true)
    await expect(promote(paths, version, held.revision, 's-1', 'gate-1')).rejects.toThrow('promotions are held')
  })

  it('rolls back to the parent, quarantines the version, and reports hints', async () => {
    const root = freshRoot()
    const version = await stageV2(root)
    const paths = storePaths(root)
    await setGateOutcome(paths, version, 'gate-1', 'digest-1', 'gated-passed')
    await promote(paths, version, 1, 's-1', 'gate-1')
    const reverted = await rollback(paths, 'cheat rate rose', null, null)
    expect(reverted).toMatchObject({ from: version, to: 'v0001' })
    expect((await readPointer(paths)).version).toBe('v0001')
    expect((await readManifest(paths, version)).status).toBe('quarantined')
    expect(await readQuarantine(paths)).toMatchObject([{ version, reason: 'cheat rate rose' }])
    expect(await quarantineHints(paths, 3)).toEqual([`${version}: cheat rate rose`])
    await expect(promote(paths, version, (await readPointer(paths)).revision, 's-1', 'gate-1'))
      .rejects.toThrow('is quarantined, not gated-passed')
    await expect(rollback(paths, 'again', null, null)).rejects.toThrow('has no parent')
  })

  it('refuses to roll back to a parent that is not restorable', async () => {
    const root = freshRoot()
    const version = await stageV2(root)
    const paths = storePaths(root)
    await setGateOutcome(paths, version, 'gate-1', 'digest-1', 'gated-passed')
    await promote(paths, version, 1, 's-1', 'gate-1')
    // Break the parent's status directly, as an operator mistake would.
    const parentPath = join(versionPath(paths, 'v0001'), 'manifest.json')
    const parent = JSON.parse(readFileSync(parentPath, 'utf8')) as Record<string, unknown>
    writeFileSync(parentPath, JSON.stringify({ ...parent, status: 'quarantined' }))
    await expect(rollback(paths, 'x', null, null)).rejects.toThrow('not a restorable version')
  })

  it('folds a bounded score window and records holdout rotation', async () => {
    const root = freshRoot()
    const version = await stageV2(root)
    const paths = storePaths(root)
    const sample = {
      taskId: 't1', repeat: 1, version, recorded: true, reward: null,
      termination: 'completed' as const, finalVerdict: 'pass' as const,
      relaxTypes: { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 },
      planCount: 1, tokens: 5, hookInterceptions: 0, pathViolations: 0,
    }
    expect((await readScore(paths, version)).window).toEqual([])
    await appendScore(paths, version, sample, 2)
    await appendScore(paths, version, { ...sample, taskId: 't2' }, 2)
    const score = await appendScore(paths, version, { ...sample, taskId: 't3' }, 2)
    expect(score.window.map(entry => entry.taskId)).toEqual(['t2', 't3'])
    await appendHoldoutSelection(paths, 'g1', ['t1'])
    await appendHoldoutSelection(paths, 'g2', ['t2'])
    const history = await readHoldoutHistory(paths)
    expect(history.selections.map(selection => selection.gateId)).toEqual(['g1', 'g2'])
    expect((await readHoldoutHistory(storePaths(freshRoot()))).selections).toEqual([])
  })

  it('appends and reads the policy trace', async () => {
    const paths = storePaths(freshRoot())
    await appendPolicyTrace(paths, { action: 'proposed', version: 'v0002', detail: 'first' })
    await appendPolicyTrace(paths, { action: 'audit', version: 'v0002', gateId: 'g', detail: 'second' })
    const trace = await readPolicyTrace(paths)
    expect(trace.map(entry => entry['action'])).toEqual(['proposed', 'audit'])
    expect(await readPolicyTrace(storePaths(freshRoot()))).toEqual([])
  })
})
