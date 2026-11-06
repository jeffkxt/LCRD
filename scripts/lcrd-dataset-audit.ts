/**
 * Audit an LCRD dataset corpus before any weight training. This tool is
 * deliberately GPU-free: it reports whether the exported rows are sufficient,
 * deduplicated, split-safe, and free of benchmark leakage. It never trains or
 * mutates the corpus.
 *
 * Usage:
 *   pnpm run lcrd:audit -- --dataset packages/experimental/lcrd/dataset
 *   pnpm run lcrd:audit -- --dataset ./dataset --benchmark ./benchmarks/repo-fix
 *   pnpm run lcrd:audit -- --dataset ./dataset --json
 *
 * @module lcrd-dataset-audit
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATASET_FILES, loadBenchmark, type DpoPair } from '@deepseek-ai/dsh-experimental-lcrd'

/** One JSONL file's parse result. */
export interface FileAudit {
  /** Whether the file exists. */
  exists: boolean
  /** Non-empty lines read. */
  lines: number
  /** Lines that were not valid JSON objects. */
  invalid: number
  /** Parsed rows. */
  rows: Record<string, unknown>[]
}

/** The complete audit report. */
export interface DatasetAudit {
  /** Corpus root that was read. */
  datasetDir: string
  /** Optional benchmark used for leakage checks. */
  benchmarkDir: string | null
  /** Per-file parse results. */
  files: Record<string, FileAudit>
  /** Row and identity counts. */
  counts: {
    dataset: number
    trainable: number
    needsReview: number
    runs: number
    dpoPairs: number
    uniqueRuns: number
    uniqueSessions: number
    uniqueTaskIds: number
    uniqueTaskGroups: number
  }
  /** Trainability distribution from `dataset.jsonl`. */
  trainability: Record<string, number>
  /** DPO pair shape. */
  dpo: {
    pairs: number
    uniquePrompts: number
    synthetic: number
    meanChosenChars: number
    meanRejectedChars: number
    meanPromptChars: number
  }
  /** Task ids present in both the corpus and the benchmark holdout/hardout. */
  leakage: {
    benchmarkTasks: number
    overlappingTaskIds: string[]
  }
  /** Per-task-group row counts, for group-level splitting. */
  groups: Record<string, number>
  /** Human-readable warnings; empty when the corpus looks usable. */
  warnings: string[]
}

/** Read one JSONL file without failing the whole audit on a bad line. */
function readJsonl(file: string): FileAudit {
  if (!existsSync(file)) return { exists: false, lines: 0, invalid: 0, rows: [] }
  const rows: Record<string, unknown>[] = []
  let lines = 0
  let invalid = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    lines += 1
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>)
      } else {
        invalid += 1
      }
    } catch {
      invalid += 1
    }
  }
  return { exists: true, lines, invalid, rows }
}

/** Average of a numeric field, or 0 for an empty list. */
function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Unique string values of one field in a row list. */
function uniqueField(rows: readonly Record<string, unknown>[], field: string): string[] {
  const found = new Set<string>()
  for (const row of rows) {
    const value = row[field]
    if (typeof value === 'string' && value.length > 0) found.add(value)
  }
  return [...found]
}

/**
 * Audit one corpus.
 * @param datasetDir - the directory produced by `datasetExport: run`.
 * @param benchmarkDir - optional benchmark root for leakage checks.
 * @returns the report.
 */
