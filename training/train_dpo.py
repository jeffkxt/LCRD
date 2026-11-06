#!/usr/bin/env python3
"""Offline DPO/LoRA training scaffold for an open-weight model.

This script never runs automatically. Supply a real base model and a GPU; use
`prepare_dpo.py` for the group-safe split and `lcrd:weight-eval` for the
independent evaluation. API models cannot be trained with this path.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import DPOConfig, DPOTrainer


def main() -> None:
    parser = argparse.ArgumentParser(description="QLoRA DPO on open weights.")
    parser.add_argument("--model", required=True, help="base model id or local path")
    parser.add_argument("--data", required=True, type=Path, help="directory from prepare_dpo.py")
    parser.add_argument("--out", required=True, type=Path, help="adapter output directory")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--no-4bit", action="store_true", help="disable QLoRA quantization")
    parser.add_argument("--bf16", action="store_true")
    args = parser.parse_args()

    train_path = args.data / "train.jsonl"
    eval_path = args.data / "eval.jsonl"
    if not train_path.exists() or not eval_path.exists():
        raise SystemExit("missing train.jsonl/eval.jsonl; run prepare_dpo.py first")
    train = load_dataset("json", data_files=str(train_path), split="train")
    evaluation = load_dataset("json", data_files=str(eval_path), split="train")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization = None
    if not args.no_4bit:
        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16 if args.bf16 else torch.float16,
        )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        trust_remote_code=True,
        device_map="auto",
        quantization_config=quantization,
        torch_dtype=torch.bfloat16 if args.bf16 else torch.float16,
    )
    model = prepare_model_for_kbit_training(model) if quantization is not None else model
    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules="all-linear",
    )
    model = get_peft_model(model, lora)
    config = DPOConfig(
        output_dir=str(args.out),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        max_length=args.max_length,
        logging_steps=10,
        save_strategy="epoch",
        bf16=args.bf16,
        report_to=[],
        remove_unused_columns=False,
    )
    trainer = DPOTrainer(
        model=model,
        ref_model=None,
        args=config,
        train_dataset=train,
        eval_dataset=evaluation,
        tokenizer=tokenizer,
    )
    trainer.train()
    args.out.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(args.out))
    tokenizer.save_pretrained(str(args.out))
    manifest = {
        "schemaVersion": 1,
        "baseModel": args.model,
        "trainPairs": len(train),
        "evalPairs": len(evaluation),
        "epochs": args.epochs,
        "loraR": args.lora_r,
        "loraAlpha": args.lora_alpha,
        "quantized": not args.no_4bit,
    }
    (args.out / "training_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
