# Contract

- Items that carry an `id` are deduplicated by that id; the returned item for an id is the last one seen.
- Items without an `id` are deduplicated by their JSON value; the first one is kept.
- The output keeps the order in which each key first appeared.

`check.mjs` samples this contract; it does not cover it completely.
- A falsy id (`0`, `""`) is still an id: membership is decided by presence, not truthiness.
