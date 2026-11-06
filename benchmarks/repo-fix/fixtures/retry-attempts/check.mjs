import { retry } from './source/retry.js'

const cases = [
  ["uses the whole attempt budget", async () => (await (async () => { let calls = 0; try { await retry(3, async () => { calls += 1; throw new Error("x") }, { sleep: async () => {} }) } catch {} return calls })()) === 3],
  ["returns the first success", async () => (await (async () => { let calls = 0; const value = await retry(3, async () => { calls += 1; if (calls < 2) throw new Error("x"); return "ok" }, { sleep: async () => {} }); return calls === 2 && value === "ok" })()) === true],
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
