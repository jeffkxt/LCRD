import { retry } from './source/retry.js'

const cases = [
  ["uses the whole attempt budget", async () => (await (async () => { let calls = 0; try { await retry(3, async () => { calls += 1; throw new Error("x") }, { sleep: async () => {} }) } catch {} return calls })()) === 3],
  ["returns the first success", async () => (await (async () => { let calls = 0; const value = await retry(3, async () => { calls += 1; if (calls < 2) throw new Error("x"); return "ok" }, { sleep: async () => {} }); return calls === 2 && value === "ok" })()) === true],
  ["exponential backoff", async () => (await (async () => { const waits = []; await retry(3, async () => { throw new Error("x") }, { baseDelay: 10, maxDelay: 1000, sleep: async ms => { waits.push(ms) } }).catch(() => {}); return JSON.stringify(waits) })()) === "[10,20]"],
  ["delay cap", async () => (await (async () => { const waits = []; await retry(5, async () => { throw new Error("x") }, { baseDelay: 10, maxDelay: 25, sleep: async ms => { waits.push(ms) } }).catch(() => {}); return JSON.stringify(waits) })()) === "[10,20,25,25]"],
  ["aborted signal never calls fn", async () => (await (async () => { const controller = new AbortController(); let calls = 0; controller.abort(); try { await retry(3, async () => { calls += 1; throw new Error("x") }, { signal: controller.signal, sleep: async () => {} }) } catch {} return calls })()) === 0],
  ["zero budget", async () => (await (async () => { let calls = 0; try { await retry(0, async () => { calls += 1; return "ok" }, { sleep: async () => {} }) } catch {} return calls })()) === 0],
  ["no sleep on success", async () => (await (async () => { const waits = []; const value = await retry(3, async () => "ok", { sleep: async ms => { waits.push(ms) } }); return value === "ok" && waits.length === 0 })()) === true],
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
