/**
 * Real-composition guard: lcrd boots from a test-only cordis.yml through the
 * actual Loader + Include path, and both faces of `learningEnabled` follow
 * the config — the registered tool set and the load-time validation of
 * `maxRetries`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as lcrd from '@deepseek-ai/dsh-experimental-lcrd'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given lcrd config block under a private log dir.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'lcrd-loader-'))
  const logDir = join(root, 'lcrd-flow')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-experimental-lcrd'",
    '  config:',
    `    logDir: ${JSON.stringify(logDir)}`,
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-experimental-lcrd', lcrd],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // loader.await() uses allSettled and never rethrows apply/config errors;
  // await each fiber so boot-time throws surface to the caller.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('lcrd real Loader composition through cordis.yml', () => {
  it('learningEnabled: true registers the learn tools alongside lcrd_plan', { timeout: 60_000 }, async () => {
    const ctx = await boot(['    learningEnabled: true'])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('lcrd_plan')
    expect(names).toContain('lcrd_learn')
    expect(names).toContain('lcrd_learn_verify')

    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
  })

  it('learningEnabled defaults off: lcrd_plan is present, learn tools are not', { timeout: 60_000 }, async () => {
    const ctx = await boot([])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('lcrd_plan')
    expect(names).not.toContain('lcrd_learn')
    expect(names).not.toContain('lcrd_learn_verify')
  })

  it('rejects maxRetries below 1 at load', { timeout: 60_000 }, async () => {
    await expect(boot(['    maxRetries: 0'])).rejects.toThrow('maxRetries` must be an integer >= 1')
  })

  it('rejects a non-integer maxRetries after Schemastery normalization', { timeout: 60_000 }, async () => {
    await expect(boot(['    maxRetries: "many"'])).rejects.toThrow(/expected number/)
  })

  it('rejects incoherent evolution settings at load', { timeout: 60_000 }, async () => {
    await expect(boot(['    evolveMaxSkills: 0'])).rejects.toThrow('evolveMaxSkills` must be an integer >= 1')
    await expect(boot(['    evolveMinGain: -1'])).rejects.toThrow('evolveMinGain` must be a non-negative number')
    await expect(boot(['    evolveEnabled: true'])).rejects.toThrow('evolveBenchmarkDir` is required')
    await expect(boot(['    evolveRunMaxTokens: 3000000'])).rejects.toThrow('must not exceed')
    await expect(boot(['    evolveStaticScan: rules+llm'])).rejects.toThrow('requires `evolveScanModel`')
  })

  it('resets the proposal budget on a user step when evolution is enabled', { timeout: 60_000 }, async () => {
    const benchmark = await mkdtemp(join(tmpdir(), 'lcrd-loader-bench-'))
    const policy = join(benchmark, 'policy')
    await writeFile(join(benchmark, 'train.jsonl'), '')
    await mkdir(join(benchmark, 'holdout'), { recursive: true })
    await mkdir(join(benchmark, 'hardout'), { recursive: true })
    await writeFile(join(benchmark, 'holdout', 'pool.jsonl'), `${JSON.stringify({ id: 'h-1', anchor: 'a' })}\n`)
    const ctx = await boot([
      '    evolveEnabled: true',
      `    evolveBenchmarkDir: ${JSON.stringify(benchmark)}`,
      `    evolvePolicyDir: ${JSON.stringify(policy)}`,
    ])
    const agent = { id: 'loader-agent', options: { model: 'mock', provider: 'mock' }, session: { header: {} } }
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'a task' }] }
    const unrelated = { source: { kind: 'lcrd-hard-isolation' }, content: [{ type: 'text', text: 'notice' }] }
    await expect(ctx.waterfall('agent/pre-step', { agent, messages: [user] } as never, async () => ({ kind: 'reject' as const }))).resolves.toEqual({ kind: 'reject' })
    await expect(ctx.waterfall('agent/pre-step', { agent, messages: [unrelated] } as never, async () => ({ kind: 'reject' as const }))).resolves.toEqual({ kind: 'reject' })
  })
})
