import { clamp } from './source/clamp.js'

const cases = [
  ["inside the range", async () => clamp(2, 0, 3) === 2],
  ["below the range", async () => clamp(-1, 0, 3) === 0],
  ["above the range", async () => clamp(5, 0, 3) === 3],
  ["lower bound is inclusive", async () => clamp(0, 0, 3) === 0],
  ["upper bound is inclusive", async () => clamp(3, 0, 3) === 3],
  ["reversed range above", async () => clamp(5, 3, 0) === 3],
  ["reversed range below", async () => clamp(-2, 5, 1) === 1],
  ["NaN returns the lower bound", async () => clamp(Number.NaN, 1, 5) === 1],
  ["equal bounds", async () => clamp(2, 2, 2) === 2],
  ["positive infinity", async () => clamp(Number.POSITIVE_INFINITY, 0, 3) === 3],
  ["negative infinity", async () => clamp(Number.NEGATIVE_INFINITY, 0, 3) === 0],
]

let passed = 0
for (const [label, check] of cases) {
  let ok = false
  try {
    ok = (await check()) === true
  } catch {
    ok = false
  }
  if (ok) passed += 1
  else console.error('FAIL ' + label)
}
console.log(passed / cases.length)
