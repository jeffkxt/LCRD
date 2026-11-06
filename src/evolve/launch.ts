/**
 * Production gate launcher: one task per child process, started through the
 * supported `dsh <profile>` entry (never a package bin), with a generated
 * overlay that mounts exactly one policy version. The child's own `run.json` is
 * the evidence; a missing artifact counts as an incomplete run rather than an
 * exception, so one broken run cannot void the gate.
 *
 * @module lcrd-evolve-launch
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GateLauncher, GateLaunchRequest } from './gate.ts'
import type { GateSample, RelaxType } from './types.ts'

/** Launcher settings a deployment owns. */
export interface LauncherConfig {
  /** The command that starts the harness; `dsh` on PATH by default. */
  command: string
  /** Arguments prepended before the harness flags (tests pass a script path; production passes none). */
  args?: string[]
  /** The shipped profile the gate runs under. */
  profile: string
  /** Kill a run after this many milliseconds. */
  timeoutMs: number
}

/** The subset of `run.json` the launcher reads. */
interface RunMetaFile {
  termination?: unknown
  final_verdict?: unknown
  tokens?: unknown
  plan_count?: unknown
  cheat_rate?: unknown
  hook_interceptions?: unknown
  path_violations?: unknown
  relax_types?: unknown
}

/** The zero relaxation record. */
const NO_RELAXATIONS: Record<RelaxType, number> = { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 }

/**
 * Find the newest `run.json` under one run directory.
 * @param dir - the run's log directory.
 * @returns the path, or null when the run recorded nothing.
 */
async function newestRunMeta(dir: string): Promise<string | null> {
  // The launcher creates runDir before the child starts; only an external
  // removal can make this false, and that run then simply recorded nothing.
  /* v8 ignore next -- defensive read after the launcher created runDir */
  if (!existsSync(dir)) return null
  const found: { path: string; mtime: number }[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'run.json') found.push({ path, mtime: (await stat(path)).mtimeMs })
    }
  }
  await walk(dir)
  found.sort((left, right) => right.mtime - left.mtime)
  return found[0]?.path ?? null
}

/**
 * Read one run's sample from its metadata.
 * @param request - the launch request, for task/version identity.
 * @param file - the `run.json` path.
 * @returns the sample.
 */
async function sampleOf(request: GateLaunchRequest, file: string): Promise<GateSample> {
  const meta = JSON.parse(await readFile(file, 'utf8')) as RunMetaFile
  const termination = meta.termination === 'completed' || meta.termination === 'terminated' ? meta.termination : 'incomplete'
  const finalVerdict = meta.final_verdict === 'pass' || meta.final_verdict === 'terminated' ? meta.final_verdict : 'fail'
  const relaxTypes: Record<RelaxType, number> = {
    spec_adjust: numberField(meta.relax_types, 'spec_adjust'),
    environment_fault: numberField(meta.relax_types, 'environment_fault'),
    speculative_cheat: numberField(meta.relax_types, 'speculative_cheat'),
  }
  return {
    taskId: request.task.id,
    repeat: request.repeat,
    version: request.version,
    recorded: true,
    reward: null,
    termination,
    finalVerdict,
    relaxTypes,
    planCount: numberValue(meta.plan_count),
    tokens: numberValue(meta.tokens),
    hookInterceptions: numberValue(meta.hook_interceptions),
    pathViolations: numberValue(meta.path_violations),
  }
}

/**
 * Read one numeric record member, defaulting to zero.
 * @param record - the record to read.
 * @param key - the member name.
 * @returns the number, or zero when absent or not a finite number.
 */
function numberField(record: unknown, key: string): number {
  if (typeof record !== 'object' || record === null) return 0
  return numberValue((record as Record<string, unknown>)[key])
}

/**
 * Narrow one value to a finite non-negative number.
 * @param value - the raw value.
 * @returns the number, or zero.
 */
function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Stop one child process and, on Windows, its descendants. A plain kill only
 * reaches the launcher process there, while the harness runs as its child.
 * @param child - the spawned child.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  /* v8 ignore next -- spawn failure leaves no pid to kill */
  if (pid === undefined) return
  /* v8 ignore else -- the POSIX branch runs on Linux/macOS CI */
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  /* v8 ignore next -- exercised on POSIX CI */
  child.kill('SIGKILL')
}

/**
 * Create the production launcher. Each run starts in its own isolated
 * workspace, passed on the request.
 * @param config - command, profile, and timeout.
 * @returns the launcher port implementation.
 */
export function createGateLauncher(config: LauncherConfig): GateLauncher {
  return async (request) => {
    await mkdir(request.runDir, { recursive: true })
    const stderrPath = join(request.runDir, 'gate-stderr.log')
    const stderr: string[] = []
    await new Promise<number>((resolve) => {
      const child = spawn(
        config.command,
        [...config.args ?? [], '--profile', config.profile, '--patch', request.overlay, request.task.anchor],
        {
          // The child works inside its own isolated copy of the task fixture,
          // never the shared task root, so no run can observe another's output.
          cwd: request.workspace,
          env: { ...process.env, LCRD_RUN_WORKSPACE: request.workspace },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      )
      let settled = false
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        killTree(child)
        finish(-1)
      }, config.timeoutMs)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk.toString('utf8'))
        /* v8 ignore next -- bounded retention; a child must emit 200+ chunks */
        if (stderr.length > 200) stderr.shift()
      })
      child.on('error', () => { finish(-1) })
      child.on('close', (code) => {
        /* v8 ignore next -- code is null only when the child died from a signal */
        finish(code ?? -1)
      })
    })
    if (stderr.length > 0) await writeFile(stderrPath, stderr.join(''), 'utf8')
    const file = await newestRunMeta(request.runDir)
    if (file === null) {
      return {
        taskId: request.task.id,
        repeat: request.repeat,
        version: request.version,
        recorded: false,
        reward: null,
        termination: 'incomplete',
        finalVerdict: 'fail',
        relaxTypes: { ...NO_RELAXATIONS },
        planCount: 0,
        tokens: 0,
        hookInterceptions: 0,
        pathViolations: 0,
      }
    }
    return sampleOf(request, file)
  }
}
