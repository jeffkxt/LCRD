/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-lcrd`. It observes the policy
 * store and the live skill registry from the outside: the pointer must name a
 * complete, digest-matching version; every promoted version must carry the
 * gate report that admitted it; no quarantined version may be current; a
 * holdout draw may not repeat a task; and every run's recorded policy version
 * must exist. Registration validates at startup and again after every
 * `lcrd_propose` result, which is the durable effect the store records.
 *
 * @module @deepseek-ai/dsh-experimental-lcrd/invariant
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-skill'
import type { HoldoutHistory, PolicyManifest, PolicyPointer, QuarantineEntry } from './evolve/types.ts'

/** Full npm package name that owns these checks. */
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-lcrd'

/** Cordis companion plugin name. */
export const name = 'lcrd-policy-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Companion configuration. */
export interface Config {
  /** The policy root the plugin was mounted with. */
  policyDir?: string
  /** Optional flow-log root, so recorded runs can be checked against known versions. */
  flowDir?: string
}

/** The plugin's conventional policy root: `policy/` beside the flow-log directory. */
const DEFAULT_POLICY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy')

/** The configured policy root; the companion is a singleton per process. */
let policyDir: string | undefined
/** The optional flow root. */
let flowDir: string | undefined

/**
 * Read one JSON file, or null when it is absent.
 * @param path - the file to read.
 * @returns the parsed value; the caller states the durable record type.
 */
function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Digest one skill body the same way the store does.
 * @param content - the markdown body.
 * @returns the SHA-256 hex digest.
 */
function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Validate the durable policy relationships under one store root.
 * @param root - the policy root.
 * @param fail - the package-attributed failure reporter.
 * @param runsRoot - optional flow root whose `run.json` files name a policy version.
 */
export function validatePolicyStore(root: string, fail: InvariantFailure, runsRoot?: string): void {
  const pointer = readJson(join(root, 'current.json')) as PolicyPointer | null
  if (pointer === null) return
  const versionsDir = join(root, 'versions')
  const manifestOf = (version: string): PolicyManifest | null =>
    readJson(join(versionsDir, version, 'manifest.json')) as PolicyManifest | null
  const current = manifestOf(pointer.version)
  if (current === null) fail(`current version ${pointer.version} has no manifest`)
  for (const skill of current.skills) {
    const path = join(versionsDir, pointer.version, 'skills', `${skill.name}.md`)
    if (!existsSync(path)) fail(`current version ${pointer.version} is missing skill file ${skill.name}`)
    if (digest(readFileSync(path, 'utf8')) !== skill.digest) {
      fail(`current version ${pointer.version} skill ${skill.name} does not match its manifest digest`)
    }
  }
  /* v8 ignore if -- a pointer without its version tree fails at the manifest check above */
  if (!existsSync(versionsDir)) return
  const known = new Set<string>()
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    known.add(entry.name)
    const manifest = manifestOf(entry.name)
    if (manifest === null) continue
    if (manifest.status === 'promoted' && manifest.gateId !== null) {
      const report = readJson(
        join(versionsDir, entry.name, 'gate', manifest.gateId, 'report.json'),
      ) as { pass?: unknown; benchmarkDigest?: unknown } | null
      if (report === null) fail(`promoted version ${entry.name} has no gate report ${manifest.gateId}`)
      else if (report.pass !== true) fail(`promoted version ${entry.name} did not pass its gate ${manifest.gateId}`)
      else if (report.benchmarkDigest !== manifest.benchmarkDigest) {
        fail(`promoted version ${entry.name} gate report digest does not match its manifest`)
      }
    }
  }
  /* v8 ignore next -- a readable current manifest always names a directory in `known` */
  if (!known.has(pointer.version)) fail(`current pointer names unknown version ${pointer.version}`)
  const quarantine = (readJson(join(root, 'quarantine.json')) as QuarantineEntry[] | null) ?? []
  if (quarantine.some(entry => entry.version === pointer.version)) {
    fail(`quarantined version ${pointer.version} is current`)
  }
  const archivePath = join(root, 'archive.jsonl')
  if (existsSync(archivePath)) {
    for (const line of readFileSync(archivePath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      let row: { version?: unknown; parent?: unknown }
      try {
        row = JSON.parse(line) as { version?: unknown; parent?: unknown }
      } catch {
        // A torn append must not hide the rows around it.
        continue
      }
      if (typeof row.version === 'string' && !known.has(row.version)) {
        fail(`archive names unknown version ${row.version}`)
      }
      if (typeof row.parent === 'string' && !known.has(row.parent)) {
        fail(`archive entry ${String(row.version)} names unknown parent ${row.parent}`)
      }
    }
  }
  const history = readJson(join(root, 'holdout-history.json')) as HoldoutHistory | null
  for (const selection of history?.selections ?? []) {
    if (new Set(selection.ids).size !== selection.ids.length) {
      fail(`holdout selection ${selection.gateId} repeats a task id`)
    }
  }
  if (runsRoot !== undefined) {
    for (const run of findAll(runsRoot, 'run.json', 4)) {
      const meta = readJson(run) as { policy_version?: unknown } | null
      const recorded = meta?.policy_version
      if (typeof recorded === 'string' && !known.has(recorded)) {
        fail(`run ${run} records unknown policy version ${recorded}`)
      }
    }
  }
}

/**
 * Find files with one name under a root, bounded by depth.
 * @param root - the search root.
 * @param fileName - the exact file name.
 * @param depth - remaining directory depth.
 * @returns the matching absolute paths.
 */
function findAll(root: string, fileName: string, depth: number): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) found.push(...findAll(path, fileName, depth - 1))
    } else if (entry.name === fileName) {
      found.push(path)
    }
  }
  return found
}

/** Compare the registered policy skills against the current manifest. */
async function validateRegisteredSkills(ctx: Context, fail: InvariantFailure): Promise<void> {
  const skills = ctx.get('skills')
  if (skills === undefined || policyDir === undefined) return
  const pointer = readJson(join(policyDir, 'current.json')) as PolicyPointer | null
  if (pointer === null) return
  const manifest = readJson(join(policyDir, 'versions', pointer.version, 'manifest.json')) as PolicyManifest | null
  /* v8 ignore next -- validatePolicyStore already rejected a missing current manifest */
  if (manifest === null) return
  const snapshot = await skills.snapshot()
  const registered = new Set(snapshot.skills.map(skill => skill.name))
  for (const skill of manifest.skills) {
    if (!registered.has(skill.name)) {
      fail(`current version ${pointer.version} skill ${skill.name} is not registered`)
    }
  }
}

/** The checked installer: startup validation plus a check after each proposal. */
const install: InvariantInstaller = Object.assign(async (ctx: Context, fail: InvariantFailure) => {
  /* v8 ignore next -- `apply` always assigns the policy root before installing */
  if (policyDir === undefined) fail('the invariant companion was mounted without policyDir')
  validatePolicyStore(policyDir, fail, flowDir)
  await validateRegisteredSkills(ctx, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [unknown, { type?: unknown }])[1]
    // A turn boundary follows any proposal and its gate, so the store's
    // durable effect is observable by the time the turn closes.
    if (event.type === 'turn/end') validatePolicyStore(policyDir as string, fail, flowDir)
  }, { global: true })
}, { inject: [] })

/**
 * Register this package's invariant companion. The policy root defaults to the
 * plugin's convention location, so a composition that mounts the companion
 * without configuration still starts; with no store present every check is a
 * no-op because there is no durable state to contradict.
 * @param ctx - Cordis context carrying the invariant service.
 * @param config - the policy root the plugin was mounted with.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context, config: Config = {}): Promise<() => void> => {
  policyDir = config.policyDir ?? DEFAULT_POLICY_DIR
  flowDir = config.flowDir
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}
