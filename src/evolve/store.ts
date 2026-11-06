/**
 * The policy version store: immutable version directories, an atomically
 * committed `current.json` pointer guarded by a revision CAS, quarantine
 * records, the holdout rotation history, and the online score window. Every
 * write goes through `writeFileAtomic`; read-modify-write cycles that could
 * race another process take `withFileLock` on the pointer file.
 *
 * @module lcrd-evolve-store
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type {
  ArchiveEntry,
  GateMetrics,
  HoldoutHistory,
  PolicyManifest,
  PolicyPointer,
  PolicyScore,
  PolicySkill,
  PolicyVersionStatus,
  PromotionResult,
  ProposedSkill,
  QuarantineEntry,
  RejectedEdit,
  RejectedEditStage,
} from './types.ts'

/** File and directory locations inside one policy root. */
export interface StorePaths {
  /** The policy root, absolute. */
  root: string
  /** `<root>/versions`. */
  versions: string
  /** `<root>/current.json`. */
  current: string
  /** `<root>/quarantine.json`. */
  quarantine: string
  /** `<root>/holdout-history.json`. */
  holdoutHistory: string
  /** `<root>/archive.jsonl`, the append-only admission ledger. */
  archive: string
}

/** The bootstrap version an empty store starts at. */
const BOOTSTRAP_VERSION = 'v0001'

/** A version name: `v` plus at least four digits. */
const VERSION_NAME = /^v\d{4,}$/

/** A kebab-case skill name accepted by the skill registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Skill names the registry reserves for its own providers. */
const RESERVED_SKILL_NAMES = new Set(['runtime'])

/** Text encoding and permission choices for every store write. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/**
 * Resolve the store locations under one policy root.
 * @param policyDir - the configured policy root, absolute or relative to the process cwd.
 * @returns the absolute store paths.
 */
export function storePaths(policyDir: string): StorePaths {
  const root = resolve(policyDir)
  return {
    root,
    versions: join(root, 'versions'),
    current: join(root, 'current.json'),
    quarantine: join(root, 'quarantine.json'),
    holdoutHistory: join(root, 'holdout-history.json'),
    archive: join(root, 'archive.jsonl'),
  }
}

/**
 * Reject a version name that could escape the store or name a non-version.
 * @param version - the candidate version name.
 * @throws when the name is not `v` plus at least four digits.
 */
export function assertVersionName(version: string): void {
  if (!VERSION_NAME.test(version)) throw new Error(`lcrd policy: invalid version name ${JSON.stringify(version)}`)
}

/**
 * Reject a skill name the registry cannot accept or that would escape the version directory.
 * @param name - the candidate skill name.
 * @throws when the name is not kebab-case, exceeds 64 characters, or is reserved.
 */
export function assertSkillName(name: string): void {
  if (name.length > 64 || !SKILL_NAME.test(name)) {
    throw new Error(`lcrd policy: invalid skill name ${JSON.stringify(name)}; expected kebab-case`)
  }
  if (RESERVED_SKILL_NAMES.has(name)) throw new Error(`lcrd policy: skill name ${JSON.stringify(name)} is reserved`)
}

/**
 * Resolve one child of the store, refusing any path that leaves its root.
 * @param root - the containing directory.
 * @param parts - path segments to join.
 * @returns the absolute child path.
 * @throws when the resolved path escapes the root.
 */
function childPath(root: string, ...parts: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...parts)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`lcrd policy: path ${JSON.stringify(target)} escapes ${JSON.stringify(base)}`)
  }
  return target
}

/**
 * The directory holding one version.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the absolute version directory.
 */
export function versionPath(paths: StorePaths, version: string): string {
  assertVersionName(version)
  return childPath(paths.versions, version)
}

/**
 * Read one JSON file, returning null when it does not exist.
 * @param path - the file to read.
 * @returns the parsed value, or null when the file is absent.
 */
async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/**
 * Write one JSON file atomically.
 * @param path - the destination.
 * @param value - the value to serialize.
 */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/**
 * Digest one skill body, so a manifest can prove which file it describes.
 * @param content - the markdown body.
 * @returns the SHA-256 hex digest.
 */
export function skillDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Read the current pointer.
 * @param paths - the store locations.
 * @returns the pointer.
 * @throws when the pointer is missing or malformed.
 */
