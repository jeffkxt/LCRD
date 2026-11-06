# repo-fix benchmark

[English](README.md) | 中文

五个 holdout 任务和一个封存任务；每个任务都是一个带真实 bug 的小模块，并配有
`reward.mjs`：它导入修复后的模块，输出通过的行为检查比例。`reward` 在运行 workspace
内执行 `node reward.mjs`，因此评分执行的是 agent 自己的代码，而不是读取答案文件。

- holdout：`clamp-bounds`、`parse-bool-forms`、`unique-by-id`、`retry-attempts`、`slug-collapse`
- sealed：`sum-all-items`（不参与日常门禁）

把 `evolveBenchmarkDir` 指向该目录，并保持 `evolveAdmission: reward`。
