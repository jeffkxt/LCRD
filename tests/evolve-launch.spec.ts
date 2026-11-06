/**
 * Production gate launcher: a real child process, artifact discovery, field
 * coercion, a missing artifact, and the timeout kill.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateLauncher } from '../src/evolve/launch.ts'
import type { GateLaunchRequest } from '../src/evolve/gate.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch { /* Windows may still hold a killed child's working directory */ }
  }
})

/** A scratch directory. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-launch-'))
  dirs.push(dir)
  return dir
}

/** Write an overlay whose logDir is the given run directory. */
function overlayAt(root: string, runDir: string): string {
  const path = join(root, 'overlay.yml')
  writeFileSync(path, `- id: lcrd\n  config:\n    logDir: ${JSON.stringify(runDir)}\n`)
  return path
}

/** A launcher config pointing at one script. */
function launcher(script: string, timeoutMs = 30_000): ReturnType<typeof createGateLauncher> {
  return createGateLauncher({
    command: process.execPath,
    args: [script],
    profile: 'headless',
    timeoutMs,
  })
}

/** Write one fake harness script. */
function scriptOf(root: string, source: string): string {
  const path = join(root, 'fake-run.mjs')
  writeFileSync(path, source)
  return path
}

const request = (root: string, runDir: string): GateLaunchRequest => {
  const workspace = join(runDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return {
    overlay: overlayAt(root, runDir),
    task: { id: 'h-1', anchor: 'do it', suite: 'holdout' },
    repeat: 2,
    version: 'v0002',
    runDir,
    workspace,
  }
}

describe('gate launcher', () => {
  it('reads a completed run and coerces every field', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, `
      import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const overlay = process.argv[process.argv.indexOf('--patch') + 1]
      const logDir = JSON.parse(readFileSync(overlay, 'utf8').match(/logDir: (".*")/)[1])
      mkdirSync(join(logDir, 'task', 'nested'), { recursive: true })
      writeFileSync(join(logDir, 'task', 'nested', 'run.json'), JSON.stringify({
        termination: 'completed', final_verdict: 'pass', tokens: 9, plan_count: 2,
        hook_interceptions: 1, path_violations: 0,
        relax_types: { spec_adjust: 1 },
      }))
      process.stderr.write('progress')
    `)
    const sample = await launcher(script)(request(root, runDir))
    expect(sample).toEqual({
      taskId: 'h-1',
      repeat: 2,
      version: 'v0002',
      recorded: true,
      reward: null,
      termination: 'completed',
      finalVerdict: 'pass',
      relaxTypes: { spec_adjust: 1, environment_fault: 0, speculative_cheat: 0 },
      planCount: 2,
      tokens: 9,
      hookInterceptions: 1,
      pathViolations: 0,
    })
    expect(readFileSync(join(runDir, 'gate-stderr.log'), 'utf8')).toBe('progress')
  })

  it('reports an incomplete run when no artifact appears', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, 'process.stderr.write("boom"); process.exit(3)')
    const sample = await launcher(script)(request(root, runDir))
    expect(sample).toMatchObject({ recorded: false, termination: 'incomplete', finalVerdict: 'fail', tokens: 0, planCount: 0 })
    expect(readFileSync(join(runDir, 'gate-stderr.log'), 'utf8')).toBe('boom')
  })

  it('defaults malformed metadata fields', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, `
      import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const overlay = process.argv[process.argv.indexOf('--patch') + 1]
      const logDir = JSON.parse(readFileSync(overlay, 'utf8').match(/logDir: (".*")/)[1])
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'run.json'), JSON.stringify({
        termination: 'weird', final_verdict: 'weird', tokens: -1, plan_count: 'many',
        relax_types: { speculative_cheat: -4 },
      }))
    `)
    const sample = await launcher(script)(request(root, runDir))
    expect(sample).toMatchObject({
      termination: 'incomplete',
      finalVerdict: 'fail',
      tokens: 0,
      planCount: 0,
      relaxTypes: { spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 },
    })
  })

  it('kills a run that exceeds its timeout and logs a spawn failure', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, 'setTimeout(() => {}, 5000)')
    const sample = await launcher(script, 100)(request(root, runDir))
    expect(sample.termination).toBe('incomplete')
    const missing = createGateLauncher({
      command: join(root, 'not-a-command'),
      profile: 'headless',
      timeoutMs: 5000,
    })
    expect((await missing(request(scratch(), join(root, 'second')))).termination).toBe('incomplete')
  })

  it('starts each child in its isolated workspace and exports the path', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const overlay = process.argv[process.argv.indexOf('--patch') + 1]
      const logDir = JSON.parse(readFileSync(overlay, 'utf8').match(/logDir: (".*")/)[1])
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'cwd.txt'), process.cwd())
      writeFileSync(join(logDir, 'env.txt'), process.env.LCRD_RUN_WORKSPACE ?? '')
    `)
    const launchRequest = request(root, runDir)
    await launcher(script)(launchRequest)
    const expected = resolve(join(runDir, 'workspace'))
    expect(resolve(readFileSync(join(runDir, 'cwd.txt'), 'utf8'))).toBe(expected)
    expect(resolve(readFileSync(join(runDir, 'env.txt'), 'utf8'))).toBe(expected)
  })

  it('reads the newest artifact and tolerates a non-object metadata record', async () => {
    const root = scratch()
    const runDir = join(root, 'run')
    const script = scriptOf(root, `
      import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const overlay = process.argv[process.argv.indexOf('--patch') + 1]
      const logDir = JSON.parse(readFileSync(overlay, 'utf8').match(/logDir: (".*")/)[1])
      mkdirSync(join(logDir, 'old', 'nested'), { recursive: true })
      writeFileSync(join(logDir, 'old', 'nested', 'run.json'), JSON.stringify({ termination: 'incomplete' }))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'run.json'), JSON.stringify({ termination: 'completed', final_verdict: 'pass', relax_types: 5 }))
    `)
    const sample = await launcher(script)(request(root, runDir))
    expect(sample).toMatchObject({ recorded: true, termination: 'completed', finalVerdict: 'pass' })
    expect(sample.relaxTypes).toEqual({ spec_adjust: 0, environment_fault: 0, speculative_cheat: 0 })
  })
})
