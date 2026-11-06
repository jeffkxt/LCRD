#!/usr/bin/env python3
"""Prepare DPO pairs for offline training with a group-level split.

The input is the `dpo.jsonl` produced by LCRD's dataset export. Splitting is by
task group (or run id when a group is absent), never by row, so one task cannot
appear on both sides of the train/eval boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Any


def group_of(pair: dict[str, Any], index: int) -> str:
    meta = pair.get("meta")
    if isinstance(meta, dict):
        for key in ("task_group", "task_id", "run_id"):
            value = meta.get(key)
            if isinstance(value, str) and value:
                return value
    prompt = pair.get("prompt")
    if isinstance(prompt, str) and prompt:
        return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
    return f"row-{index}"


def valid_pair(pair: Any) -> bool:
    return (
        isinstance(pair, dict)
        and isinstance(pair.get("prompt"), str)
        and isinstance(pair.get("chosen"), str)
        and isinstance(pair.get("rejected"), str)
        and bool(pair["prompt"].strip())
        and bool(pair["chosen"].strip())
        and bool(pair["rejected"].strip())
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Split LCRD DPO pairs by task group.")
    parser.add_argument("--dataset", required=True, type=Path, help="directory containing dpo.jsonl")
    parser.add_argument("--out", required=True, type=Path, help="directory for train.jsonl/eval.jsonl")
    parser.add_argument("--eval-fraction", type=float, default=0.1, help="group-level eval fraction")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    if not 0.0 < args.eval_fraction < 1.0:
        raise SystemExit("--eval-fraction must be in (0, 1)")

    source = args.dataset / "dpo.jsonl"
    if not source.exists():
        raise SystemExit(f"missing {source}; run datasetExport: run first")
    pairs: list[dict[str, Any]] = []
    invalid = 0
    for index, line in enumerate(source.read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        try:
            pair = json.loads(line)
        except json.JSONDecodeError:
            invalid += 1
            continue
        if not valid_pair(pair):
            invalid += 1
            continue
        pair["_group"] = group_of(pair, index)
        pairs.append(pair)

    groups = sorted({pair["_group"] for pair in pairs})
    if len(groups) < 2:
        raise SystemExit("need at least two task groups for a split; refusing a row-level split")
    random.Random(args.seed).shuffle(groups)
    eval_count = max(1, min(len(groups) - 1, round(len(groups) * args.eval_fraction)))
    eval_groups = set(groups[:eval_count])
    train = [pair for pair in pairs if pair["_group"] not in eval_groups]
    evaluation = [pair for pair in pairs if pair["_group"] in eval_groups]
    if not train or not evaluation:
        raise SystemExit("empty train or eval side after grouping")

    args.out.mkdir(parents=True, exist_ok=True)
    for name, rows in (("train.jsonl", train), ("eval.jsonl", evaluation)):
        with (args.out / name).open("w", encoding="utf-8") as handle:
            for pair in rows:
                clean = {key: value for key, value in pair.items() if key != "_group"}
                handle.write(json.dumps(clean, ensure_ascii=False) + "\n")
    manifest = {
        "schemaVersion": 1,
        "source": str(source),
        "seed": args.seed,
        "evalFraction": args.eval_fraction,
        "pairs": len(pairs),
        "invalid": invalid,
        "trainPairs": len(train),
        "evalPairs": len(evaluation),
        "trainGroups": sorted({pair["_group"] for pair in train}),
        "evalGroups": sorted(eval_groups),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