export async function readPointer(paths: StorePaths): Promise<PolicyPointer> {
  const pointer = await readJsonFile<PolicyPointer>(paths.current)
  if (pointer === null) throw new Error(`lcrd policy: missing ${paths.current}; initialize the store first`)
  if (!Number.isInteger(pointer.revision) || pointer.revision < 1) throw new Error('lcrd policy: pointer revision must be a positive integer')
  assertVersionName(pointer.version)
  if (!Array.isArray(pointer.history)) throw new Error('lcrd policy: pointer history must be an array')
  if (typeof pointer.promotionHeld !== 'boolean') throw new Error('lcrd policy: pointer promotionHeld must be a boolean')
  return pointer
}

/**
 * Read one version's manifest.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the manifest.
 * @throws when the manifest is missing or names another version.
 */
export async function readManifest(paths: StorePaths, version: string): Promise<PolicyManifest> {
  const manifest = await readJsonFile<PolicyManifest>(join(versionPath(paths, version), 'manifest.json'))
  if (manifest === null) throw new Error(`lcrd policy: version ${version} has no manifest`)
  if (manifest.version !== version) throw new Error(`lcrd policy: manifest ${manifest.version} does not match ${version}`)
  return manifest
}

/** The empty skill set the bootstrap version carries. */
function bootstrapManifest(now: string): PolicyManifest {
  return {
    schemaVersion: 1,
    version: BOOTSTRAP_VERSION,
    parent: null,
    createdAt: now,
    authorSession: null,
    rationale: 'bootstrap: plain protocol, no policy skills',
    benchmarkDigest: null,
    gateId: null,
    skills: [],
    status: 'promoted',
  }
}

/**
 * Create the bootstrap version and pointer when the store is empty; return the
 * existing pointer otherwise. A store with versions but no pointer is
 * inconsistent and fails loud instead of guessing which version was current.
 * @param paths - the store locations.
 * @returns the pointer after initialization.
 */
export async function ensureStore(paths: StorePaths): Promise<PolicyPointer> {
  await mkdir(paths.versions, { recursive: true })
  if (existsSync(paths.current)) return readPointer(paths)
  const existing = await listVersions(paths)
  if (existing.length > 0) throw new Error(`lcrd policy: ${paths.current} is missing but versions exist: ${existing.join(', ')}`)
  const now = new Date().toISOString()
  const manifest = bootstrapManifest(now)
  const dir = versionPath(paths, BOOTSTRAP_VERSION)
  await mkdir(join(dir, 'skills'), { recursive: true, mode: DIR_MODE })
  await writeJsonFile(join(dir, 'manifest.json'), manifest)
  const pointer: PolicyPointer = {
    revision: 1,
    version: BOOTSTRAP_VERSION,
    history: [{ version: BOOTSTRAP_VERSION, ts: now, gateId: null, promotedBy: 'bootstrap' }],
    promotionHeld: false,
  }
  await writeJsonFile(paths.current, pointer)
  return pointer
}

/**
 * List the version names present on disk, oldest first.
 * @param paths - the store locations.
 * @returns the sorted version names; empty before initialization.
 */
