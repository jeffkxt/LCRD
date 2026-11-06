# repo-fix benchmark

English | [中文](README.zh.md)

Five holdout tasks and one sealed task, each a small module with a real bug plus a
`reward.mjs` that imports the fixed module and prints the fraction of behavioural
checks that pass. `reward` runs `node reward.mjs` inside the run workspace, so the
grade executes the agent's own code instead of reading an answer file.

- holdout: `clamp-bounds`, `parse-bool-forms`, `unique-by-id`, `retry-attempts`, `slug-collapse`
- sealed: `sum-all-items` (never feeds the daily gate)

Point `evolveBenchmarkDir` at this directory and keep `evolveAdmission: reward`.
