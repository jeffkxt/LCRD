import { describe, expect, it, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importModule } from '../src/module-loader.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lcrd-module-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('importModule', () => {
  it('loads a default export from an absolute path', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'test.mjs')
    writeFileSync(modulePath, 'export default { foo: true }', 'utf8')
    const result = await importModule(modulePath)
    expect(result).toEqual({ foo: true })
  })

  it('loads named exports when there is no default export', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'named.mjs')
    writeFileSync(modulePath, 'export const bar = 42', 'utf8')
    const result = await importModule(modulePath)
    expect(result).toBeDefined()
    expect((result as { bar: number }).bar).toBe(42)
  })

  it('loads a relative path against baseUrl', async () => {
    const dir = tempDir()
    const modulePath = join(dir, 'rel.mjs')
    writeFileSync(modulePath, 'export default { ok: true }', 'utf8')
    const result = await importModule('./rel.mjs', dir)
    expect(result).toEqual({ ok: true })
  })
})
