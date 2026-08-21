/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lcrd`.
 * @module @deepseek-ai/dsh-lcrd/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lcrd'

/** Cordis companion plugin name. */
export const name = 'lcrd-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plan/failure/termination state is private to the
 * post-execute listener and flow recorder, and the plugin exposes no
 * package-owned event or snapshot that an independent companion can observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