export async function listVersions(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.versions)) return []
  const entries = await readdir(paths.versions, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && VERSION_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/**
 * Read every skill file of one version.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the proposed-skill records in manifest order.
 */
export async function loadSkills(paths: StorePaths, version: string): Promise<ProposedSkill[]> {
  const manifest = await readManifest(paths, version)
  const dir = join(versionPath(paths, version), 'skills')
  const skills: ProposedSkill[] = []
  for (const skill of manifest.skills) {
    const content = await readFile(childPath(dir, `${skill.name}.md`), 'utf8')
    skills.push({ name: skill.name, description: skill.description, content })
  }
  return skills
}

/**
 * Stage one immutable candidate version. Version numbering and the parent check
 * run under the pointer lock, so two concurrent proposals cannot claim one name.
 * @param paths - the store locations.
 * @param input - the parent, author, rationale, benchmark digest, and skills.
 * @returns the staged manifest.
 * @throws when the parent is not current or a skill is invalid.
 */
export async function stageVersion(
  paths: StorePaths,
  input: {
    parent: string
    authorSession: string | null
    rationale: string
    benchmarkDigest: string
    skills: readonly ProposedSkill[]
  },
): Promise<PolicyManifest> {
  if (input.skills.length === 0) throw new Error('lcrd policy: a version must carry at least one skill')
  const seen = new Set<string>()
  for (const skill of input.skills) {
    assertSkillName(skill.name)
    if (seen.has(skill.name)) throw new Error(`lcrd policy: duplicate skill name ${JSON.stringify(skill.name)}`)
    seen.add(skill.name)
    if (skill.description.trim().length === 0) throw new Error(`lcrd policy: skill ${skill.name} has an empty description`)
    if (skill.content.trim().length === 0) throw new Error(`lcrd policy: skill ${skill.name} has an empty body`)
  }
  return withFileLock(paths.current, async () => {
    const pointer = await readPointer(paths)
    if (pointer.version !== input.parent) {
      // An archived version may be a parent, but it must exist and still be usable:
      // a missing parent keeps the historical message, a reverted one says so.
      if (!existsSync(join(versionPath(paths, input.parent), 'manifest.json'))) {
        throw new Error(`lcrd policy: parent ${input.parent} is not current (current: ${pointer.version})`)
      }
      const archived = await readManifest(paths, input.parent)
      if (archived.status === 'quarantined') {
        throw new Error(`lcrd policy: parent ${input.parent} is quarantined`)
      }
    }
    const existing = await listVersions(paths)
    const highest = existing.reduce((max, name) => Math.max(max, Number(name.slice(1))), 0)
    const version = `v${String(highest + 1).padStart(4, '0')}`
    const dir = versionPath(paths, version)
    const skillDir = join(dir, 'skills')
    await mkdir(skillDir, { recursive: true, mode: DIR_MODE })
    const skills: PolicySkill[] = []
    for (const skill of input.skills) {
      await writeFileAtomic(join(skillDir, `${skill.name}.md`), skill.content, { mode: FILE_MODE, dirMode: DIR_MODE })
      skills.push({
        name: skill.name,
        description: skill.description,
        digest: skillDigest(skill.content),
        bytes: Buffer.byteLength(skill.content, 'utf8'),
      })
    }
    const manifest: PolicyManifest = {
      schemaVersion: 1,
      version,
      parent: input.parent,
      createdAt: new Date().toISOString(),
      authorSession: input.authorSession,
      rationale: input.rationale,
      benchmarkDigest: input.benchmarkDigest,
      gateId: null,
      skills,
      status: 'proposed',
    }
    await writeJsonFile(join(dir, 'manifest.json'), manifest)
    return manifest
  })
}

/**
 * Rewrite one version's lifecycle status, leaving every other field untouched.
 * @param paths - the store locations.
 * @param version - the version name.
 * @param status - the new status.
 */
export async function setStatus(paths: StorePaths, version: string, status: PolicyVersionStatus): Promise<void> {
  const manifest = await readManifest(paths, version)
  await writeJsonFile(join(versionPath(paths, version), 'manifest.json'), { ...manifest, status })
}

/**
 * Record one gate's verdict and identity on a candidate manifest.
 * @param paths - the store locations.
 * @param version - the candidate version.
 * @param gateId - the gate identity.
 * @param benchmarkDigest - the digest the gate actually scored.
 * @param status - the resulting lifecycle status.
 */
export async function setGateOutcome(
  paths: StorePaths,
  version: string,
  gateId: string,
  benchmarkDigest: string,
  status: PolicyVersionStatus,
): Promise<void> {
  const manifest = await readManifest(paths, version)
  await writeJsonFile(join(versionPath(paths, version), 'manifest.json'), {
    ...manifest,
    benchmarkDigest,
    gateId,
    status,
  })
}

/**
 * Make a gated version current at the expected pointer revision.
 * @param paths - the store locations.
 * @param version - the version to promote.
 * @param expectedRevision - the revision the caller last read; a mismatch aborts.
 * @param promotedBy - the session id, `operator`, or `bootstrap`.
 * @param gateId - the qualifying gate, or null for an offline promotion.
 * @returns the new pointer and the promoted version.
 * @throws when the revision moved, promotions are held, or the version did not pass its gate.
 */
export async function promote(
  paths: StorePaths,
  version: string,
  expectedRevision: number,
  promotedBy: string,
  gateId: string | null,
): Promise<PromotionResult> {
  return withFileLock(paths.current, async () => {
    const pointer = await readPointer(paths)
    if (pointer.revision !== expectedRevision) {
      throw new Error(`lcrd policy: pointer moved (expected revision ${expectedRevision}, found ${pointer.revision})`)
    }
    if (pointer.promotionHeld) throw new Error('lcrd policy: promotions are held by the hard-out audit')
    const manifest = await readManifest(paths, version)
    if (manifest.status !== 'gated-passed') {
      throw new Error(`lcrd policy: ${version} is ${manifest.status}, not gated-passed`)
    }
    /* v8 ignore next 3 -- the bootstrap version is never gated-passed, so promote never reaches it */
    if (manifest.parent === null) {
      throw new Error(`lcrd policy: ${version} has no parent to promote from`)
    }
    if (manifest.parent !== pointer.version) {
      // Re-promoting the version that is already current is not a descent: keep the
      // historical rejection for it, and allow the archived-parent case below.
      if (version === pointer.version) {
        throw new Error(`lcrd policy: ${version} was proposed against ${manifest.parent}, not the current ${pointer.version}`)
      }
      // A candidate may descend from an archived parent rather than the active
      // version: the gate already judged it against the active policy, so the
      // remaining checks are that the parent still exists and was not reverted.
      const parent = await readManifest(paths, manifest.parent)
      /* v8 ignore next 2 -- staging refuses a quarantined parent before it can be promoted */
      if (parent.status === 'quarantined') {
        throw new Error(`lcrd policy: parent ${parent.version} of ${version} is quarantined`)
      }
    }
    await setStatus(paths, version, 'promoted')
    const next: PolicyPointer = {
      revision: pointer.revision + 1,
      version,
      history: [...pointer.history, { version, ts: new Date().toISOString(), gateId, promotedBy }],
      promotionHeld: pointer.promotionHeld,
    }
    await writeJsonFile(paths.current, next)
    await appendPolicyTrace(paths, {
      action: 'promoted',
      version,
      ...gateId === null ? {} : { gateId },
      detail: `${pointer.version} -> ${version} (${promotedBy})`,
    })
    return { version, revision: next.revision }
  })
}

/**
 * Read every quarantine record.
 * @param paths - the store locations.
 * @returns the records in chronological order; empty when none.
 */
export async function readQuarantine(paths: StorePaths): Promise<QuarantineEntry[]> {
  return await readJsonFile<QuarantineEntry[]>(paths.quarantine) ?? []
}

/**
 * Revert the current version to its parent and quarantine it. The current
 * version's manifest is marked `quarantined`, so it can never be cited as a
 * parent again; the record carries the triggering and baseline metrics.
 * @param paths - the store locations.
 * @param reason - the human-readable cause, surfaced to the next proposal.
 * @param metrics - the triggering window metrics.
 * @param metricsBaseline - the parent's baseline metrics.
 * @returns the version reverted from, the version restored, and the new pointer.
 * @throws when the current version has no parent (bootstrap) or the parent is missing.
 */
export async function rollback(
  paths: StorePaths,
  reason: string,
  metrics: GateMetrics | null,
  metricsBaseline: GateMetrics | null,
): Promise<{ from: string; to: string; pointer: PolicyPointer }> {
  return withFileLock(paths.current, async () => {
    const pointer = await readPointer(paths)
    const current = await readManifest(paths, pointer.version)
    if (current.parent === null) throw new Error('lcrd policy: the bootstrap version has no parent to restore')
    const parent = await readManifest(paths, current.parent)
    if (parent.status !== 'promoted') {
      throw new Error(`lcrd policy: parent ${parent.version} is ${parent.status}, not a restorable version`)
    }
    await setStatus(paths, current.version, 'quarantined')
    const records = await readQuarantine(paths)
    const entry: QuarantineEntry = {
      version: current.version,
      ts: new Date().toISOString(),
      reason,
      metrics,
      metricsBaseline,
    }
    await writeJsonFile(paths.quarantine, [...records, entry])
    const next: PolicyPointer = {
      revision: pointer.revision + 1,
      version: parent.version,
      history: [...pointer.history, { version: parent.version, ts: entry.ts, gateId: null, promotedBy: `rollback:${current.version}` }],
      promotionHeld: pointer.promotionHeld,
    }
    await writeJsonFile(paths.current, next)
    await appendPolicyTrace(paths, {
      action: 'rolled-back',
      version: parent.version,
      detail: `${current.version} -> ${parent.version} (${reason})`,
    })
    return { from: current.version, to: parent.version, pointer: next }
  })
}

/**
 * Append one archive row: the admission outcome of one version. Every gate
 * writes a row, admitted or not, so the archive keeps the stepping stones the
 * gate refused as well as the ones it accepted.
 * @param paths - the store locations.
 * @param entry - the row to append.
 */
export async function appendArchiveEntry(paths: StorePaths, entry: ArchiveEntry): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: DIR_MODE })
  await appendFile(paths.archive, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: FILE_MODE })
}

