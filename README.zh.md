---
description: "面向 agent 任务的硬隔离协议，以及版本化的提示词策略演化：外生校验、回退与终止、带门禁的 skill store，以及 flow/dataset 导出。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-lcrd — LCRD 硬隔离

[English](README.md) | 中文

## 概述

> 快照说明：本仓库从 deepseek-harness 导出 LCRD 包及其工具链；workspace 依赖不能独立安装，请在 harness 仓库内运行命令。

LCRD（long-chain reasoning drift）把三符号协议——根锚、停止符、退回符——映射到 harness 扩展点：每个工具结果都由模型无法拥有的外生校验器检查；失败结果会被阻断，模型必须换一种方法；连续失败达到预算后终止任务并转人工。第二层是可选的策略演化：把解决过的问题沉淀成带版本的 skill，并且只有通过 holdout 门禁、预审简报和配置的审批权威后才准入。两层刻意分离：运行时协议控制单个任务，策略演化控制后续任务可以使用哪些 prompt skill。

详细架构、门禁语义、store 布局和运维契约见 [doc/architecture.html](doc/architecture.html)。本 README 只保留入口和边界。

## 目录

- [架构速览](#architecture-at-a-glance)
- [运行时协议](#runtime-protocol)
- [策略演化与门禁](#policy-evolution-and-gate)
- [组件](#components)
- [快速开始](#quick-start)
- [信任边界](#trust-boundaries)
- [详细架构](#detailed-architecture)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="architecture-at-a-glance"></a>
## 架构速览

| 层 | 职责 | 主要入口 |
|---|---|---|
| 运行时协议 | 锚定任务、要求先声明计划、校验每个工具结果、失败回退、重试预算耗尽后终止，并提供可选的学习轮。 | `src/anchor.ts`、`src/plan-tool.ts`、`src/step-verify.ts`、`src/verifiers.ts`、`src/expr.ts`、`src/state.ts` |
| 策略演化 | 把一个解决方案沉淀成 skill 版本；静态扫描；在轮换 holdout 上跑 baseline/candidate 配对门禁；写预审简报；按审批 promote；在线监控并回滚回退。 | `src/evolve/propose-tool.ts`、`static-check.ts`、`holdout.ts`、`gate.ts`、`launch.ts`、`brief.ts`、`store.ts`、`monitor.ts`、`hardout.ts` |
| 证据与运维 | 持久化策略账本、flow 导出、dataset/DPO 行、被拒提案反馈、通知和运行时 invariant。 | `src/flow.ts`、`src/dataset.ts`、`src/notice.ts`、`src/invariant.ts`、`scripts/lcrd-*` |

**不变量：** 模型只写声明、skill 文本和理由；它永远不写校验判定、门禁结果、指针或审批结果。skill 是数据，不是可执行代码。promote 是策略 store 里的指针切换；下一个任务会重新读取当前版本。

<a id="runtime-protocol"></a>
## 运行时协议

1. **根锚。** 用户的第一条消息是任务契约；模型不得扩张、重定义或静默缩小它。根锚文本作为 system prompt 的固定段落注入。
2. **先声明再行动。** 任务工具调用前，模型必须调用 `lcrd_plan`，给出 `goal`、`stop_condition`、`feasibility` 和 `verifier`。声明是数据；如何校验由引擎决定。
3. **外生校验。** `assert` 在受限 JS 表达式上检查 `result`、`content`、`isError`；`python` 用固定模板执行检查；`llm` 使用独立、固定提示词的校验会话。工具错误是校验失败，不是通过。
4. **回退与重试。** 失败结果被阻断并返回失败原因；模型必须换一种方法重新声明。禁止原样复用旧计划重试。
5. **终止。** 连续失败达到上限后终止任务转人工。学习模式是终止前的有界暂停，仅限会话内，不跨会话持久化。
6. **文件流。** 开启 `fileFlowEnabled` 时，任务目录与流程文件受保护；越过 task-flow 契约的写入会计为路径违规。

运行时靠注册的监听器执行，而不是靠相信提示词：`agent/pre-step` 与 `tools/post-execute` 拥有状态迁移。门禁子进程挂载候选版本时关闭演化，因此测量运行永远不能发起提案。

<a id="policy-evolution-and-gate"></a>
## 策略演化与门禁

演化默认关闭，开启需要 `evolveBenchmarkDir` 并组合 `@deepseek-ai/dsh-skill`。

1. **提案。** `lcrd_propose` 接收理由、当前 `parent_version` 和 1–8 个 skill。静态规则在版本目录存在之前拒绝注入、身份否定、越权、隐藏文本、伪造框架标签和 holdout 泄漏。
2. **落盘。** 通过的提案成为不可变的 `versions/vNNNN/`，带 manifest、父版本、理由、benchmark digest 和 skill digest。
3. **门禁。** 先跑一次候选挂载探针，再在轮换 holdout 子集上跑 baseline/candidate 配对运行。每次运行有独立 workspace 和 fixture 副本；reward 在该 workspace 内执行。
4. **判定。** 默认用 ground-truth reward 准入。门禁记录配对差值、bootstrap 区间、token、终止、作弊、hook 和路径指标。`detectability` 是样本分辨力；`headroom = 1 - baseline.rewardRate` 是基准还能体现的效应上限。headroom 小于 `evolveMinGain` 时，在 candidate 启动前写 baseline-only 的 `gate-aborted` report。
5. **报告与预审。** `report.json`、`gain-report.md/json`、`brief.md/json` 保留每条原始运行和异常。判定（`gain`、`no-gain`、`insufficient-evidence`）与门禁决定分离。
6. **Promote 与监控。** `evolvePromote: approval`（默认）询问审批服务；`auto` 只用于 CI。下一个任务读取 `current.json`；在线监控折叠已完成运行，并可回滚回退版本。封存 hard-out 审计可以暂停 promote。
7. **反馈。** 被拒提案向有界的 `rejected-edits.jsonl` 追加记录；下一次提案能看到最近的规则/行号或门禁原因。通知走既有 `additionalContexts` 通道，不新增 session 事件类型。

<a id="components"></a>
## 组件

| 路径 | 作用 |
|---|---|
| `src/anchor.ts` | 协议文本、`PROTOCOL_VERSION`、根锚段落注册 |
| `src/plan-tool.ts`、`src/step-verify.ts` | `lcrd_plan`、声明期门禁、post-execute 校验与回退 |
| `src/verifiers.ts`、`src/expr.ts` | Assert/Python/LLM 校验器；受限表达式语法 |
| `src/state.ts`、`src/step-learn.ts`、`src/learn-tools.ts` | 每 agent 的重试、学习轮和终止状态 |
| `src/file-flow*.ts` | 文件化 task flow 与路径违规护栏 |
| `src/evolve/` | 提案工具、静态扫描、holdout、门禁启动器、store、预审、增益报告、显著性、监控、hard-out 审计 |
| `src/dataset.ts`、`src/flow.ts` | Flow 导出与 dataset/DPO 行构建 |
| `src/notice.ts`、`src/invariant.ts` | 尽力而为的策略通知与持久化运行时 invariant |
| `benchmarks/` | 示例 fixture benchmark 与 repo-fix benchmark |
| `scripts/lcrd-*` | 运维工具：policy、audit、weight eval、checkpoint registry |
| `training/` | 离线 DPO/LoRA 脚手架与权重路线控制面 |

<a id="quick-start"></a>
## 快速开始

包是私有的，在仓库内开发。用包内 patch 运行源码：

```sh
pnpm dsh --profile headless --patch ./cordis.patch.yml "your task"
pnpm dsh --profile web --patch ./cordis.patch.yml
```

启用策略演化需要 benchmark 和专用门禁 profile。裸 `headless` profile 不挂载 LCRD，生成的 overlay 只按 `id: lcrd` 覆盖；先创建冻结 profile：

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

运维入口：

```sh
pnpm run lcrd:policy -- show
pnpm run lcrd:policy -- noise --benchmark <dir> --profile lcrd-gate
pnpm run lcrd:audit -- --dataset <corpus> --benchmark <dir>
pnpm run lcrd:weight-eval -- --benchmark <dir> --base-runner <cmd> --candidate-runner <cmd>
pnpm run lcrd:checkpoint -- list
```

<a id="trust-boundaries"></a>
## 信任边界

- **skill 是数据。** skill 正文会被扫描并以提示词文本挂载；它不能写门禁结果、指针或审批结果。
- **benchmark 与 reward 是运维可信产物。** 门禁在运行 workspace 内用 `shell: true` 执行 reward。candidate 看不到其他运行的 workspace。
- **holdout 与 hard-out 是部署边界。** 它们必须在模型可读根之外。插件只校验它们不在 skill 根内，无法修复宽松沙箱。
- **promote 是权威决定。** 默认人工审批；auto 不是默认值，且需要统计证据。
- **不新增 session 事件。** 通知和策略变更复用既有 tool-result/additional-context 表面与持久化账本。
- **仅提示词层。** 演化只改 skill 文本，不改模型权重。权重是独立管线；仓库提供 dataset/DPO 导出、评测底座和 checkpoint registry，不提供能更新 API 模型的训练器。

<a id="detailed-architecture"></a>
## 详细架构

[doc/architecture.html](doc/architecture.html) 是完整参考：分层图、请求生命周期、校验器契约、门禁决策树、store 布局、dataset/DPO 管线、权重路线状态、配置表、安全模型和质量门禁。修改 `src/evolve/`、协议文本或 benchmark/storage 契约时先读它。

<a id="model-experience"></a>
## Model Experience

### Root-anchor protocol section

#### What the model sees

每次请求都带有固定的三符号协议 system-prompt 段落，因此在第一次工具调用前就能看到契约和校验规则。

#### Token effect

每次请求都有固定文本；只有协议措辞或 `PROTOCOL_VERSION` 变化时才增长。

#### KV Cache effect

前缀稳定；只有插件版本变化时才改变，因此同一会话跨步骤保持缓存复用。

### The `lcrd_plan` tool

#### What the model sees

工具暴露 `goal`、`stop_condition`、`feasibility` 和 `verifier`。校验表达式是模型写的 JSON 数据；执行校验的程序由插件拥有。

#### Token effect

工具注册期间每次请求都有 schema token。

#### KV Cache effect

schema 稳定；跨步骤不变。

### Learning-round tools (`lcrd_learn` / `lcrd_learn_verify`)

#### What the model sees

开启 `learningEnabled` 后，两个学习工具进入工具列表。`lcrd_learn` 接收问题分析、所需知识、学习方法和评价标准；`lcrd_learn_verify` 接收 learned/evidence。自评失败消耗一次学习轮。

#### Token effect

注册期间参数占用工具列表；每轮把声明、知识获取结果和自评加入历史。

#### KV Cache effect

只追加；每轮内容位于可复用前缀之后，不会让已有缓存失效。

### Rollback, learning, and termination feedback

#### What the model sees

校验失败时结果被阻断，纠正通知给出原因和下一步：换一个计划、达到阈值进入学习模式，或终止后停止。

#### Token effect

每次失败保留一条上下文消息；注入原因文本随数据变化。

#### KV Cache effect

只追加；反馈位于可复用前缀之后。

### The `lcrd_propose` tool (only when `evolveEnabled`)

#### What the model sees

工具暴露 `rationale`、`parent_version` 和 `skills` 数组。描述说明顺序（静态扫描、门禁、审批），并要求在重复被拒想法前阅读返回的提示。模型只写 skill 文本。

#### Token effect

演化开启期间每次请求都有 schema token，加上提案与结果。门禁子进程在独立会话运行，不进入当前对话。

#### KV Cache effect

schema 稳定；提案结果追加在可复用前缀之后。

## Known Limitations and Deferred Work

- 策略演化只改 skill 文本，不改权重；上限取决于更好的提示词能买到什么。
- 学习仅限会话内，不持久化、不跨会话复用；评价标准由模型写，真正的判定是外生重解。
- 门禁默认小样本。`evolveSignificance` 默认 `off`；`bootstrap` 是显式开启项，在样本很小时可能拒绝真实增益。在 `lcrd:policy noise` 证明 `minDetectableGain <= evolveMinGain` 之前保持 `approval`。
- headroom 与 detectability 是两件事：`detectability` 是样本分辨力；`headroom = 1 - baseline.rewardRate` 是最大可能增益。headroom 低于 `evolveMinGain` 时门禁在 candidate 前中止。
- `evolveAdmission: reward` 下缺少 reward 是不完整证据，不是可丢弃的配对；baseline 缺失写 baseline-only 的 `gate-aborted` report，candidate 缺失写完整中止 report。
- 终止率与 speculative-cheat 阈值是零容忍策略规则，不是显著性检验；2 vs 0 可以让门禁拒绝，同时 Fisher 精确检验并不显著。
- 静态检查是启发式，可以被改写规避；真正的防线是“skill 是数据”、外生校验与人工 promote。
- holdout 与 hard-out 的隔离是部署责任；插件只校验它们不在 skill 根内。
- 文件沙箱处于 `workspace-write` 时，task-flow 根必须位于可写工作区内；把 `logDir` 设在工作区下，或在沙箱中放行。
- `assert` 校验器使用受限表达式语法（`src/expr.ts`）；`this`、函数构造、正则字面量、动态 import 和循环不可表达。
- 被拒提案反馈是尽力而为且有界的，只读取最近 20 条；追加/读取失败不会阻塞提案。
- 在线监控在 agent 销毁时折叠运行；一次性进程若未销毁 agent，则观察不到样本。
- `./invariant` 伴生入口观察持久化策略库与运行时 skill 注册集；它不能替代部署级隔离。
- 本包未实现权重训练。DPO 导出与 `training/` 脚手架只是准备；真正更新需要 open-weight 模型和 GPU。

<a id="dev-note"></a>
### 开发备注

`src/anchor.ts` 拥有协议措辞和 `PROTOCOL_VERSION`；措辞变化时提升版本。策略演化在 `src/evolve/`：`store.ts` 负责指针 CAS 与隔离，`holdout.ts` 负责轮换抽样，`static-check.ts` 负责门禁前规则，`gate.ts`/`launch.ts` 负责准入运行，`brief.ts` 负责预审页，`monitor.ts` 负责在线回滚，`invariant.ts` 负责持久化关系检查。完整生命周期与存储契约见 [doc/architecture.html](doc/architecture.html)。
