/**
 * Runtime policy registration against the real skill registry: register,
 * switch, dispose, name conflicts, and the loud failure without the service.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { registerPolicySkills, skillNameTaken, switchPolicySkills } from '../src/evolve/registry.ts'
import type { ProposedSkill } from '../src/evolve/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the skill registry. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  contexts.push(ctx)
  return ctx
}

const V1: ProposedSkill[] = [{ name: 'first-skill', description: 'first', content: '# one\n' }]
const V2: ProposedSkill[] = [{ name: 'second-skill', description: 'second', content: '# two\n' }]

describe('policy skill registration', () => {
  it('registers, switches, and disposes the whole set', async () => {
    const ctx = await setup()
    const first = registerPolicySkills(ctx, 'v0002', V1)
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toContain('first-skill')
    const second = switchPolicySkills(ctx, first, 'v0003', V2, V1)
    const names = (await ctx.skills.snapshot()).skills.map(skill => skill.name)
    expect(names).toContain('second-skill')
    expect(names).not.toContain('first-skill')
    second.dispose()
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).not.toContain('second-skill')
  })

  it('reports a taken name', async () => {
    const ctx = await setup()
    expect(await skillNameTaken(ctx, 'first-skill')).toBe(false)
    registerPolicySkills(ctx, 'v0002', V1)
    expect(await skillNameTaken(ctx, 'first-skill')).toBe(true)
  })

  it('fails loud without the skill service', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => registerPolicySkills(ctx, 'v0002', V1)).toThrow('ctx.skills')
  })

  it('restores the previous set when the new one cannot register', async () => {
    const ctx = await setup()
    const first = registerPolicySkills(ctx, 'v0002', V1)
    expect(() => switchPolicySkills(ctx, first, 'v0003', [{ name: 'Bad Name', description: 'x', content: 'y' }], V1))
      .toThrow()
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toContain('first-skill')
  })
})
