/**
 * Immutable checkpoint registry for the weight path. This is deliberately
 * separate from LCRD's skill policy store: a checkpoint is a model artifact,
 * not a prompt policy. Registration copies the evaluation report so a later
 * promotion can never point at a mutated result.
 *
 * Usage:
 *   pnpm run lcrd:checkpoint -- register --id lora-1 --base Qwen/Qwen2.5-7B \
 *     --adapter ./training/outputs/lora-1 --eval ./weight-eval.json
 *   pnpm run lcrd:checkpoint -- list
 *   pnpm run lcrd:checkpoint -- promote --id lora-1
 *   pnpm run lcrd:checkpoint -- rollback
 *
 * @module lcrd-checkpoint
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One side of a weight evaluation. */
export interface CheckpointSide {
  /** Runner command or model descriptor. */
  runner: string
  /** Mean reward in `[0, 1]`. */
  rewardRate: number
  /** Runs contributing to the mean. */
  runs: number
}

/** The `lcrd:weight-eval` report a checkpoint must carry. */
export interface CheckpointEval {
  /** Report vocabulary version. */
  schemaVersion: 1
  /** Benchmark root used for the run. */
  benchmarkDir: string
  /** Base side. */
  base: CheckpointSide
  /** Candidate side. */
  candidate: CheckpointSide
  /** Tasks paired on both sides. */
  pairedTasks: string[]
  /** Candidate minus base reward rate. */
  meanDelta: number
  /** Non-fatal warnings. */
  warnings?: string[]
}

/** One registered checkpoint. */
export interface CheckpointManifest {
  /** Registry vocabulary version. */
  schemaVersion: 1
  /** Stable checkpoint id. */
  id: string
  /** Base model id or path. */
  baseModel: string
  /** Adapter directory or artifact reference. */
  adapterPath: string
  /** Parent checkpoint id, when this one was derived from another. */
  parent: string | null
  /** ISO-8601 instant. */
  createdAt: string
  /** Operator note. */
  note: string | null
  /** Immutable evaluation evidence. */
  eval: CheckpointEval
}

/** The current checkpoint pointer. */
export interface CheckpointPointer {
  /** Pointer vocabulary version. */
  schemaVersion: 1
  /** Active checkpoint id. */
  id: string
  /** Previous active id, when known. */
  previous: string | null
  /** ISO-8601 instant. */
  ts: string
}

/** Whether a decoded value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one JSON file with a clear error. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write JSON through a temporary sibling, then rename it into place. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Validate one evaluation side. */
function validateSide(value: unknown, name: 'base' | 'candidate'): CheckpointSide {
  if (!isRecord(value)) throw new Error(`eval.${name} must be an object`)
  const runner = value.runner
  const rewardRate = value.rewardRate
  const runs = value.runs
  if (typeof runner !== 'string' || runner.length === 0) throw new Error(`eval.${name}.runner must be a non-empty string`)
  if (typeof rewardRate !== 'number' || !Number.isFinite(rewardRate) || rewardRate < 0 || rewardRate > 1) {
    throw new Error(`eval.${name}.rewardRate must be in [0, 1]`)
  }
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) throw new Error(`eval.${name}.runs must be a positive integer`)
  return { runner, rewardRate, runs }
}

/** Validate a weight-eval report. */
function validateEval(value: unknown): CheckpointEval {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('eval must have schemaVersion 1')
  const benchmarkDir = value.benchmarkDir
  const paired = value.pairedTasks
  const meanDelta = value.meanDelta
  if (typeof benchmarkDir !== 'string' || benchmarkDir.length === 0) throw new Error('eval.benchmarkDir must be a non-empty string')
  if (!Array.isArray(paired) || paired.length === 0 || !paired.every(task => typeof task === 'string')) {
    throw new Error('eval.pairedTasks must be a non-empty string array')
  }
  if (typeof meanDelta !== 'number' || !Number.isFinite(meanDelta)) throw new Error('eval.meanDelta must be a finite number')
  const base = validateSide(value.base, 'base')
  const candidate = validateSide(value.candidate, 'candidate')
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string') : undefined
  return {
    schemaVersion: 1,
    benchmarkDir,
    base,
    candidate,
    pairedTasks: paired,
    meanDelta,
    ...warnings === undefined ? {} : { warnings },
  }
}

/** Read one manifest. */
function readManifest(root: string, id: string): CheckpointManifest {
  const path = join(root, id, 'manifest.json')
  if (!existsSync(path)) throw new Error(`checkpoint ${id} is not registered`)
  const value = readJson(path)
  if (!isRecord(value) || value.schemaVersion !== 1 || value.id !== id) throw new Error(`checkpoint ${id} has an invalid manifest`)
  if (typeof value.baseModel !== 'string' || typeof value.adapterPath !== 'string' || typeof value.createdAt !== 'string') {
    throw new Error(`checkpoint ${id} has an invalid manifest`)
  }
  const parent = value.parent
  const note = value.note
  if (parent !== null && typeof parent !== 'string') throw new Error(`checkpoint ${id} has an invalid parent`)
  if (note !== null && typeof note !== 'string') throw new Error(`checkpoint ${id} has an invalid note`)
  const evaluation = validateEval(value.eval)
  return {
    schemaVersion: 1,
    id,
    baseModel: value.baseModel,
    adapterPath: value.adapterPath,
    parent,
    createdAt: value.createdAt,
    note,
    eval: evaluation,
  }
}

