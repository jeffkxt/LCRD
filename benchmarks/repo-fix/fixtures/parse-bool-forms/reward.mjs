import { parseBool } from './source/parse-bool.js'

const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const cases = [
  ["lowercase true", async () => parseBool('true') === true],
  ["uppercase true", async () => parseBool('TRUE') === true],
  ["numeric one", async () => parseBool('1') === true],
  ["lowercase false", async () => parseBool('false') === false],
  ["numeric zero", async () => parseBool('0') === false],
  ["padded input", async () => parseBool(' false ') === false],
  ["unknown input throws", async () => throws(() => parseBool('yes'))],
  ["empty input throws", async () => throws(() => parseBool(''))],
  ["numeric input", async () => parseBool(1) === true],
  ["trailing space", async () => parseBool('True ') === true],
  ["inner whitespace throws", async () => throws(() => parseBool(' t r u e '))],
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