/**
 * Read every archive row in append order.
 * @param paths - the store locations.
 * @returns the rows; an absent archive is an empty history and a corrupt line is skipped.
 */
export async function readArchive(paths: StorePaths): Promise<ArchiveEntry[]> {
  let text: string
  try {
    text = await readFile(paths.archive, 'utf8')
  } catch {
    // An absent archive is an empty history, not a failure.
    return []
  }
  const rows: ArchiveEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line) as ArchiveEntry)
    } catch {
      // A torn append must not hide the rows around it.
    }
  }
  return rows
}

/** One version a proposal may start from, with its sampling weight. */
export interface ParentCandidate {
  /** The candidate version. */
  version: string
  /** Relative sampling weight; a zero weight is never selected. */
  weight: number
}

/**
 * Weight every archived version for parent sampling. An admitted version is
 * weighted by its gain and by novelty (how few archived versions already
 * descend from it); a version the monitor reverted stays a record but is never
 * proposed from again.
 * @param entries - the archive rows.
 * @param quarantined - versions the online monitor reverted.
 * @returns one candidate per admitted version, in first-seen order.
 */
export function parentWeights(entries: readonly ArchiveEntry[], quarantined: readonly string[]): ParentCandidate[] {
  const blocked = new Set(quarantined)
  const children = new Map<string, number>()
  for (const entry of entries) {
    if (entry.parent === null) continue
    children.set(entry.parent, (children.get(entry.parent) ?? 0) + 1)
  }
  const weights = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.admitted || blocked.has(entry.version)) continue
    const gain = entry.gain ?? 0
    const weight = (1 + Math.max(0, gain)) / (1 + (children.get(entry.version) ?? 0))
    weights.set(entry.version, Math.max(weights.get(entry.version) ?? 0, weight))
  }
  return [...weights].map(([version, weight]) => ({ version, weight }))
}

