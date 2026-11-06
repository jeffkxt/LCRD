/**
 * Policy-hook coverage: the bundle guard, the module loader, and the
 * replacement-plan shape check.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLcrdHooks, loadHooks } from '@deepseek-ai/dsh-experimental-lcrd'
import { isStepPlan } from '../src/hooks.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-hooks-unit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** One plan whose fields the shape check probes. */
const plan = (over: Record<string, unknown> = {}): unknown => ({
  goal: 'g',
  stop_condition: 's',
  feasibility: true,
  verifier: { kind: 'assert', conditions: ['result !== undefined'] },
  ...over,
})

describe('isLcrdHooks', () => {
  it('accepts one or both checks and rejects a bundle without a usable check', () => {
    expect(isLcrdHooks({ checkPlan: () => ({ kind: 'allow' }) })).toBe(true)
    expect(isLcrdHooks({ checkResult: () => ({ kind: 'allow' }) })).toBe(true)
    expect(isLcrdHooks({ checkPlan: () => ({ kind: 'allow' }), checkResult: () => ({ kind: 'allow' }) })).toBe(true)
    expect(isLcrdHooks({})).toBe(false)
    expect(isLcrdHooks({ checkPlan: 'nope' })).toBe(false)
    expect(isLcrdHooks({ checkResult: 1 })).toBe(false)
    expect(isLcrdHooks(null)).toBe(false)
    expect(isLcrdHooks('nope')).toBe(false)
  })
})

describe('loadHooks', () => {
  it('loads a default export from an absolute path', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'hooks.mjs')
    writeFileSync(modulePath, [
      'export default {',
      "  checkPlan: () => ({ kind: 'deny', reason: 'blocked' }),",
      '}',
      '',
    ].join('\n'), 'utf8')
    const hooks = await loadHooks(modulePath)
    expect(await hooks.checkPlan?.({} as never)).toEqual({ kind: 'deny', reason: 'blocked' })
  })

  it('loads named exports from a relative path and a bare data URL', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'named.mjs'), [
      "export const checkResult = () => ({ kind: 'terminate', reason: 'stop' })",
      '',
    ].join('\n'), 'utf8')
    const fromRelative = await loadHooks('./named.mjs', dir)
    expect(await fromRelative.checkResult?.({} as never)).toEqual({ kind: 'terminate', reason: 'stop' })
    const dataUrl = `data:text/javascript,${encodeURIComponent("export const checkPlan = () => ({ kind: 'allow' })")}`
    const fromBare = await loadHooks(dataUrl)
    expect(await fromBare.checkPlan?.({} as never)).toEqual({ kind: 'allow' })
  })

  it('rejects a module without a usable hook', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'bad.mjs')
    writeFileSync(modulePath, 'export default {}', 'utf8')
    await expect(loadHooks(modulePath)).rejects.toThrow('must export checkPlan and/or checkResult')
  })
})

describe('isStepPlan', () => {
  it('accepts every verifier kind with a usable shape', () => {
    expect(isStepPlan(plan())).toBe(true)
    expect(isStepPlan(plan({ verifier: { kind: 'python', checks: ['result is not None'] } }))).toBe(true)
    expect(isStepPlan(plan({ verifier: { kind: 'llm' } }))).toBe(true)
  })

  it('rejects a malformed plan', () => {
    expect(isStepPlan(null)).toBe(false)
    expect(isStepPlan('nope')).toBe(false)
    expect(isStepPlan(plan({ goal: 1 }))).toBe(false)
    expect(isStepPlan(plan({ goal: '' }))).toBe(false)
    expect(isStepPlan(plan({ stop_condition: 2 }))).toBe(false)
    expect(isStepPlan(plan({ stop_condition: '' }))).toBe(false)
    expect(isStepPlan(plan({ feasibility: 'yes' }))).toBe(false)
    expect(isStepPlan(plan({ verifier: 'nope' }))).toBe(false)
    expect(isStepPlan(plan({ verifier: null }))).toBe(false)
    expect(isStepPlan(plan({ verifier: { kind: 'unknown' } }))).toBe(false)
    expect(isStepPlan(plan({ verifier: { kind: 'assert', conditions: [] } }))).toBe(false)
    expect(isStepPlan(plan({ verifier: { kind: 'assert', conditions: [1] } }))).toBe(false)
    expect(isStepPlan(plan({ verifier: { kind: 'python', checks: [] } }))).toBe(false)
  })
})
