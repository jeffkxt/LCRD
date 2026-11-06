---
description: "Hard-isolation protocol for agent tasks plus versioned prompt-policy evolution: exogenous verification, rollback and termination, a gated skill store, and flow/dataset export."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-lcrd — LCRD Hard-Isolation

English | [中文](README.zh.md)

## Summary

> Snapshot note: this repository exports the LCRD package and its tooling from deepseek-harness. Workspace dependencies are not standalone-installable; run the commands from the harness workspace.

LCRD maps a three-symbol protocol — root anchor, stop symbol, rollback symbol — onto the harness extension points. An exogenous verifier checks every tool result; failures roll back and require a different plan; repeated failures terminate for human review. An opt-in second layer turns solved problems into versioned skills and admits a candidate only after a holdout gate, review brief, and approval. The layers are separate: the protocol controls one task, evolution controls which prompt skills later tasks may use. Detailed contracts live in [doc/architecture.html](doc/architecture.html).

## Table of Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Runtime protocol](#runtime-protocol)
- [Policy evolution and gate](#policy-evolution-and-gate)
- [Components](#components)
- [Quick start](#quick-start)
- [Trust boundaries](#trust-boundaries)
- [Detailed architecture](#detailed-architecture)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="architecture-at-a-glance"></a>
## Architecture at a glance

| Layer | Responsibility | Main entry points |
|---|---|---|
| Runtime protocol | Anchor the task, require a declared plan, verify every tool result, roll back failures, terminate after the retry budget, and offer an optional learning round. | `src/anchor.ts`, `src/plan-tool.ts`, `src/step-verify.ts`, `src/verifiers.ts`, `src/expr.ts`, `src/state.ts` |
| Policy evolution | Turn a solved problem into a skill version; statically scan it; run a paired baseline/candidate gate on a rotating holdout; write a review brief; promote through approval; monitor online behavior and roll back regressions. | `src/evolve/propose-tool.ts`, `static-check.ts`, `holdout.ts`, `gate.ts`, `launch.ts`, `brief.ts`, `store.ts`, `monitor.ts`, `hardout.ts` |
| Evidence and operations | Persist the policy ledger, flow exports, dataset/DPO rows, rejected-edit feedback, notices, and the runtime invariant. | `src/flow.ts`, `src/dataset.ts`, `src/notice.ts`, `src/invariant.ts`, `scripts/lcrd-*` |

**The invariant:** the model authors declarations, skill text, and rationale; it never writes a verifier verdict, a gate result, a pointer, or an approval outcome. Skills are data, not executable code. A promoted change is a pointer swap in the policy store; the current version is read again by the next task.

<a id="runtime-protocol"></a>
## Runtime protocol

1. **Root anchor.** The user's first message is the task contract; the model may not expand, redefine, or silently narrow it. The root-anchor text is pinned as a system-prompt section.
2. **Declare before acting.** Before a task tool call, the model calls `lcrd_plan` with `goal`, `stop_condition`, `feasibility`, and a `verifier`. The declaration is data; the engine owns how it is evaluated.
3. **Exogenous verification.** `assert` evaluates a restricted JS expression list against `result`, `content`, and `isError`; `python` evaluates fixed-template checks; `llm` asks a separate fixed-prompt verification session. A tool error is a failed verification, not a pass.
4. **Rollback and retry.** A failed result is blocked and returned with the failure reason; the model must re-plan with a different method. A retry never silently reuses the old plan.
5. **Termination.** Consecutive failures at the configured limit end the task for human review. Learning mode is an optional, bounded pause before termination; it is in-session and does not persist knowledge across sessions.
6. **File flow.** With `fileFlowEnabled`, the task directory and its flow files are guarded so a write outside the task-flow contract is caught as a path violation.

The runtime is enforced through registrations, not by trusting the prompt: `agent/pre-step` and `tools/post-execute` listeners own the state transitions. A gate child mounts the candidate with evolution disabled, so a measurement run can never propose.

<a id="policy-evolution-and-gate"></a>
## Policy evolution and gate

Evolution is off by default and requires `evolveBenchmarkDir` plus the composed `@deepseek-ai/dsh-skill` service.

1. **Propose.** `lcrd_propose` accepts a rationale, the current `parent_version`, and 1–8 skills. Static rules reject injection, identity negation, authority escalation, hidden text, forged framing, and holdout leakage before a version directory exists.
2. **Stage.** An accepted proposal becomes an immutable `versions/vNNNN/` directory with a manifest, parent, rationale, benchmark digest, and skill digests.
3. **Gate.** One candidate mount probe, then paired baseline and candidate runs on a rotating holdout subset. Each run gets its own workspace and fixture copy; the reward command runs in that workspace.
4. **Decide.** Admission uses ground-truth reward by default. The gate records paired deltas, a bootstrap interval, token spend, termination, cheat, hook, and path metrics. `detectability` is the sample's resolution; `headroom = 1 - baseline.rewardRate` is the effect the benchmark can still show. A gate with `headroom < evolveMinGain` writes a baseline-only `gate-aborted` report before the candidate starts.
5. **Report and review.** `report.json`, `gain-report.md/json`, and `brief.md/json` retain every raw run and the exceptions. The verdict (`gain`, `no-gain`, `insufficient-evidence`) is separate from the gate decision.
6. **Promote and monitor.** `evolvePromote: approval` (default) asks the approval service; `auto` is for CI only. The next task reads `current.json`; the online monitor folds completed runs and can roll back a regressed version. Sealed hard-out audits can hold promotions.
7. **Feedback.** Rejected attempts append a bounded `rejected-edits.jsonl` record; the next proposal sees the latest rules/lines or gate reasons. Notices ride the existing `additionalContexts` channel; no new session event type is added.

<a id="components"></a>
## Components

| Path | Role |
|---|---|
| `src/anchor.ts` | Protocol text, `PROTOCOL_VERSION`, root-anchor section registration |
| `src/plan-tool.ts`, `src/step-verify.ts` | `lcrd_plan`, declaration-time gates, post-execute verification and rollback |
| `src/verifiers.ts`, `src/expr.ts` | Assert/Python/LLM verifier implementation; restricted expression grammar |
| `src/state.ts`, `src/step-learn.ts`, `src/learn-tools.ts` | Per-agent retry, learning-round, and termination state |
| `src/file-flow*.ts` | File-backed task flow and path-violation guard |
| `src/evolve/` | Proposal tool, static scan, holdout, gate launcher, store, brief, gain report, significance, monitor, hard-out audit |
| `src/dataset.ts`, `src/flow.ts` | Flow export and dataset/DPO row construction |
| `src/notice.ts`, `src/invariant.ts` | Best-effort policy notices and durable runtime invariants |
| `benchmarks/` | Example fixture benchmark and repo-fix benchmark |
| `scripts/lcrd-*` | Operator tooling: policy, audit, weight eval, checkpoint registry |
| `training/` | Offline DPO/LoRA scaffold and the weight-path control plane |

<a id="quick-start"></a>
## Quick start

The package is private and is developed inside this repository. Run the source with the in-package patch:

```sh
pnpm dsh --profile headless --patch ./cordis.patch.yml "your task"
pnpm dsh --profile web --patch ./cordis.patch.yml
```

Enable policy evolution with a benchmark and a dedicated gate profile. The bare `headless` profile does not mount LCRD, and a generated overlay only targets `id: lcrd`; create the frozen profile once:

```sh
dsh plugin --profile lcrd-gate add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-experimental-lcrd-gate
```

```yaml
evolveEnabled: true
evolveBenchmarkDir: benchmarks/example
evolvePolicyDir: .lcrd/policy
evolveGateProfile: lcrd-gate
evolveAdmission: reward
evolvePromote: approval
evolveSignificance: off
```

Operator entry points:

```sh
pnpm run lcrd:policy -- show
pnpm run lcrd:policy -- noise --benchmark <dir> --profile lcrd-gate
pnpm run lcrd:audit -- --dataset <corpus> --benchmark <dir>
pnpm run lcrd:weight-eval -- --benchmark <dir> --base-runner <cmd> --candidate-runner <cmd>
pnpm run lcrd:checkpoint -- list
```

<a id="trust-boundaries"></a>
## Trust boundaries

- **Skills are data.** Skill bodies are scanned and mounted as prompt text; they cannot write a gate result, a pointer, or an approval outcome.
- **Benchmarks and rewards are operator-trusted.** The gate executes the task's reward command with `shell: true` in the run workspace. A candidate never sees another run's workspace.
- **Holdout and hard-out are deployment boundaries.** They must sit outside every root the model can read. The plugin validates that they are not inside a skill root, but cannot repair a permissive sandbox.
- **Promotion is an authority decision.** The default is human approval; auto-promotion is not the default and requires statistical evidence.
- **No new session events.** Notices and policy transitions use existing tool-result/additional-context surfaces and the durable ledger.
- **Prompt-level only.** Evolution changes skill text, not model weights. Weight work is a separate pipeline; the repository exposes dataset/DPO export, an evaluation base, and a checkpoint registry, not a trainer that updates an API model.

<a id="detailed-architecture"></a>
## Detailed architecture

[doc/architecture.html](doc/architecture.html) is the full reference: layer diagram, request lifecycle, verifier contracts, gate decision tree, store layout, dataset/DPO pipeline, weight-path status, config table, security model, and quality gates. Use it when changing `src/evolve/`, the protocol text, or the benchmark/storage contracts.

<a id="model-experience"></a>
## Model Experience

### Root-anchor protocol section

#### What the model sees

Every request carries the pinned three-symbol protocol as a system-prompt section, so the contract and verifier rules are present before the first tool call.

#### Token effect

Fixed text on every request; it grows only when the protocol wording or `PROTOCOL_VERSION` changes.

#### KV Cache effect

Prefix-stable; the section changes only with the plugin version, so it preserves cache reuse across steps of a session.

### The `lcrd_plan` tool

#### What the model sees

The tool exposes `goal`, `stop_condition`, `feasibility`, and a `verifier`. The verifier expressions are model-authored data; the evaluation program is plugin-owned.

#### Token effect

Schema tokens on every request while the tool is registered.

#### KV Cache effect

Stable schema; unchanged across steps.

### Learning-round tools (`lcrd_learn` / `lcrd_learn_verify`)

#### What the model sees

With `learningEnabled`, the two learning tools join the tool list. `lcrd_learn` takes problem analysis, needed knowledge, method, and evaluation criteria; `lcrd_learn_verify` takes learned/evidence. A failed self-evaluation consumes one attempt.

#### Token effect

Their parameters ride the tool list while registered; each round adds the declaration, knowledge-acquisition results, and self-evaluation to history.

#### KV Cache effect

Append-only; each round follows the reusable prefix and does not invalidate existing cache entries.

### Rollback, learning, and termination feedback

#### What the model sees

On verification failure the result is blocked and a corrective notice names the reason and the required next step: re-declare a different plan, enter learning mode at the threshold, or stop after termination.

#### Token effect

One retained context message per failure; the injected reason text is data-dependent.

#### KV Cache effect

Append-only; feedback follows the reusable prefix.

### The `lcrd_propose` tool (only when `evolveEnabled`)

#### What the model sees

The tool exposes `rationale`, `parent_version`, and a `skills` array. Its description states the order (static scan, gate, approval) and asks the model to read returned hints before repeating a rejected idea. The model authors skill text and nothing else.

#### Token effect

Schema tokens on every request while evolution is enabled, plus the proposal and its result. Gate children run in separate sessions and never enter this conversation.

#### KV Cache effect

Stable schema; the proposal result is appended after the reusable prefix.

## Known Limitations and Deferred Work

- Policy evolution changes skill text only; it does not change weights, so its ceiling is what a better prompt can buy.
- Learning is in-session and is never persisted or reused across sessions; the evaluation criteria are model-authored, and the real verdict is the exogenous re-solve.
- The gate is small-sample by default. `evolveSignificance` is off by default; `bootstrap` is opt-in and can reject a real gain at small n. Keep `approval` until `lcrd:policy noise` shows `minDetectableGain <= evolveMinGain`.
- Headroom and detectability are separate: `detectability` is sample resolution; `headroom = 1 - baseline.rewardRate` is the maximum possible gain. A gate aborts before the candidate when headroom is below `evolveMinGain`.
- A missing reward under `evolveAdmission: reward` is incomplete evidence, not a pair to drop; baseline missing writes a baseline-only `gate-aborted` report, candidate missing writes a full abort report.
- The termination and speculative-cheat thresholds are zero-tolerance policy rules, not hypothesis tests; a 2-vs-0 count can fail the gate while Fisher's exact test is not significant.
- Static checks are heuristics and can be paraphrased around; the real defenses are "skills are data", the exogenous verifier, and human promotion.
- Holdout and hard-out isolation is a deployment responsibility; the plugin validates only that they are not inside a skill root.
- File sandboxes in `workspace-write` mode need the task-flow root inside the writable workspace; set `logDir` under the workspace or allow it in the sandbox.
- The `assert` verifier uses a restricted expression grammar (`src/expr.ts`); `this`, function construction, regex literals, dynamic import, and loops are not expressible.
- Rejected-edit feedback is best-effort, bounded to the newest 20 records; an append/read failure never blocks a proposal.
- The online monitor folds runs at agent disposal; a one-shot process that exits without disposing an agent observes nothing.
- The `./invariant` companion observes the durable policy store and live skill registry; it is not a substitute for deployment-level isolation.
- Weight training is not implemented in this package. The DPO export and the `training/` scaffold are preparation; an open-weight model and GPU are required for an actual update.

<a id="dev-note"></a>
### Dev Note

`src/anchor.ts` owns the protocol wording and `PROTOCOL_VERSION`; raise the version whenever that wording changes. Policy evolution lives under `src/evolve/`: `store.ts` owns the pointer CAS and quarantine, `holdout.ts` the rotating draw, `static-check.ts` the pre-gate rules, `gate.ts`/`launch.ts` the admission run, `brief.ts` the review page, `monitor.ts` the online revert, and `invariant.ts` the durable relationship checks. The detailed lifecycle and storage contracts are in [doc/architecture.html](doc/architecture.html).
