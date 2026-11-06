---
description: "冻结的 LCRD 门禁 profile bundle:dsh-base 加上 LCRD 插件行,供必须启动候选策略的策略门禁使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-lcrd-gate

[English](README.md) | 中文

## 概述

这个私有 bundle 在 `dsh-base` 之上插入 LCRD 插件行(`id: lcrd`)。用 `dsh-base`、`dsh-headless` 与本 bundle 创建名为 `lcrd-gate` 的 profile;生成的门禁 overlay 随后按 `id: lcrd` 覆盖每次运行的日志目录、策略根、预算与候选版本。bundle 自身不携带插件配置:patch 会整体替换 config 行,因此部署侧生成的 overlay 必须复述完整配置。策略门禁应启动这个 profile,而不是未挂载插件的裸 `headless`。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先创建一次门禁 profile,再把插件的 `evolveGateProfile` 指向它:

```sh
dsh plugin --profile lcrd-gate add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-experimental-lcrd-gate
dsh --profile lcrd-gate "hello"
```

在 LCRD 部署配置中设置 `evolveGateProfile: lcrd-gate`。门禁探针随后启动该 profile,每次生成的 overlay 会以完整配置覆盖 `id: lcrd`。

<a id="model-experience"></a>
## 模型体验

间接地,经由 LCRD 插件行;该协议面向模型的行为由该插件负责。

#### KV Cache effect

无;bundle 只增加一行插件,不产生自己的模型可见内容。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 该包为私有包,不发布到 npm。
- profile 还必须组合 `dsh-base`(`skill` 服务)与 `dsh-headless`(一次性 runner);缺少任何一个都会在启动时失败,而不是产出空的门禁产物。
- bundle 刻意不携带插件配置。后续 patch 会整体替换 `id: lcrd` 的 config,因此每个部署相关字段都必须由生成的 overlay 复述。
- 未发布运行时 invariant 伴生入口:本 bundle 只组合 patch,不持有需要审计的可变关系。

<a id="dev-note"></a>
### 开发备注

无。
