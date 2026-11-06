/**
 * Runtime skill registration for the active policy version. The store owns the
 * files; this module is the only writer of `ctx.skills`, so a promotion or a
 * rollback swaps the whole policy set in one step and a failed switch restores
 * the previous set.
 *
 * @module lcrd-evolve-registry
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { ProposedSkill } from './types.ts'

/** One registration of the policy's whole skill set. */
export interface PolicyRegistration {
  /** The version whose skills are registered. */
  version: string
  /** Dispose every skill of this version. */
  dispose: () => void
}

/**
 * The skill registry, or a loud failure when the deployment enabled policy
 * evolution without composing the skill service.
 * @param ctx - the plugin context.
 * @returns the registry.
 * @throws when `ctx.skills` is absent.
 */
function requireSkills(ctx: Context) {
  const skills = ctx.get('skills')
  if (skills === undefined) {
    throw new Error('lcrd evolve: `ctx.skills` is absent; compose @deepseek-ai/dsh-skill before enabling policy evolution')
  }
  return skills
}

/**
 * Register every skill of one policy version. Partial failure disposes the
 * skills already registered, so the registry never holds half a policy.
 * @param ctx - the plugin context.
 * @param version - the version those skills belong to.
 * @param skills - the skill bodies loaded from the store.
 * @returns the registration handle.
 * @throws when the skill service is absent or a registration fails.
 */
export function registerPolicySkills(
  ctx: Context,
  version: string,
  skills: readonly ProposedSkill[],
): PolicyRegistration {
  const registry = requireSkills(ctx)
  const disposers: (() => void)[] = []
  try {
    for (const skill of skills) {
      disposers.push(registry.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: 'runtime',
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return {
    version,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

/**
 * Replace the registered policy set with another version's. The old set is
 * disposed first because runtime skills are first-wins within one layer; a
 * failed registration restores the previous set before rethrowing.
 * @param ctx - the plugin context.
 * @param current - the registration being replaced.
 * @param version - the new version.
 * @param skills - the new version's skills.
 * @param previousSkills - the old version's skills, used to restore on failure.
 * @returns the new registration handle.
 * @throws when the new set cannot be registered; the old set is restored first.
 */
export function switchPolicySkills(
  ctx: Context,
  current: PolicyRegistration,
  version: string,
  skills: readonly ProposedSkill[],
  previousSkills: readonly ProposedSkill[],
): PolicyRegistration {
  current.dispose()
  try {
    return registerPolicySkills(ctx, version, skills)
  } catch (error) {
    registerPolicySkills(ctx, current.version, previousSkills)
    throw error
  }
}

/**
 * Whether a skill name is already visible in the registry, so a proposal cannot
 * silently lose to a project or built-in skill.
 * @param ctx - the plugin context.
 * @param name - the candidate name.
 * @returns true when a skill with that name is already available.
 */
export async function skillNameTaken(ctx: Context, name: string): Promise<boolean> {
  const registry = requireSkills(ctx)
  const snapshot = await registry.snapshot()
  return snapshot.skills.some(skill => skill.name === name)
}
