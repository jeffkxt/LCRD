/**
 * Policy-store invariants: pointer integrity, skill digests, gate reports,
 * quarantine, holdout draws, and recorded run lineage.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as companion from '../src/invariant.ts'
import { validatePolicyStore } from '../src/invariant.ts'
import { ensureStore, promote, setGateOutcome, stageVersion, storePaths } from '../src/evolve/store.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A policy root with a promoted v0002 that carries a passing gate report. */
async function goodStore(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'lcrd-invariant-'))
  dirs.push(root)
  const paths = storePaths(join(root, 'policy'))
  await ensureStore(paths)
  const manifest = await stageVersion(paths, {
    parent: 'v0001',
    authorSession: 's',
    rationale: 'r',
    benchmarkDigest: 'd',
    skills: [{ name: 'skill-a', description: 'd', content: '# body\n' }],
  })
  const gateId = 'gate-1'
  await setGateOutcome(paths, manifest.version, gateId, 'd', 'gated-passed')
  mkdirSync(join(paths.versions, manifest.version, 'gate', gateId), { recursive: true })
  writeFileSync(
    join(paths.versions, manifest.version, 'gate', gateId, 'report.json'),
    JSON.stringify({ pass: true, benchmarkDigest: 'd' }),
  )
  await promote(paths, manifest.version, 1, 's', gateId)
  return paths.root
}

/** Collect the first failure message, or null. */
function failure(paths: ReturnType<typeof storePaths>, runsRoot?: string): string | null {
  let message: string | null = null
  const fail = (value: string): never => {
    message = value
    throw new InvariantError('@deepseek-ai/dsh-experimental-lcrd', value)
  }
  try {
    validatePolicyStore(paths.root, fail, runsRoot)
  } catch { /* the reported message is the assertion target */ }
  return message
}

