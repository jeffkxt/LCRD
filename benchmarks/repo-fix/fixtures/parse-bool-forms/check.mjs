import { parseBool } from './source/parse-bool.js'

const cases = [
  ["lowercase true", async () => parseBool('true') === true],
  ["uppercase true", async () => parseBool('TRUE') === true],
  ["numeric one", async () => parseBool('1') === true],
  ["lowercase false", async () => parseBool('false') === false],
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
