# Contract

- `retry(times, fn, options)` attempts `fn` at most `times` times and returns the first success.
- Between failed attempts it waits `options.baseDelay` doubled each time, capped by `options.maxDelay`, by calling `options.sleep(ms)` (a real timer by default).
- When `options.signal` is already aborted it throws before calling `fn` at all.
- When every attempt fails it throws the last error.

`check.mjs` samples this contract; it does not cover it completely.
- A zero attempt budget calls `fn` not at all and throws immediately.
- A first-attempt success never sleeps.