/** Read the current pointer, if any. */
function readPointer(root: string): CheckpointPointer | null {
  const path = join(root, 'current.json')
  if (!existsSync(path)) return null
  const value = readJson(path)
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.ts !== 'string') {
    throw new Error('current.json is invalid')
  }
  const previous = value.previous
  if (previous !== null && typeof previous !== 'string') throw new Error('current.json is invalid')
  return { schemaVersion: 1, id: value.id, previous, ts: value.ts }
}

/** Append one registry event. */
function appendEvent(root: string, event: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true })
  const path = join(root, 'events.jsonl')
  const line = `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`
  if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf8') + line, 'utf8')
  else writeFileSync(path, line, 'utf8')
}

/** Validate a checkpoint id. */
function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('checkpoint id must be lower-case letters, digits, dots, underscores, or dashes')
}

/** Register one checkpoint. */
export function registerCheckpoint(input: {
  root: string
  id: string
  baseModel: string
  adapterPath: string
  evalPath: string
  parent?: string | null
  note?: string | null
}): CheckpointManifest {
  validateId(input.id)
  const directory = join(input.root, input.id)
  if (existsSync(directory)) throw new Error(`checkpoint ${input.id} already exists`)
  const evaluation = validateEval(readJson(input.evalPath))
  const current = readPointer(input.root)
  const parent = input.parent === undefined ? current?.id ?? null : input.parent
  if (parent !== null) readManifest(input.root, parent)
  const manifest: CheckpointManifest = {
    schemaVersion: 1,
    id: input.id,
    baseModel: input.baseModel,
    adapterPath: input.adapterPath,
    parent,
    createdAt: new Date().toISOString(),
    note: input.note ?? null,
    eval: evaluation,
  }
  writeJsonAtomic(join(directory, 'manifest.json'), manifest)
  writeJsonAtomic(join(directory, 'eval.json'), evaluation)
  appendEvent(input.root, { type: 'registered', id: input.id, parent })
  return manifest
}

/** List registered checkpoints. */
export function listCheckpoints(root: string): { id: string; baseModel: string; parent: string | null; current: boolean }[] {
  if (!existsSync(root)) return []
  const current = readPointer(root)?.id ?? null
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
    .map(entry => readManifest(root, entry.name))
    .map(manifest => ({ id: manifest.id, baseModel: manifest.baseModel, parent: manifest.parent, current: manifest.id === current }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** Point the registry at one checkpoint. */
export function promoteCheckpoint(root: string, id: string): CheckpointPointer {
  readManifest(root, id)
  const previous = readPointer(root)?.id ?? null
  const pointer: CheckpointPointer = { schemaVersion: 1, id, previous, ts: new Date().toISOString() }
  writeJsonAtomic(join(root, 'current.json'), pointer)
  appendEvent(root, { type: 'promoted', id, previous })
  return pointer
}

/** Revert to the current checkpoint's parent. */
export function rollbackCheckpoint(root: string): CheckpointPointer {
  const current = readPointer(root)
  if (current === null) throw new Error('no current checkpoint to roll back')
  const manifest = readManifest(root, current.id)
  if (manifest.parent === null) throw new Error(`checkpoint ${manifest.id} has no parent`)
  const pointer: CheckpointPointer = { schemaVersion: 1, id: manifest.parent, previous: current.id, ts: new Date().toISOString() }
  writeJsonAtomic(join(root, 'current.json'), pointer)
  appendEvent(root, { type: 'rolled-back', id: manifest.parent, previous: current.id })
  return pointer
}

/** Read one `--name value` argument. */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** CLI entry. */
function main(): void {
  const root = resolve(argOf('--root') ?? '.lcrd/checkpoints')
  const command = process.argv[2] ?? 'list'
  switch (command) {
    case 'register': {
      const id = argOf('--id')
      const baseModel = argOf('--base')
      const adapterPath = argOf('--adapter')
      const evalPath = argOf('--eval')
      if (id === undefined || baseModel === undefined || adapterPath === undefined || evalPath === undefined) {
        throw new Error('lcrd:checkpoint register requires --id, --base, --adapter, and --eval')
      }
      console.log(JSON.stringify(registerCheckpoint({
        root,
        id,
        baseModel,
        adapterPath,
        evalPath,
        parent: argOf('--parent') ?? null,
        note: argOf('--note') ?? null,
      }), null, 2))
      return
    }
    case 'list':
      console.log(JSON.stringify(listCheckpoints(root), null, 2))
      return
    case 'show': {
      const id = argOf('--id')
      if (id === undefined) throw new Error('lcrd:checkpoint show requires --id')
      console.log(JSON.stringify({ manifest: readManifest(root, id), pointer: readPointer(root) }, null, 2))
      return
    }
    case 'promote': {
      const id = argOf('--id')
      if (id === undefined) throw new Error('lcrd:checkpoint promote requires --id')
      console.log(JSON.stringify(promoteCheckpoint(root, id), null, 2))
      return
    }
    case 'rollback':
      console.log(JSON.stringify(rollbackCheckpoint(root), null, 2))
      return
    case 'current':
      console.log(JSON.stringify(readPointer(root), null, 2))
      return
    default:
      throw new Error(`unknown command ${command}; expected register|list|show|promote|rollback|current`)
  }
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main()
