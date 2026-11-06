# LCRD weight-training scaffold

English | [中文](README.zh.md)

Offline weight work is a separate pipeline from the prompt-policy gate. This directory ships the P1 scaffold (group-safe DPO data preparation and QLoRA DPO) and the P2 checkpoint control plane; it does not train on an API model, run automatically, or claim a result without a GPU and an open-weight base model.

## Pipeline

1. Export a dataset corpus with `datasetExport: run`, then audit it with `pnpm run lcrd:audit -- --dataset <corpus> --benchmark <benchmark>`.
2. Split `dpo.jsonl` by task group with `python training/prepare_dpo.py --dataset <corpus> --out training/data`.
3. Train a LoRA adapter with `python training/train_dpo.py --model <open-weight-model> --data training/data --out training/outputs/<id>`.
4. Evaluate the base and the adapter with `pnpm run lcrd:weight-eval -- --benchmark <benchmark> --base-runner <cmd> --candidate-runner <cmd> --out <eval.json>`.
5. Register the immutable checkpoint and its evaluation with `pnpm run lcrd:checkpoint -- register --id <id> --base <model> --adapter <path> --eval <eval.json>`; `promote` and `rollback` move the registry pointer.

## Hard rules

- API models cannot be weight-trained; use an open-weight model and a GPU.
- Split by task group or run, never by row; never train on holdout or hard-out tasks.
- A checkpoint is not a skill policy version. Keep it in the checkpoint registry, not in LCRD's `policy/versions`.
- Do not add a model-selected command verifier or execute training from inside an agent.
- A weight evaluation must use a runner independent of the training loop; the base and candidate run on the same held-out tasks.
- `training/data/` and `training/outputs/` are local artifacts and are gitignored.

## Status

P0 dataset audit and the runner-agnostic weight-eval base are implemented. P1 training and P2 checkpoint promotion are scaffolds: they require a real base model, GPU, and a runner command before producing evidence.
