# LCRD 权重训练脚手架

[English](README.md) | 中文

离线权重工作与提示词策略门禁是两条独立管线。本目录提供 P1 脚手架（按任务组切分的 DPO 数据准备与 QLoRA DPO）和 P2 checkpoint 控制面；它不会对 API 模型训练、不会自动运行，也不会在没有 GPU 和 open-weight 基座模型时声称结果。

## 管线

1. 用 `datasetExport: run` 导出语料，然后运行 `pnpm run lcrd:audit -- --dataset <corpus> --benchmark <benchmark>` 审计。
2. 用 `python training/prepare_dpo.py --dataset <corpus> --out training/data` 按 task group 切分 `dpo.jsonl`。
3. 用 `python training/train_dpo.py --model <open-weight-model> --data training/data --out training/outputs/<id>` 训练 LoRA adapter。
4. 用 `pnpm run lcrd:weight-eval -- --benchmark <benchmark> --base-runner <cmd> --candidate-runner <cmd> --out <eval.json>` 评测 base 与 adapter。
5. 用 `pnpm run lcrd:checkpoint -- register --id <id> --base <model> --adapter <path> --eval <eval.json>` 注册不可变 checkpoint 与评测；`promote`/`rollback` 移动注册表指针。

## 硬约束

- API 模型不能改权重；需要 open-weight 模型和 GPU。
- 必须按 task group 或 run 切分，不能按行切分；绝不能用 holdout 或 hard-out 任务训练。
- checkpoint 不是 skill 策略版本；放进 checkpoint 注册表，不要放进 LCRD 的 `policy/versions`。
- 不要在 agent 内加入模型可指定的 command 校验器，也不要从 agent 内启动训练。
- 权重评测必须使用独立于训练循环的 runner；base 与 candidate 在同一批 held-out 任务上运行。
- `training/data/` 与 `training/outputs/` 是本地产物，已 gitignore。

## 状态

P0 的数据审计与 runner 无关评测底座已实现。P1 训练与 P2 checkpoint promote 仍是脚手架：需要真实基座模型、GPU 和 runner 命令后才产生证据。
