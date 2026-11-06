import { sum } from './source/sum.js'

const cases = [
  ["sum([1, 2, 3]) === 6", async () => sum([1, 2, 3]) === 6],
  ["sum([]) === 0", async () => sum([]) === 0],
  ["sum([5]) === 5", async () => sum([5]) === 5],
]

let passed = 0
for (const [, check] of cases) {
  try {
    if (await check()) passed += 1
  } catch {
    // A throwing check is a failed check.
  }
}
console.log(passed / cases.length)
