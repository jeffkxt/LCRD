//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-lcrd`.
* @module @deepseek-ai/dsh-lcrd/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-lcrd";
/** Cordis companion plugin name. */
const name = "lcrd-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the plan/failure/termination state is private to the
* post-execute listener and flow recorder, and the plugin exposes no
* package-owned event or snapshot that an independent companion can observe.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
