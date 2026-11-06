---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-lcrd-source-attribution

[English](2026-10-20-lcrd-source-attribution.md) | 中文

## 概述

新增 `lcrd-hard-isolation` 消息来源类型，供可选的 LCRD 硬隔离插件标注其协议通知、回滚反馈和校验请求。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-lcrd-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "ce1c6a84f1aada8c98e3c99b0f4cefc62c88b8bf8129072206b042161e16671e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "10661f8b7df8f6abdc7ce0fa2de7aa8620f9b10543fcdfe46bc442b59a8c908f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "c71ece7d39baee99707b96612e78cd7ff38367810c7924349b354235af9f50fc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d279ef72221348d5941cd38afc39d05a2707af4c74bdd2b4fe5607947607fe02"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该类型限定为仅归因：它是现有 user 与 developer 消息来源联合类型上的可选增量分支。未加载该插件的读取方本就保留未知来源类型及其 JSON 元数据，该类型不施加校验、回放或授权要求。产出方自己的流程记录器读取该类型来标注已记录事件；其余读取方无需该投影也能推导出相同消息。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/lcrd：373 个测试通过，包含真实组合的 Loader 启动测试。pnpm run verify-persistence-catalog 与 pnpm run verify-persistence-changes 在本记录下通过。

<a id="dev-note"></a>
## 开发备注

无。
