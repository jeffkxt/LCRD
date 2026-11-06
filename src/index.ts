/**
 * LCRD hard-isolation: the package entry. The protocol, tools, and listeners
 * live in `wiring.ts`; the validated configuration lives in `config.ts`.
 *
 * @module lcrd-hard-isolation
 */
export * from './wiring.ts'
export { Config } from './config.ts'

