/**
 * Shared dynamic-module loading for the plugin's pluggable deployment modules:
 * one specifier rule (relative or absolute path against a base directory, bare
 * specifier as a package name) and one import shape (default export when
 * present, otherwise the module namespace), so `attribution` and `hooks` agree
 * on how a configured module is found and read.
 *
 * @module lcrd-module-loader
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Import one pluggable module. A relative or absolute path resolves against
 * `baseUrl` and loads as a file URL; a bare specifier loads as a package name.
 * The default export wins; a module without one yields its namespace.
 * @param specifier - the module path or package name.
 * @param baseUrl - directory for resolving a relative path; defaults to the process working directory.
 * @returns the module's default export, or its namespace when there is none.
 */
export async function importModule(specifier: string, baseUrl = process.cwd()): Promise<unknown> {
  const href = /^[./\\]|[a-zA-Z]:[\\/]|^\//.test(specifier)
    ? pathToFileURL(resolve(baseUrl, specifier)).href
    : specifier
  const module = await import(href) as { default?: unknown }
  return module.default ?? module
}