/** The engine's parent choice for one proposal. */
export interface ParentSelection {
  /** The sampled parent. */
  version: string
  /** Further admitted versions the model may descend from instead. */
  alternatives: string[]
}

/**
 * Sample a parent for the next proposal. Novelty keeps one early winner from
 * owning the whole search, and quarantine removes reverted versions from the
 * pool instead of letting them attract proposals forever.
 * @param paths - the store locations.
 * @param random - uniform random source in `[0, 1)`; injectable for deterministic tests.
 * @returns the sampled parent plus two alternatives, or null when nothing was ever admitted.
 */
export async function selectParent(
  paths: StorePaths,
  random: () => number = Math.random,
): Promise<ParentSelection | null> {
  const entries = await readArchive(paths)
  if (entries.length === 0) return null
  const quarantine = await readQuarantine(paths)
  const candidates = parentWeights(entries, quarantine.map(entry => entry.version))
    .sort((left, right) => right.weight - left.weight)
  if (candidates.length === 0) return null
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  let draw = random() * total
  let chosen = candidates[0] as ParentCandidate
  for (const candidate of candidates) {
    draw -= candidate.weight
    if (draw <= 0) {
      chosen = candidate
      break
    }
  }
  const alternatives = candidates
    .filter(candidate => candidate.version !== chosen.version)
    .slice(0, 2)
    .map(candidate => candidate.version)
  return { version: chosen.version, alternatives }
}

