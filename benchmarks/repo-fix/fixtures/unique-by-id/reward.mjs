import { unique } from './source/unique.js'

const cases = [
  ["dedupes by id", async () => unique([{ id: 1, v: 'a' }, { id: 1, v: 'b' }]).length === 1],
  ["empty input", async () => unique([]).length === 0],
  ["distinct ids stay", async () => unique([{ id: 1 }, { id: 2 }]).length === 2],
  ["keeps the last item for an id", async () => unique([{ id: 1, v: 'a' }, { id: 1, v: 'b' }])[0].v === 'b'],
  ["order follows first appearance", async () => unique([{ id: 1, v: 'a' }, { id: 2 }, { id: 1, v: 'c' }])[0].v === 'c'],
  ["missing id dedupes by value", async () => unique([{ v: 'x' }, { v: 'x' }, { v: 'y' }]).length === 2],
  ["mixed keys", async () => unique([{ id: 1 }, { v: 'x' }, { id: 1, v: 'z' }]).length === 2],
  ["zero id", async () => unique([{ id: 0 }, { id: 0 }]).length === 1],
  ["empty-string id", async () => unique([{ id: '' }, { id: '' }]).length === 1],
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
