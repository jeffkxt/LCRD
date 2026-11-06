import { unique } from './source/unique.js'

const cases = [
  ["dedupes by id", async () => unique([{ id: 1, v: 'a' }, { id: 1, v: 'b' }]).length === 1],
  ["empty input", async () => unique([]).length === 0],
  ["distinct ids stay", async () => unique([{ id: 1 }, { id: 2 }]).length === 2],
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
