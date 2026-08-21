# @deepseek-ai/dsh-lcrd — LCRD Hard-Isolation

LCRD(长链推理漂移)硬隔离插件:把三符号协议(根锚 / 停止符 / 退回符)映射到 harness 扩展点,执行结果由外生校验器独立验证,校验失败退回重试,连续失败超过预算后任务终止转人工。每轮对话结束后即刷新导出 Mermaid 流程图、Markdown 报告和 JSON 事件时间线,供市面工具查看。

## 使用方式

作为 bundle 安装到 profile(安装后自动成为 profile 层,无需 `--patch`):

```sh
pnpm dsh plugin add @deepseek-ai/dsh-lcrd
pnpm dsh --profile headless "你的任务"
```

仓库内开发时(源码运行,免构建),直接叠加包内 patch:

```sh
pnpm dsh --profile headless --patch ./packages/guard/lcrd/cordis.patch.yml "你的任务"
pnpm dsh --profile web --patch ./packages/guard/lcrd/cordis.patch.yml   # 交互:浏览器打开 http://127.0.0.1:3080
```

前置条件:根目录 `.env` 含 `DEEPSEEK_API_KEY`。

协议强制流程:模型每次调用工具前必须先调用 `lcrd_plan` 声明子任务计划(goal / stop_condition / feasibility / verifier);工具执行后,由所选校验器独立验证,校验失败则结果被拒绝并退回重试,连续失败达到上限后任务终止转人工。

## 配置项

在 `cordis.yml` 的 `lcrd` 条目下加 `config`:

```yaml
- insert:
  - id: lcrd
    name: '@deepseek-ai/dsh-lcrd'
    config:
      maxRetries: 3          # 连续失败上限,默认 3
      pythonCommand: python  # python 校验器解释器,默认 python
      pythonTimeoutMs: 30000 # python 校验超时后 kill,默认 30000
      verifierModel: deepseek-chat  # LLM 校验器独立模型,默认同主模型
      logDir: ./lcrd-flow    # 流程日志目录,默认插件包目录下的 lcrd-flow/
      interaction: auto      # 交互模式: auto/auth/manual,默认 manual
```

## 交互模式(interaction)

控制 agent 遇到"需要人工"的情况(审批提示 + `ask_user_question` 工具)时的行为:

| 值 | 含义 | 适用场景 |
|---|---|---|
| `auto` | 无人值守自主决策:需审批的自动拒绝;`ask_user_question` 自动返回"请自主判断"并继续,不卡住 | 评测、批处理、CI |
| `auth` | 审批交给人工应答者,`ask_user_question` 保持交互 | 半自动,需要人工把关 |
| `manual`(默认) | 审批与提问都交给配置的 UI 应答者 | 交互式使用 |

`auto` 模式下模型也会在系统提示里被引导"不要请求权限升级",所以多数情况下它会自主决策而不发起提问;若仍尝试提问,插件会拦截并自动应答,保证会话不挂起。

## 校验器三选一

| kind | 模型提供的参数 | 校验方式 |
|---|---|---|
| `assert` | `conditions: string[]` | JS 表达式列表,每条作用于 `result`,必须引用 `result` 且不可对所有探测输入恒真,全部为真才通过 |
| `python` | `checks: string[]` | Python 表达式列表,由插件固定脚本模板求值,规则同 assert;超时 kill 判 FAIL |
| `llm` | 无 | 插件固定提示词(注入根锚协议 + goal/stop_condition)的独立会话,温度 0,非 JSON/非 PASS 一律 FAIL |

## 测试例子

### 1. 正常链路(PASS 放行)

```
调用 lcrd_plan(goal='确认文件存在', stop_condition='读取成功', feasibility=true, verifier 为 {kind:'assert', conditions:['result !== undefined']}),然后调用 fs 工具读取 D:/deepseek/deepseek-harness/package.json,校验通过后回复'通过'并停止。
```

预期日志:`[LCRD] plan:` → `[LCRD] verify PASS: tool=read verifier=assert`

### 2. 校验失败退回(FAIL → 重试 → 终止)

```
连续 3 轮,每轮调用 lcrd_plan(goal='失败演示', stop_condition='结果等于 12345', feasibility=true, verifier 为 {kind:'assert', conditions:['result === 12345']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。3 轮失败后任务终止,复述终止反馈并停止。
```

预期日志:`verify FAIL (1/3)` → `(2/3)` → `(3/3)` → `[LCRD] terminated`(之后一切工具调用被拦,含 lcrd_plan)

### 3. 恒真条件攻击(已封堵)

```
调用 lcrd_plan(goal='攻击演示', stop_condition='无', feasibility=true, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取任意文件。预期校验被拒。
```

预期日志:`verify FAIL` reason 为"断言必须引用 result"。若写 `result === result` 则 reason 为"缺少区分度"。

### 4. Python 校验器

```
调用 lcrd_plan(goal='python 校验', stop_condition='结果非空', feasibility=true, verifier 为 {kind:'python', checks:['result is not None']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json,通过后回复'通过'。
```

预期日志:`[LCRD] verify PASS: tool=read verifier=python`

### 5. LLM 校验器

```
调用 lcrd_plan(goal='LLM 校验', stop_condition='读取结果非空', feasibility=true, verifier 为 {kind:'llm'}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json,通过后回复'通过'。
```