export async function auditDataset(datasetDir: string, benchmarkDir?: string): Promise<DatasetAudit> {
  const files: Record<string, FileAudit> = {}
  for (const [key, name] of Object.entries(DATASET_FILES)) files[key] = readJsonl(join(datasetDir, name))
  const datasetRows = files.dataset?.rows ?? []
  const dpoRows = files.dpo?.rows ?? []
  const trainability: Record<string, number> = {}
  for (const row of datasetRows) {
    const value = typeof row.trainability === 'string' ? row.trainability : 'unknown'
    trainability[value] = (trainability[value] ?? 0) + 1
  }
  const pairs: DpoPair[] = dpoRows.flatMap((row) => {
    if (typeof row.prompt !== 'string' || typeof row.chosen !== 'string' || typeof row.rejected !== 'string') return []
    if (typeof row.meta !== 'object' || row.meta === null || Array.isArray(row.meta)) return []
    return [{ prompt: row.prompt, chosen: row.chosen, rejected: row.rejected, meta: row.meta as Record<string, unknown> }]
  })
  const dpo = {
    pairs: pairs.length,
    uniquePrompts: new Set(pairs.map(pair => pair.prompt)).size,
    synthetic: pairs.filter(pair => pair.meta.synthetic === true).length,
    meanChosenChars: average(pairs.map(pair => pair.chosen.length)),
    meanRejectedChars: average(pairs.map(pair => pair.rejected.length)),
    meanPromptChars: average(pairs.map(pair => pair.prompt.length)),
  }
  const groups: Record<string, number> = {}
  for (const row of datasetRows) {
    const group = row.task_group
    if (typeof group === 'string' && group.length > 0) groups[group] = (groups[group] ?? 0) + 1
  }
  let leak: DatasetAudit['leakage'] = { benchmarkTasks: 0, overlappingTaskIds: [] }
  const warnings: string[] = []
  const missing = Object.entries(files).filter(([, file]) => !file.exists).map(([key]) => key)
  if (missing.length > 0) warnings.push(`missing corpus file(s): ${missing.join(', ')}`)
  if (dpo.pairs === 0) warnings.push('no DPO pairs; weight training has no preference data')
  if (dpo.synthetic === dpo.pairs && dpo.pairs > 0) warnings.push('every DPO pair is synthetic; verify the chosen side is meaningful')
  if (Object.keys(groups).length < 2) warnings.push('fewer than two task groups; group-level train/eval splitting will be unstable')
  if (benchmarkDir !== undefined) {
    try {
      const benchmark = await loadBenchmark(benchmarkDir)
      const ids = new Set([...benchmark.holdout, ...benchmark.hardout].map(task => task.id))
      leak = {
        benchmarkTasks: ids.size,
        overlappingTaskIds: [...new Set(datasetRows.map(row => row.task_id).filter((id): id is string => typeof id === 'string' && ids.has(id)))],
      }
      if (leak.overlappingTaskIds.length > 0) warnings.push(`dataset overlaps benchmark holdout/hardout task ids: ${leak.overlappingTaskIds.join(', ')}`)
    } catch (error) {
      warnings.push(`benchmark leakage check skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    datasetDir: resolve(datasetDir),
    benchmarkDir: benchmarkDir === undefined ? null : resolve(benchmarkDir),
    files,
    counts: {
      dataset: datasetRows.length,
      trainable: files.trainable?.rows.length ?? 0,
      needsReview: files.needsReview?.rows.length ?? 0,
      runs: files.runs?.rows.length ?? 0,
      dpoPairs: dpo.pairs,
      uniqueRuns: uniqueField(datasetRows, 'run_id').length,
      uniqueSessions: uniqueField(datasetRows, 'session_id').length,
      uniqueTaskIds: uniqueField(datasetRows, 'task_id').length,
      uniqueTaskGroups: uniqueField(datasetRows, 'task_group').length,
    },
    trainability,
    dpo,
    leakage: leak,
    groups,
    warnings,
  }
}

/**
 * Render an audit as Markdown.
 * @param audit - the report.
 * @returns the Markdown page.
 */
export function renderAudit(audit: DatasetAudit): string {
  const warnings = audit.warnings.length === 0 ? ['- None.'] : audit.warnings.map(warning => `- ${warning}`)
  const groups = Object.entries(audit.groups).sort(([left], [right]) => left.localeCompare(right))
  return [
    '# LCRD dataset audit',
    '',
    `- Corpus: \`${audit.datasetDir}\``,
    `- Benchmark: ${audit.benchmarkDir === null ? '—' : `\`${audit.benchmarkDir}\``}`,
    '',
    '## Counts',
    '',
    '| key | value |',
    '|---|---:|',
    ...Object.entries(audit.counts).map(([key, value]) => `| ${key} | ${String(value)} |`),
    '',
    '## Trainability',
    '',
    '| label | rows |',
    '|---|---:|',
    ...Object.entries(audit.trainability).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `| ${key} | ${String(value)} |`),
    '',
    '## DPO pairs',
    '',
    `- pairs: ${String(audit.dpo.pairs)}`,
    `- unique prompts: ${String(audit.dpo.uniquePrompts)}`,
    `- synthetic chosen: ${String(audit.dpo.synthetic)}`,
    `- mean prompt/chosen/rejected chars: ${audit.dpo.meanPromptChars.toFixed(1)} / ${audit.dpo.meanChosenChars.toFixed(1)} / ${audit.dpo.meanRejectedChars.toFixed(1)}`,
    '',
    '## Leakage',
    '',
    `- benchmark tasks: ${String(audit.leakage.benchmarkTasks)}`,
    `- overlapping task ids: ${audit.leakage.overlappingTaskIds.length === 0 ? 'none' : audit.leakage.overlappingTaskIds.join(', ')}`,
    '',
    '## Task groups',
    '',
    '| group | rows |',
    '|---|---:|',
    ...groups.map(([key, value]) => `| ${key} | ${String(value)} |`),
    '',
    '## Warnings',
    '',
    ...warnings,
    '',
  ].join('\n')
}

/** Read one `--name value` argument. */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** CLI entry. */
async function main(): Promise<void> {
  const datasetDir = argOf('--dataset') ?? 'packages/experimental/lcrd/dataset'
  const benchmarkDir = argOf('--benchmark')
  const audit = await auditDataset(datasetDir, benchmarkDir)
  const markdown = renderAudit(audit)
  const out = argOf('--out')
  if (out !== undefined) writeFileSync(out, markdown, 'utf8')
  if (process.argv.includes('--json')) console.log(JSON.stringify(audit, null, 2))
  else console.log(markdown)
  if (Object.values(audit.files).every(file => !file.exists)) process.exitCode = 1
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) await main()