describe('policy store invariants', () => {
  it('accepts a consistent store', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    expect(failure(paths)).toBeNull()
    expect(failure(storePaths(join(root, 'empty')))).toBeNull()
  })

  it('rejects an archive row naming an unknown version or parent', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(join(paths.root, 'archive.jsonl'), `${JSON.stringify({ version: 'v0099', parent: null })}\n`, 'utf8')
    expect(failure(paths)).toContain('unknown version')
    writeFileSync(join(paths.root, 'archive.jsonl'), `${JSON.stringify({ version: 'v0002', parent: 'v0098' })}\n`, 'utf8')
    expect(failure(paths)).toContain('unknown parent')
    // A torn append is skipped rather than reported as a broken archive.
    writeFileSync(join(paths.root, 'archive.jsonl'), `${JSON.stringify({ version: 'v0002', parent: 'v0001' })}\n{"version":\n`, 'utf8')
    expect(failure(paths)).toBeNull()
  })

  it('rejects a current pointer without a manifest', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    const pointer = JSON.parse(readFileSync(paths.current, 'utf8')) as { version: string }
    rmSync(join(paths.versions, pointer.version), { recursive: true, force: true })
    expect(failure(paths)).toContain('has no manifest')
  })

  it('rejects a skill whose digest no longer matches', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(join(paths.versions, 'v0002', 'skills', 'skill-a.md'), 'tampered\n')
    expect(failure(paths)).toContain('does not match its manifest digest')
  })

  it('rejects a current skill file that disappeared', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    rmSync(join(paths.versions, 'v0002', 'skills', 'skill-a.md'))
    expect(failure(paths)).toContain('is missing skill file skill-a')
  })

  it('ignores stray files and version directories without manifests', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(join(paths.versions, 'notes.txt'), 'stray')
    mkdirSync(join(paths.versions, 'v0003'))
    expect(failure(paths)).toBeNull()
  })

  it('reports registered policy skills that are missing from the registry', async () => {
    const root = await goodStore()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    ctx.provide('skills', {
      snapshot: async () => ({ skills: [{ name: 'other-skill' }] }),
    } as never)
    await expect(companion.apply(ctx, { policyDir: root })).rejects.toThrow('skill-a is not registered')
  })

  it('accepts unique draws, root-level runs, and fully registered skills', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(paths.holdoutHistory, JSON.stringify({ selections: [{ gateId: 'g', ts: 't', ids: ['a', 'b'] }] }))
    const runs = join(root, 'runs')
    mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'run.json'), JSON.stringify({ policy_version: 'v0002' }))
    writeFileSync(join(runs, 'notes.txt'), 'unrelated')
    const deep = join(runs, 'a', 'b', 'c', 'd', 'e')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'run.json'), JSON.stringify({ policy_version: 'v9999' }))
    expect(failure(paths, runs)).toBeNull()

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    ctx.provide('skills', { snapshot: async () => ({ skills: [{ name: 'skill-a' }] }) } as never)
    const dispose = await companion.apply(ctx, { policyDir: root })
    dispose()

    const empty = join(root, 'empty-policy')
    mkdirSync(empty)
    const emptyCtx = new Context()
    contexts.push(emptyCtx)
    await emptyCtx.plugin(InvariantRegistry)
    emptyCtx.provide('skills', { snapshot: async () => ({ skills: [] }) } as never)
    const emptyDispose = await companion.apply(emptyCtx, { policyDir: empty })
    emptyDispose()
  })

  it('rejects a promoted version without its passing gate report', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    rmSync(join(paths.versions, 'v0002', 'gate', 'gate-1'), { recursive: true, force: true })
    expect(failure(paths)).toContain('has no gate report')
    mkdirSync(join(paths.versions, 'v0002', 'gate', 'gate-1'), { recursive: true })
    writeFileSync(join(paths.versions, 'v0002', 'gate', 'gate-1', 'report.json'), JSON.stringify({ pass: 'yes' }))
    expect(failure(paths)).toContain('did not pass its gate')
    writeFileSync(join(paths.versions, 'v0002', 'gate', 'gate-1', 'report.json'), JSON.stringify({ pass: true, benchmarkDigest: 'x' }))
    expect(failure(paths)).toContain('gate report digest does not match')
  })

  it('rejects a quarantined current version', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(paths.quarantine, JSON.stringify([{ version: 'v0002', ts: 't', reason: 'bad', metrics: null, metricsBaseline: null }]))
    expect(failure(paths)).toContain('quarantined version v0002 is current')
  })

  it('rejects a repeated holdout task and an unknown recorded run version', async () => {
    const root = await goodStore()
    const paths = storePaths(root)
    writeFileSync(paths.holdoutHistory, JSON.stringify({ selections: [{ gateId: 'g', ts: 't', ids: ['a', 'a'] }] }))
    expect(failure(paths)).toContain('repeats a task id')
    writeFileSync(paths.holdoutHistory, JSON.stringify({ selections: [] }))
    const runs = join(root, 'runs')
    mkdirSync(join(runs, 'task', 'nested'), { recursive: true })
    writeFileSync(join(runs, 'task', 'nested', 'run.json'), JSON.stringify({ policy_version: 'v9999' }))
    expect(failure(paths, runs)).toContain('records unknown policy version v9999')
    writeFileSync(join(runs, 'task', 'nested', 'run.json'), JSON.stringify({ policy_version: 'v0002' }))
    expect(failure(paths, runs)).toBeNull()
  })

  it('registers the companion and defaults to the convention policy root', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(InvariantRegistry)
    const root = await goodStore()
    const dispose = await companion.apply(ctx, { policyDir: root, flowDir: join(root, 'runs') })
    expect(dispose).toBeTypeOf('function')
    expect(companion.name).toBe('lcrd-policy-invariant')
    expect(companion.inject).toEqual(['invariants'])
    dispose()
    const defaultsCtx = new Context()
    contexts.push(defaultsCtx)
    await defaultsCtx.plugin(InvariantRegistry)
    const defaults = await companion.apply(defaultsCtx)
    expect(defaults).toBeTypeOf('function')
    defaults()
  })
})
