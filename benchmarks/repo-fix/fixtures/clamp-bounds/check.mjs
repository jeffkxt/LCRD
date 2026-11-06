import { clamp } from './source/clamp.js'

const cases = [
  ["inside the range", async () => clamp(2, 0, 3) === 2],
  ["below the range", async () => clamp(-1, 0, 3) === 0],
  ["above the range", async () => clamp(5, 0, 3) === 3],
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