/**
 * The append-only rejected-edit log inside one policy root.
 * @param paths - the store locations.
 * @returns the absolute log path.
 */
export function rejectedEditsPath(paths: StorePaths): string {
  return childPath(paths.root, 'rejected-edits.jsonl')
}

/** The rejection stages a log reader accepts. */
const REJECTED_STAGES = new Set<RejectedEditStage>(['static-scan', 'gate-failed', 'gate-aborted'])

/** Validate one decoded log line without trusting its fields. */
function isRejectedEdit(value: unknown): value is RejectedEdit {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1
    && typeof record.version === 'string'
    && typeof record.parent === 'string'
    && typeof record.ts === 'string'
    && typeof record.stage === 'string'
    && REJECTED_STAGES.has(record.stage as RejectedEditStage)
    && Array.isArray(record.reasons)
    && record.reasons.every(reason => typeof reason === 'string')
}

/** Write one rejected edit under the log's file lock. */
async function writeRejectedEdit(paths: StorePaths, edit: RejectedEdit): Promise<void> {
  const target = rejectedEditsPath(paths)
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE })
  await withFileLock(target, async () => {
    await appendFile(target, `${JSON.stringify(edit)}\n`, { mode: FILE_MODE })
  })
}

/**
 * Append one rejected edit. Feedback is best-effort: a failed write must not
 * replace the proposal's original rejection with an I/O error.
 * @param paths - the store locations.
 * @param edit - the rejection to record.
 */
export async function appendRejectedEdit(paths: StorePaths, edit: RejectedEdit): Promise<void> {
  try {
    await writeRejectedEdit(paths, edit)
  } catch { /* feedback must not change the proposal outcome */ }
}

/**
 * Read the newest rejected edits.
 * @param paths - the store locations.
 * @param limit - how many records to return.
 * @returns newest first; malformed lines are skipped.
 */
export async function readRejectedEdits(paths: StorePaths, limit = 20): Promise<RejectedEdit[]> {
  if (limit <= 0) return []
  const target = rejectedEditsPath(paths)
  if (!existsSync(target)) return []
  const text = await readFile(target, 'utf8')
  const records: RejectedEdit[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const decoded: unknown = JSON.parse(line)
      if (isRejectedEdit(decoded)) records.push(decoded)
    } catch { /* one corrupt line must not block the next proposal */ }
  }
  return records.slice(-limit).reverse()
}

/**
 * The most recent quarantine reasons, newest first, for the proposal result.
 * @param paths - the store locations.
 * @param limit - how many reasons to return.
 * @returns the clipped reasons.
 */
export async function quarantineHints(paths: StorePaths, limit: number): Promise<string[]> {
  const records = await readQuarantine(paths)
  return records.slice(-limit).reverse().map(record => `${record.version}: ${record.reason}`)
}

/**
 * Read the holdout rotation history.
 * @param paths - the store locations.
 * @returns the history; empty when no gate has run.
 */
export async function readHoldoutHistory(paths: StorePaths): Promise<HoldoutHistory> {
  return await readJsonFile<HoldoutHistory>(paths.holdoutHistory) ?? { selections: [] }
}

/**
 * Append one gate's task selection to the rotation history.
 * @param paths - the store locations.
 * @param gateId - the gate identity.
 * @param ids - the drawn task ids.
 */
export async function appendHoldoutSelection(paths: StorePaths, gateId: string, ids: readonly string[]): Promise<void> {
  await mkdir(dirname(paths.holdoutHistory), { recursive: true, mode: DIR_MODE })
  await withFileLock(paths.holdoutHistory, async () => {
    const current = await readHoldoutHistory(paths)
    await writeJsonFile(paths.holdoutHistory, {
      selections: [...current.selections, { gateId, ts: new Date().toISOString(), ids: [...ids] }],
    })
  })
}

/**
 * Read one version's online score window.
 * @param paths - the store locations.
 * @param version - the version name.
 * @returns the score; an empty window when the version has none yet.
 */
export async function readScore(paths: StorePaths, version: string): Promise<PolicyScore> {
  return await readJsonFile<PolicyScore>(join(versionPath(paths, version), 'score.json'))
    ?? { version, window: [], baseline: null, updatedAt: new Date(0).toISOString() }
}

