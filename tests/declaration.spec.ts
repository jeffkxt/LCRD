import { describe, expect, it } from 'vitest'
import {
  parseString,
  parseBoolean,
  parseVerifier,
  validateDeclaration,
} from '../src/declaration.ts'
import type { StepPlan } from '../src/types.ts'

describe('parseString', () => {
  it('returns the string when valid', () => {
    expect(parseString('hello', 'field')).toBe('hello')
  })

  it('throws on empty string', () => {
    expect(() => parseString('', 'field')).toThrow()
  })

  it('throws on non-string', () => {
    expect(() => parseString(42, 'field')).toThrow()
  })
})

describe('parseBoolean', () => {
  it('returns the boolean when valid', () => {
    expect(parseBoolean(true, 'field')).toBe(true)
    expect(parseBoolean(false, 'field')).toBe(false)
  })

  it('throws on non-boolean', () => {
    expect(() => parseBoolean('yes', 'field')).toThrow()
  })
})

describe('parseVerifier', () => {
  it('returns an assert verifier', () => {
    const result = parseVerifier({ kind: 'assert', conditions: ['result !== undefined'] })
    expect(result.kind).toBe('assert')
    if (result.kind !== 'assert') throw new Error('expected assert verifier')
    expect(result.conditions).toEqual(['result !== undefined'])
  })

  it('carries the declared binding mode', () => {
    const probe = parseVerifier({ kind: 'assert', mode: 'probe', conditions: ['result !== undefined'] })
    expect(probe).toEqual({ kind: 'assert', mode: 'probe', conditions: ['result !== undefined'] })
    expect(parseVerifier({ kind: 'assert', conditions: ['result !== undefined'] }))
      .toEqual({ kind: 'assert', conditions: ['result !== undefined'] })
  })

  it('returns a python verifier', () => {
    const result = parseVerifier({ kind: 'python', checks: ['result is not None'] })
    expect(result.kind).toBe('python')
    if (result.kind !== 'python') throw new Error('expected python verifier')
    expect(result.checks).toEqual(['result is not None'])
  })

  it('returns an llm verifier', () => {
    const result = parseVerifier({ kind: 'llm' })
    expect(result.kind).toBe('llm')
  })

  it('throws on unknown verifier kind', () => {
    expect(() => parseVerifier({ kind: 'unknown' })).toThrow()
  })

  it('throws on empty conditions', () => {
    expect(() => parseVerifier({ kind: 'assert', conditions: [] })).toThrow()
  })
})

describe('validateDeclaration', () => {
  it('passes a valid assert declaration with no gates', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).not.toThrow()
  })

  it('rejects an unbound condition', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['true'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).toThrow('必须引用')
  })

  it('rejects a tautological condition', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === result'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).toThrow('缺少区分度')
  })

  it('admits a probe declaration that pins nothing, and still rejects a non-prediction', () => {
    const probe: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', mode: 'probe', conditions: ['result === result'] },
    }
    expect(() => { validateDeclaration(probe, { rejectPresenceOnly: true, maxHoldRate: 0.9 }) }).not.toThrow()
    const unbound: StepPlan = { ...probe, verifier: { kind: 'assert', mode: 'probe', conditions: ['true'] } }
    expect(() => { validateDeclaration(unbound, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).toThrow('必须引用')
    const broken: StepPlan = { ...probe, verifier: { kind: 'assert', mode: 'probe', conditions: ['result ==='] } }
    expect(() => { validateDeclaration(broken, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).toThrow('无法编译')
  })

  it('rejects a non-compiling condition', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result ==='] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).toThrow('无法编译')
  })

  it('rejects presence-only when rejectPresenceOnly is on', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: true, maxHoldRate: undefined }) }).toThrow('presence-only')
  })

  it('passes presence-only when rejectPresenceOnly is off', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result !== undefined'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).not.toThrow()
  })

  it('rejects a declaration exceeding the hold rate ceiling', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['typeof result === "number"'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: 0.01 }) }).toThrow('约束过弱')
  })

  it('passes a declaration within the hold rate ceiling', () => {
    const plan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'assert', conditions: ['result === 5'] },
    }
    expect(() => { validateDeclaration(plan, { rejectPresenceOnly: false, maxHoldRate: 0.5 }) }).not.toThrow()
  })

  it('is a no-op for python and llm verifiers', () => {
    const pythonPlan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'python', checks: ['result is not None'] },
    }
    expect(() => { validateDeclaration(pythonPlan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).not.toThrow()

    const llmPlan: StepPlan = {
      goal: 'g',
      stop_condition: 's',
      feasibility: true,
      verifier: { kind: 'llm' },
    }
    expect(() => { validateDeclaration(llmPlan, { rejectPresenceOnly: false, maxHoldRate: undefined }) }).not.toThrow()
  })
})