预期日志:`[LCRD] verify PASS: tool=read verifier=llm`(多花一次独立 API 调用)

### 6. 不声明计划直接调工具

```
不要调用 lcrd_plan,直接用 fs 工具读取 D:/deepseek/deepseek-harness/package.json,收到拒绝反馈后复述并停止。
```

预期日志:`[LCRD] missing plan: tool=read blocked`

### 7. 不可行计划(feasibility=false)

```
调用 lcrd_plan(goal='测试', stop_condition='无', feasibility=false, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

预期日志:`[LCRD] infeasible: tool=read blocked`

### 8. Python 超时

带 `config.pythonTimeoutMs: 2000` 时:

```
调用 lcrd_plan(goal='python 超时', stop_condition='脚本判定', feasibility=true, verifier 为 {kind:'python', checks:['result is not None']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

预期日志:`verify FAIL` reason 为"Python 校验脚本超时"。

## 执行流程导出

插件把**屏幕日志与流程导出**按任务写入日志目录:每个任务一个子文件夹,子文件夹名用"任务 goal 前缀 + agent id 的短哈希"(如 `在当前目录创建…-a1b2c3d4`),保证同名任务的不同会话永不共享目录、后一轮不会覆盖前一轮。导出文件在**每个协议步骤后(声明计划、每次工具校验)、每轮对话结束、agent 销毁、进程退出**时都会重写,长驻进程内对话进行中即可看到最新的 md/mmd/json。默认目录为插件包目录下的 `lcrd-flow/`:

```
<logDir>/                     ← 默认插件包目录 lcrd-flow/;可用 config.logDir 覆盖
  <goal前缀>-<短哈希>/
    lcrd-flow.log             ← 屏幕日志(plan / verify PASS/FAIL / terminated / blocked),带时间戳
    lcrd-flow.md              ← Markdown 报告:结果状态 + Mermaid 流程图 + 事件时间线
    lcrd-flow.mmd             ← 纯 Mermaid 流程图源码
    lcrd-flow.json            ← 汇总元数据 + 完整事件时间线(plan/tool/verdict/intercept)
```

- `.md` 用 VS Code(装 Mermaid 插件)、GitHub、Typora 查看;`.mmd` 可拖进 mermaid.live;`.json` 供程序化分析。
- `config.logDir` 指定日志根目录(可放任意位置,如 `C:/logs/lcrd`);未配置时用插件包目录下的 `lcrd-flow/`。

### lcrd-flow.json 结构

`.json` 是"轻量汇总元数据 + 完整事件"的机器统计格式:顶部是每任务一行的汇总标记(供批量统计、发现异常后跳去 `.md` 看详情),`events` 是完整事件数组。字段:

| 字段 | 含义 |
|---|---|
| `session_id` | 会话/agent id(索引键) |
| `task_id` | 任务标识(goal 生成的 slug;未记录到 goal 时为 agent id) |
| `md_file` | 对应详细日志 `lcrd-flow.md` |
| `human_interaction_mode` | 本次运行模式 `auto`/`auth`/`manual` |
| `hit_ask_intercepted` | 是否拦截了模型提问(ask_user_question) |
| `lcrd_retry_consumed` | 消耗的内部重试次数 |
| `lcrd_retry_max` | 配置的最大重试数 |
| `goal_changed_times` / `stop_changed_times` / `verifier_changed_times` | 契约构件(goal/停止条件/校验器)被修改的次数(漂移核心指标) |
| `has_verifier_exception` | 是否出现校验器异常(语法/求值失败/超时/无法启动) |
| `final_verdict` | LCRD 内部最终结果 `pass`/`fail`/`terminated` |
| `tb_final_reward` | 沙箱客观打分(0/1);harness 内拿不到,默认 `null`,由外部评测脚本事后按 `task_id` 回填 |
| `root_cause_hint` | 简短根因标签,可选,默认 `null`,可由外部评测回填 |
| `events` | 完整事件数组(plan/tool/verdict/intercept) |

流程图中每个 `lcrd_plan` 声明、工具调用、校验判定(PASS/FAIL n/3)、拦截(missing plan / infeasible / terminated)按执行顺序串联,最终节点标注"会话结束"或"任务终止转人工"。

## 判定标准

观察控制台 `[LCRD]` 日志:plan 声明、verify PASS/FAIL(n/maxRetries)、terminated、missing plan、infeasible、blocked。

## Known Limitations and Deferred Work

- LLM 校验器每次校验花费一次独立 API 调用;verifierModel 默认与主模型相同(隔离性仅靠独立会话与固定提示词,未做跨账号隔离)。
- `assert` 校验器执行模型提供的 JS 表达式,表达式在 Node `Function` 沙箱内求值,仅用于校验数据,不提供任意代码能力。
- 流程导出在每个协议步骤(声明计划、每次工具校验)、每轮对话结束时(`turn/end` 会话事件)、agent 销毁时(`agent/disposed` 全局事件)以及进程退出时(`process.exit`)同步写盘;长驻进程内对话进行中即可看到最新导出。进程被强杀(SIGKILL)时可能缺最后一段事件(尽力而为)。
- Python 校验器依赖系统 `python` 命令;Windows 下需存在可执行解释器。