/**
 * Append one finished-run observation to a version's score window, keeping the
 * newest `windowSize` samples.
 * @param paths - the store locations.
 * @param version - the version name.
 * @param sample - the run observation.
 * @param windowSize - how many recent observations to keep.
 * @returns the updated score.
 */
export async function appendScore(
  paths: StorePaths,
  version: string,
  sample: PolicyScore['window'][number],
  windowSize: number,
): Promise<PolicyScore> {
  return withFileLock(join(versionPath(paths, version), 'score.json'), async () => {
    const score = await readScore(paths, version)
    const window = [...score.window, sample].slice(-windowSize)
    const next: PolicyScore = { ...score, window, updatedAt: new Date().toISOString() }
    await writeJsonFile(join(versionPath(paths, version), 'score.json'), next)
    return next
  })
}

/**
 * Pin a version's online reference window. Written once, when the first full
 * window is observed, so later windows compare against the version's own
 * behavior rather than another suite's metrics.
 * @param paths - the store locations.
 * @param version - the version name.
 * @param baseline - the reference metrics.
 * @returns the updated score.
 */
export async function setScoreBaseline(paths: StorePaths, version: string, baseline: GateMetrics): Promise<PolicyScore> {
  return withFileLock(join(versionPath(paths, version), 'score.json'), async () => {
    const score = await readScore(paths, version)
    const next: PolicyScore = { ...score, baseline, updatedAt: new Date().toISOString() }
    await writeJsonFile(join(versionPath(paths, version), 'score.json'), next)
    return next
  })
}

/**
 * Write a gate report beside its candidate version.
 * @param paths - the store locations.
 * @param version - the candidate version.
 * @param gateId - the gate identity.
 * @param fileName - the report file name (`report.json`, `brief.json`, `brief.md`).
 * @param content - the serialized report.
 * @returns the absolute path of the written artifact.
 */
export async function writeGateArtifact(
  paths: StorePaths,
  version: string,
  gateId: string,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = childPath(versionPath(paths, version), 'gate', normalizeGateId(gateId))
  const target = childPath(dir, fileName)
  await writeFileAtomic(target, content, { mode: FILE_MODE, dirMode: DIR_MODE })
  return target
}

/**
 * Reject a gate id that could escape the version directory.
 * @param gateId - the candidate gate id.
 * @returns the id unchanged when it is a safe path segment.
 */
export function normalizeGateId(gateId: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(gateId) || gateId === '.' || gateId === '..') {
    throw new Error(`lcrd policy: invalid gate id ${JSON.stringify(gateId)}`)
  }
  return gateId
}

/**
 * Append one policy-lifecycle record to the store's own append-only trace.
 * The session log stays free of plugin-specific events, so an optional plugin
 * never makes a log unreadable for a build that does not load it.
 * @param paths - the store locations.
 * @param entry - the record to append.
 */
export async function appendPolicyTrace(
  paths: StorePaths,
  entry: {
    /** What happened. */
    action: 'proposed' | 'gated' | 'promoted' | 'rolled-back' | 'scored' | 'audit'
    /** The version concerned. */
    version: string
    /** The gate, when the action names one. */
    gateId?: string
    /** Human-readable detail. */
    detail: string
  },
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: DIR_MODE })
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
  await appendFile(join(paths.root, 'policy-events.jsonl'), line, { encoding: 'utf8', mode: FILE_MODE })
}

/**
 * Read the policy lifecycle trace.
 * @param paths - the store locations.
 * @returns the parsed records; empty when none.
 */
export async function readPolicyTrace(paths: StorePaths): Promise<Record<string, unknown>[]> {
  const path = join(paths.root, 'policy-events.jsonl')
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Set or clear the hard-out promotion hold.
 * @param paths - the store locations.
 * @param held - whether promotions stay blocked.
 * @returns the updated pointer.
 */
export async function setPromotionHeld(paths: StorePaths, held: boolean): Promise<PolicyPointer> {
  return withFileLock(paths.current, async () => {
    const pointer = await readPointer(paths)
    const next: PolicyPointer = { ...pointer, revision: pointer.revision + 1, promotionHeld: held }
    await writeJsonFile(paths.current, next)
    return next
  })
}
