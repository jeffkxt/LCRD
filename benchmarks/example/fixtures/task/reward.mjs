/**
 * Reward command for the example benchmark. The benchmark copies this fixture
 * into each run's isolated workspace, so the script reads the answer file next
 * to itself. It prints 1 when the answer matches and 0 otherwise. Benchmark
 * files are operator-trusted artifacts: the gate runs this command with
 * `shell: true` in the run's workspace. Replace the expected values together
 * with the anchors when adopting this fixture for a real task family.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EXPECTED = {
  'h-01': '@deepseek-ai/dsh-experimental-lcrd',
  'h-02': 'lcrd-hard-isolation',
  'h-03': '3',
  'h-04': '2',
  'h-05': '5',
  'h-06': '8',
  'h-07': '3600000',
  'h-08': 'policy-events.jsonl',
  'h-09': 'hidden-comment',
  'h-10': 'run.json',
  's-01': 'hardout',
}

const answersIndex = process.argv.indexOf('--answers')
const answersDir = answersIndex === -1
  ? join(import.meta.dirname, 'answers')
  : process.argv[answersIndex + 1]
const id = process.argv[2]
const expected = id === undefined ? undefined : EXPECTED[id]
if (expected === undefined) {
  console.log(0)
  process.exit(0)
}
try {
  const actual = readFileSync(join(answersDir, `${id}.txt`), 'utf8').trim()
  console.log(actual === expected ? 1 : 0)
} catch {
  console.log(0)
}
