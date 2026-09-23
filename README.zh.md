# @deepseek-ai/dsh-lcrd — LCRD Hard-Isolation

[English](README.md) | 中文

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

## 学习模式(learningEnabled)

连续校验失败达到 `learningThreshold`(默认 5)且学习开启时,直接重试暂停,模型进入学习模式,最多 `maxLearningAttempts`(默认 3)轮:

1. **声明**:调用 `lcrd_learn` 拆分当前无法解决的问题(`problem_analysis`)、需要学习的知识(`knowledge_needed`)、学习方法(`learning_method`,如 web_search/读文件/反思/子代理)与自评标准(`eval_criteria`,模型自己编写)。
2. **学习**:`learningTools` 白名单工具直接放行、不校验;任务工具与 `lcrd_plan` 在学习阶段被拦截。自评通过前必须至少实际调用一次白名单工具,保证轮次有真实获取的知识支撑,而非空口声明。
3. **自评**:调用 `lcrd_learn_verify` 按自写标准判定是否学会。未调用过学习工具时通过判定被拒绝(不消耗轮次);自评未通过计一轮学习失败;达到轮次上限则任务终止转人工。
4. **重解**:自评通过后重新声明 `lcrd_plan` 并执行任务工具,结果仍由外生校验器验证。重解通过即任务完成,学习次数重置;重解失败计一轮学习失败并回到学习模式,失败原因注入下一轮分析。

学习模式下 `maxRetries` 终止被挂起,由学习轮次预算单独管辖;关闭 `learningEnabled` 后插件行为与旧版完全一致(连续失败达到 `maxRetries` 终止)。

**每条新的用户命令都是新的任务边界**:真实用户消息到达时,已声明的计划、失败计数、学习预算与终止状态全部重置,新指令总是从干净的重试预算开始,且必须重新声明计划。插件注入的通知永不重置,只有真实用户输入才重置。

## 配置项

在 `cordis.yml` 的 `lcrd` 条目下加 `config`(默认值即 `cordis.patch.yml` 写入的 shipped 配置):

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
      learningEnabled: true  # 学习模式总开关,shipped 默认 true(见 cordis.patch.yml)
      learningThreshold: 5   # 触发学习的连续校验失败数,默认 5
      maxLearningAttempts: 3 # 学习轮次上限,默认 3
      learningTools:         # 学习阶段白名单工具,默认知识获取工具集
        - web_search
        - read
        - glob
        - grep
        - skill
        - subagent
        - web_fetch
      # fileFlowEnabled: true  # 文件化任务流程开关,默认 false;极简部署(无 web 工具)开启
      # fileFlowPathViolationsMax: 3  # 任务上下文路径越界次数上限,默认 3;达到即判幻觉严重终止
      # workspaceRoot: D:/workspace  # 工作区绝对路径(任务产物落点),默认取 session.header.cwd → 沙箱 workspaceRoot → DSH_CWD → fs 后端工作根
      # fileFlowTools: [str_replace_editor, write, edit]  # 守卫检查的文件工具集,默认极简部署三件套
      # failedCheckConsumesRetry: true  # 断言被引擎判为无效是否消耗任务重试预算,默认 true(关闭则用独立计数限制)
      # rejectPresenceOnly: false       # 声明期拒绝 presence-only 断言,默认 false
      # declarationMaxHoldRate: 0.9     # 声明期探测通过率上限 (0,1],默认不启用
      # datasetExport: off             # 任务结束是否自动导出数据集:off(默认)/ run 结束时追加 dataset.jsonl、trainable.jsonl、needs_review.jsonl 与 dpo.jsonl
      # datasetDir: ./dataset          # 数据集目录,默认取 flow 日志目录同级的 dataset/
      # attributionModule: ./domain-attribution.mjs  # 领域归因 bundle 的模块路径/包名,默认用日志启发式分类学
      # hooksModule: ./policy-hooks.mjs  # 策略 hook 模块的路径/包名,默认关闭(纯协议)
```

重试预算只度量它该度量的东西。默认情况下,声明被引擎否掉(`invalid-condition`、`eval-error`)的一步与"执行了但没满足停止条件"的一步消耗同一份预算,这是既有行为;设 `failedCheckConsumesRetry: false` 后,这类失败改由自己的计数限制(上限同为 `maxRetries`,并以 `invalidChecks` 出现在每条声明的 `context` 里),任务预算就只度量真实步骤结果。用同一批任务跑两种配置即是对照实验。

声明期门禁在计划能够治理任何执行之前就拒绝投机声明。每条 assert 条件必须能编译、引用 `result`/`content`/`isError`,且至少在一个探测输入上为假——与 post-execute 校验器相同的规则,但在 `lcrd_plan` 处检查,因此被拒的声明不会进入事件流或计划表。`rejectPresenceOnly: true` 时声明还必须钉住字面量或读取结构化字段;`declarationMaxHoldRate` 设为 `(0, 1]` 时,声明的最大探测通过率必须低于该上限。插件不判断 `stop_condition` 在语义上是否与校验器表达式一致——该信任边界属于 `checkPlan` 策略 hook,它可对停止条件与检查不一致的声明 `deny` 或 `modify`。校验失败后,原样重申同一失败计划会被拒绝(达到 `maxRetries` 即终止);新的用户命令或之后的一次通过会清除指纹,使合法修订的方法可以返回。

## 文件化任务流程(fileFlowEnabled)

开启 `fileFlowEnabled` 后,固定协议段加入系统提示,模型把任务拆解、子任务文件与进度文件维护在磁盘上,逐个执行子任务,最后统一校验主任务。适用于只有 bash 与字符串替换编辑器的极简部署;标准部署保持关闭,维持纯上下文的逐层回退。协议段由插件注入;文件由模型通过 bash / `str_replace_editor` 自维护。

- **目录**:每次任务使用引擎自动创建的任务目录 `<task-flow 根目录>/taskflow-<uuid>/`——插件在声明计划或首个受守卫文件操作时直接创建(绕过工具沙箱),目录名为 `taskflow-` + agent uuid,刻意与流程日志目录命名(`<goal>-<shortAgentId>`,无目标时 `session-<uuid>`)不同,模型不会混淆两者;碰撞时追加熵后缀。目录初始为空——`task.md`、`subtasks/`、`progress.md` 必须由模型创建,读取日志或目录列表不能代替创建文件。任务目录只存放流程文件——任务产物(脚本、代码、数据)写在工作区,守卫会拒绝写入任务目录的产物。模型不创建、不命名目录;协议段与引擎消息告知确切路径。task-flow 根目录是插件 `lcrd-flow` 日志目录的同级兄弟(默认在插件包根目录,设置 `config.logDir` 时跟随其同级),任务上下文与日志一起持久化,与模型的执行目录无关。`task.md` 记录一行"当前任务 task-slug: <task-slug>",供模型确认自己的任务目录。协议段注入工作区绝对路径(`workspaceRoot` 配置,退回 agent 会话的 validated cwd,再退回部署沙箱的 `workspaceRoot`——权威的 workspace-write 边界,再退回 `DSH_CWD`,再退回 fs 后端自身的工作根)——当部署的工作区与上述来源都不一致时请设置 `workspaceRoot`,任务产物落在你选择的工作区内,而不是环境提示的别名(如 `/repo`)。协议段同时要求模型在执行 shell 命令前先 `cd` 到工作区,确保命令始终在工作区内执行。
- **守卫范围**:硬隔离只作用于任务上下文。插件自行创建并固定任务目录:受守卫工具的首个文件操作触发创建,并以引导性拒绝告知目录路径——协议承诺的"强制第一步"是机械强制,不是建议。任务目录**只存放流程文件**(`task.md`、`progress.md`、`subtasks/*`):向任务目录写入任务产物(脚本、代码、数据)会被引导性拒绝,产物应写在工作区。此后 `task-flow/` 内的所有路径必须停留在该固定目录内:读写其他任务的目录或 `task-flow/` 裸根会被拒绝并计数,达到 `fileFlowPathViolationsMax`(默认 3)即判幻觉严重、任务终止转人工。引导性拒绝不计入违规。被拒绝的执行是终局:拒绝原因以工具错误形式直达模型,且不消耗校验重试。**产物落点强制**:引导完成后,受守卫文件工具的写操作(create/str_replace/insert、`write`、`edit`)必须落在工作区内——工作区之外的写入会被引导性拒绝并指明工作区路径,任务产物保证落在工作区域;读操作(`view`)任意位置放行。`task-flow/` 之外的其他路径默认放行——读操作与 shell 命令没有工作根围栏。受守卫工具为 `fileFlowTools` 配置集(默认 `str_replace_editor`、`write`、`edit`);shell 命令中的路径暂未检查。路径经 fs 服务自身的规范化(realpath 祖先、Windows 盘符大小写)后比较,守卫与文件工具对每个解析身份保持一致。
- **布局**:`task.md`(主任务与验收标准,创建后只读)、`subtasks/`(每个子任务一个文件,含目标与验收条件)、`progress.md`(每个子任务状态 `completed`/`in_progress`/`failed` 与当前指针)。
- **流程**:任务开始时创建目录与文件 → 读 `progress.md` 找第一个未完成子任务 → 读其文件 → 按 LCRD 常规规则执行(`lcrd_plan` + 外生校验,失败退回/学习)→ 在 `progress.md` 标记 `completed` → 下一个子任务。子任务详情留在文件,只在执行时进入上下文,上下文只保留进度与最近失败原因。全部完成按 `task.md` 验收标准统一校验;失败则修改失败子任务文件并重跑。终止时把当前子任务标记 `failed` 并总结已完成部分。

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
| `assert` | `conditions: string[]` | JS 表达式列表,每条可作用于 `result`(结构化值)/`content`(渲染文本)/`isError`,至少引用其一,不可对所有探测输入恒真,全部为真才通过。未绑定、无法编译、恒真的条件在 `lcrd_plan` 声明处即被拒绝,永远不会成为生效检查。工具执行失败直接判 FAIL。**列表不得为空**:`lcrd_plan` 在声明处即拒绝空列表,若空声明仍到达校验器,则按无效检查判 FAIL,而不是放行一切 |
| `python` | `checks: string[]` | Python 表达式列表,由插件固定脚本模板求值(环境注入 `json` 模块),规则同 assert,含「列表不得为空」;超时 kill 判 FAIL |
| `llm` | 无 | 插件固定提示词(注入根锚协议 + goal/stop_condition)的独立会话,温度 0,非 JSON/非 PASS 一律 FAIL |

失败原因带定位:求值失败时附实际 `result`/`content` 类型(形状写错下一轮即可自纠正)、JS `in` 运算符误用有专项提示、否定式条件被判"缺少区分度"时会提示改用肯定式或 `llm` 校验器。

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
调用 lcrd_plan(goal='攻击演示', stop_condition='无', feasibility=true, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取任意文件。预期声明被拒。
```

预期日志:`lcrd_plan:` 拒绝,消息含"必须引用 result"。写 `result === result` 则在声明处以"缺少区分度"被拒。

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
调用 lcrd_plan(goal='测试', stop_condition='无', feasibility=false, verifier 为 {kind:'assert', conditions:['result !== undefined']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

预期日志:`[LCRD] infeasible: tool=read blocked`

### 8. Python 超时

带 `config.pythonTimeoutMs: 2000` 时:

```
调用 lcrd_plan(goal='python 超时', stop_condition='脚本判定', feasibility=true, verifier 为 {kind:'python', checks:['result is not None']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

预期日志:`verify FAIL` reason 为"Python 校验脚本超时"。

### 9. 学习模式触发与自评失败

带 `config.learningThreshold: 2`(缩短触发路径):

```
前两轮声明必然失败的 plan(如 stop_condition='结果等于 12345',verifier 为 assert ['result === 12345'])读取 package.json;第二轮失败后应进入学习模式,调用 lcrd_learn 声明问题分析与学习计划,再用 web_search/read 获取知识,然后调用 lcrd_learn_verify(learned=false)自评未通过。
```

预期日志:`verify FAIL (1/2)` → `verify FAIL (2/2)` → `[LCRD] learning mode entered` → `[LCRD] learn:` → `[LCRD] learn FAIL (1/3)`。

### 10. 学习后重解成功,学习次数重置

承接场景 9 的第三轮:自评通过后重新声明 `lcrd_plan` 读取文件并让校验通过,任务完成,学习次数重置。

```
... 自评通过后,声明 goal='成功读取', stop_condition='读取成功', verifier 为 assert ['result !== undefined'],调用 fs 读取 package.json。
```

预期日志:`learn PASS` → `verify PASS` → `[LCRD] learning success: ... learning budget reset`。

### 11. 学习次数耗尽终止

带 `config.learningThreshold: 2, maxLearningAttempts: 2`:

```
每轮学习后重解都失败,耗尽 2 次学习轮次,任务终止转人工。
```

预期日志:`learning round FAIL (2/2)` → `[LCRD] learning exhausted` → 后续工具调用被拦。

### 12. 关闭学习开关(行为与旧版一致)

带 `config.learningEnabled: false` 时,连续失败达到 `maxRetries` 直接终止,不进入学习模式;`lcrd_learn` / `lcrd_learn_verify` 工具不注册。

## 记录事件与数据集导出

每条记录事件都带信封 —— `seq`(1 起的位置,等于其在 `.jsonl` 中的行号)与 `ts`(ISO-8601),因此无需解析日志文本即可确定顺序与时间。协议语义所依赖的字段一并记录:

| 事件 | 记录字段 |
|---|---|
| `plan` | `strictness` —— 表达式条数、恒真条数、是否含字面量、是否读取结构化值的字段、是否读取渲染文本、是否退化为仅存在性断言、被探测表达式里最大的 hold rate(`1 - maxHoldRate` 即该声明的约束量),以及探测矩阵的聚合读数(`discriminating` / `tautological` / `unbound` / `invalid` / `empty` 表示完全没有表达式;python 与 llm 两种为 `unchecked`);`relaxation` —— 本条声明相对同一 agent 上一条声明放松的轴(`verifier-kind`、`fewer-expressions`、`presence-only`、`lost-structural`、`dropped-literals`、`substring-text`、`weaker-constraint`);`repeatPlan` —— 本条声明逐字重复了上一条,即没有换方法;`context` —— 模型声明时刚刚看到的东西:连续失败计数、学习阶段、上一条判定的通过标记与校验器种类与截断理由,以及引擎已否掉它多少条检查 |
| `tool` | `callId`(可与会话日志的工具记录对齐)、`argsSummary`(参数的截断 JSON)、`resultKind`(失败调用为 `error`,否则为值的 JSON 种类)、`resultSummary`(值的截断 JSON;失败调用为渲染文本)、`errorMessage` 与 `errorCode`(失败调用的消息与其机器可路由错误码,运行时提供时记录) |
| `verdict` | `verifierKind` —— 产生该判定的是哪种校验器;`callId` 与 `tool` —— 被校验的那次调用,判定不再依赖事件顺序来指认对象;`exceptionKind` —— 校验器为何抛错(`invalid-condition`、`eval-error`、`timeout`、`unspawnable`、`exit-code`、`bad-output`、`no-provider`) |

`exceptionKind` 区分「模型的理解」与「模型的活儿」:`invalid-condition` 与 `eval-error` 表示引擎否掉的是模型自己写的检查,这类失败说明不了任务本身;`unspawnable` 与 `no-provider` 属环境或配置失败。`context` 让每条声明自身就是一个 `(状态, 动作)` 样本,无需再 join 会话日志。

`strictness` 在声明时点由与外生校验同一套探测矩阵读出,但只记录、不判定:断言在工具执行前就被度量,判定仍归校验器。探测只覆盖 assert,因为 python 检查需要解释器进程,其开销属于判定而非每次声明。

放松轴是单调的**形状**信号,不是判定:把检查重写成同等严格但形状不同的形式(例如用一条更严的正则替掉两条子串检查)同样会触发 `fewer-expressions` 与 `dropped-literals`。`weaker-constraint` 是量化读数 —— 该声明的最大探测 hold rate 上升了;`repeatPlan` 是机械读数 —— 目标、停止条件与校验器逐字重复。两者都只记录、不拦截:直接拒绝重复会改变轨迹分布,而不是给它打标签。因此每条放松记录都保留前后两套表达式,由读者(人或模型)自行判断这一对,而不是直接采信轴的结论。

`lcrd-flow.jsonl` 是追加写的,与会被重写的快照文件并列,一行一个 JSON 事件:运行被中断时已追加的事件不丢,后续 dump 也不会改写先前回合记录的内容。`lcrd-flow.json` 仍是当前快照,对已完成的运行优先取它;对早于该流存在的运行,导出器回退到快照里的 `events` 数组,并按 `verifierSpec` 重新推导每条 legacy 声明的 `strictness`,使新旧运行进入同一数据集、使用同一套词汇。

meta 中的 `anchor_digest` 是任务首条用户消息的摘要(整条消息,含非文本块),因此共享同一根锚的运行可归为一组,而不必把锚文本复制进每个产物。`schema_version` 标明产物词汇版本,`events_file` 给出事件流文件名。快照中被回填的 `tb_final_reward` / `root_cause_hint` 会在后续 dump 中保留,因为 recorder 先读取上一份快照再重写;构造参数仍然优先于文件。

`run.json` 记录让 run 之间可比的东西:插件版本、注入协议版本(`PROTOCOL_VERSION`,锚点文本或纠正文案变化时递增)、插件挂载时的配置、模型与 provider、平台与 Node 版本、会话工作目录、起止时间、最终判定,以及该 run 的状态(`terminated` / `completed` / `incomplete`)。同样的插件/协议/模型/平台身份也写进快照 meta,单个文件即可回答「这是哪个版本记录的」。

导出语料:

```sh
pnpm run lcrd:dataset                                   # default flow root and output directory
pnpm run lcrd:dataset -- --root <flow root> --out <dir>  # explicit locations
```

它会写出四个文件:`dataset.jsonl`(每个协议事件一条记录,含 `step`、`ts`、用于切分的 `task_group`、失败判定的 `failureClass`、`infraFailure` 标记与全部已记录字段)、`relaxations.jsonl`(每条「失败后放松」的声明一条记录,携带连续失败计数、该失败的类别与异常种类、前一个结果的种类、前后两套表达式、放松轴,以及 `cause` —— 校验因真实值抛错(`type-adaptation`,重写形式本属预期)、在"活儿被判未完成"之后强度下降(`substance-dropped`),否则 `undetermined`)、`runs.jsonl`(每个 run 一行,内容为 `run.json` 元数据;legacy run 则给出快照能提供的信息)、`anchor-judge.jsonl`(每个带锚点文本的 run 一条请求,把锚点与该 run 的每条声明配对,交给判定方打 within/outside)。控制台报告打印判断语料价值所需的分组:任务分组及其重复数量、按模型/平台/交互模式的 run 分布、带 `run.json` 的 run 数量、校验器种类、通过/失败计数、失败类别、重复声明数、放松轴与成因、按连续失败次数分布的放松,以及锚点判定请求数。被判为 `infra-error` 的判定单独计数,并从通过/失败与失败类别统计中排除,因为它们度量的是机器而非模型。

锚点判定留在导出器之外:把判定结果写成 JSONL(`{"run_id": …, "step": …, "label": …}`)再传回即可合并到声明上:

```sh
pnpm run lcrd:dataset -- --anchor-labels <labels.jsonl>
```

### 对话结束后自动导出(datasetExport)

把 `datasetExport` 设为 `run` 后,插件会在任务结束(agent 释放)时把该 run 的行追加到同样这四个文件,因此**一次对话结束就直接产出可训练数据,不需要额外命令**:

```sh
pnpm run lcrd:pipeline          # one incremental pass over every settled, not-yet-exported run
pnpm run lcrd:watch             # poll every 10s and export each run as it finishes (Ctrl+C to stop)
pnpm run lcrd:pipeline -- --all # rebuild every file from scratch
pnpm run lcrd:dataset && pnpm run lcrd:dpo   # or export the corpus in two separate steps
```

进程内导出写 `dataset.jsonl`、`relaxations.jsonl`、`runs.jsonl`、`dpo.jsonl`,并按可训练性把每条数据集行分流:`trainable.jsonl` 存放标签由引擎确定性判定的行(上下文行、通过判定、以及 `assertion-invalid` 这类检查被拒),`needs_review.jsonl` 存放标签需要人类或大模型判别的行(`honest-mismatch`、`tool-isError`、`unclassified`),而环境/校验基础设施类失败(`infra-error`、`python-timeout`、`llm-bad-output`)只出现在全量流里——下游训练直接消费分流文件,而不是混入歧义标签的语料。每行都携带 `trainability` 标签,因此分流无需重新推导即可复现。流水线额外维护 `.pipeline-state.json`(每个 run 的指纹),因此重复执行**不会重复写入**,而已导出过的 run 若产物发生变化会再次导出。run 只有在产物"静止"后才会被收取(`--settle`,默认 15 秒;watch 脚本用 5 秒)。文件级导出还需要会话日志,进程内导出不需要。

DPO 的 `chosen` 是**构造**的:它把放松前的那套检查装回模型自己的声明,每条样本都在 meta 里标 `"synthetic": true`、`repair` 名称与被反转的轴。`prompt` 是声明之前的模型可见转录(user、assistant 文本、工具调用、工具结果、以及标了 `source=plugin` 的引擎通知),不含系统提示。

### 按任务视图(`lcrd:view`)

共享数据集文件是跨全部任务的单一 append-only 语料。`pnpm run lcrd:view` 把它们投影到 `dataset/by-task/<task_group>/`,每个任务组一个目录、文件名与共享文件相同,消费方无需过滤即可读取单个任务族:

```sh
pnpm run lcrd:view                                 # default dataset dir → dataset/by-task/
pnpm run lcrd:view -- --dataset <dir> --out <dir>  # explicit locations
```

自带 `task_group` 的行(`dataset.jsonl`、`trainable.jsonl`、`needs_review.jsonl`、`runs.jsonl`)直接分组。`relaxations.jsonl`、`anchor-judge.jsonl` 与 `dpo.jsonl`(经 `meta.run_id`)通过「同时携带 `run_id` 与 `task_group` 的行」构成的 run 表回连;run 表中查不到的行落入 `_unknown/` 而非被丢弃,join 缺口因此始终可见。每次运行整树重建 `by-task/`,离开共享文件的组不会残留;共享文件本身只被读取——写入方(`datasetExport`、`lcrd:dataset`、`lcrd:pipeline`)不受影响。组名被净化为单个路径段;会逃出视图的名字(`..`、空串)落入 `_unknown/`。`--out` 等于数据集目录或其祖先时视图拒绝执行,因为重建会删除它所读取的源。

### 可插拔归因(`attributionModule` / `--attribution`)

默认归因是 `dataset.ts` 里的日志启发式分类学:它把判定的记录原因与异常种类映射为 `FailureClass`、把放松的声明映射为 `RelaxationCause`、把每一行映射为 `Trainability`。专业任务族往往有自己的一套失败词汇——能更准确地命名其任务哪里出错的领域分类器。归因钩子让这类领域可以整体替换分类学,而无需 fork 插件:

```js
// domain-attribution.mjs — default export, or export an object without `default`
export default {
  classifyFailure(reason, exceptionKind) { /* domain rules */ },
  classifyRelaxationCause(failureClass, failureExceptionKind, axes) { /* domain rules */ },
  classifyTrainability(row) { /* domain rules */ },
}
```

- **进程内**:把 `config.attributionModule` 设为模块路径(相对路径按进程工作目录解析)或包名。插件在启动时加载并校验它,并把结果传给每个 `FlowRecorder`,因此 `datasetExport: run` 产出的行携带领域标签。
- **离线语料**:`pnpm run lcrd:dataset -- --attribution ./domain-attribution.mjs` 与 `pnpm run lcrd:pipeline -- --attribution <module>` 把同一套 bundle 送进 `buildRun`/`exportDataset`,替换每个 run 重新推导的失败与放松分类。
- bundle 必须导出全部三个函数;不完整或非法的导出会在加载时响亮失败(`loadAttribution`)。领域分类器读取的记录字段不变——归因是已记录行的纯函数,领域 bundle 永远不会接触实时工具结果或会话。

### 策略 hook(`hooksModule`)

部署方可以通过一个配置模块检查 LCRD 自己声明的计划以及每个已校验的工具结果。hook 是受信的部署代码;它看不到 harness 已记录的工具参数,也不写 harness 状态——LCRD 始终是其计划、预算与终止状态的唯一写入者。

```js
// policy-hooks.mjs — either check may be omitted
export default {
  checkPlan({ agent, plan, callId, signal }) {
    // return { kind: 'allow' }
    // return { kind: 'modify', plan: { ...plan, verifier: { kind: 'llm' } } }
    // return { kind: 'deny', reason: 'out of scope' }
  },
  checkResult({ agent, plan, tool, callId, result, verdict, signal }) {
    // return { kind: 'allow' }
    // return { kind: 'block', reason: 'result leaks a secret' }
    // return { kind: 'terminate', reason: 'policy violation' }
  },
}
```

- **两个检查点。** `checkPlan` 在声明完成、尚未治理执行之前运行;`checkResult` 在外生校验器产出判定之后运行。两者都可以是 async,并应观察该调用的 `signal`。
- **替换计划对模型静默。** `lcrd_plan` 的结果仍回显声明内容,而流程产物记录生效计划、校验器运行生效检查。有两条可见后果:校验失败时反馈会引用生效条件;若替换把 `feasibility` 改为 false,会走既有 infeasible 分支并告知模型。必须不暴露自身检查的领域可选用 `llm` 校验器,其固定提示词拥有反馈文本。
- **替换计划同样要过声明期门禁。** 策略可以改写计划,但条件被引擎拒绝的替换会以 `engine rejects` 响亮失败,hook 无法装入未经检查的检查。
- **停止条件与校验器的一致性归 hook 判定。** 核心不解析 `stop_condition` 语义;看到停止条件与校验器表达式不一致的 `checkPlan` 可以 `deny` 或 `modify`。
- **拦截不消耗任务重试预算。** `deny`、`block` 与抛错的 hook 独立计数,以 `maxRetries` 为上限,达到即终止转人工;新的用户命令随其他任务状态一起重置计数。`deny` 还会清除更早的计划,因此被拒绝的声明无法通过沿用上一条计划绕过。
- **非法的替换计划响亮失败**;抛错的 hook 在上限以内向上传播(模型看到 hook 的错误),达到上限即终止。
- hook 看到的结果是 LCRD 校验器所见的那一版;更靠后的 `tools/post-execute` 监听器仍可能在接受结果之后对其进行转换。

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
| `learning_enabled` | 学习模式是否开启 |
| `learning_threshold` | 触发学习的连续失败数 |
| `learning_attempts_max` | 学习轮次上限 |
| `learning_attempts_consumed` | 学习成功前消耗的失败轮次(成功后归零) |
| `learning_success` | 是否通过学习后重解完成任务 |
| `final_verdict` | LCRD 内部最终结果 `pass`/`fail`/`terminated` |
| `tb_final_reward` | 沙箱客观打分(0/1);harness 内拿不到,默认 `null`,由外部评测脚本事后按 `task_id` 回填 |
| `root_cause_hint` | 简短根因标签,可选,默认 `null`,可由外部评测回填 |
| `events` | 完整事件数组(plan/tool/verdict/intercept),每条带 `seq`/`ts` 信封 |
| `schema_version` | 产物词汇版本;记录字段语义变化时递增 |
| `events_file` | 与快照并列的追加式事件流文件名(`lcrd-flow.jsonl`) |
| `anchor_digest` | 任务首条用户消息(根锚)的摘要;记录前为 null |
| `relaxation_count` | 相对上一条声明放松了校验强度的声明条数 |
| `repeat_plan_count` | 逐字重复上一条声明的条数 |
| `anchor_excerpt` | 首条用户消息(根锚)的截断文本,供离线锚点判定 |
| `plugin_version` / `protocol_version` | 记录该 run 的版本与注入协议版本 |
| `model` / `provider` | agent 运行所用的模型与 provider |
| `platform` | 记录该 run 的平台 |

流程图中每个 `lcrd_plan` 声明、工具调用、校验判定(PASS/FAIL n/3)、学习轮次(lcrd_learn / learn PASS|FAIL n/3)、拦截(missing plan / infeasible / terminated)按执行顺序串联,最终节点标注"会话结束"或"任务终止转人工"。

## 判定标准

观察控制台 `[LCRD]` 日志:plan 声明、verify PASS/FAIL(n/maxRetries)、learning mode entered、learn/learn PASS|FAIL(n/maxLearningAttempts)、learning success、learning exhausted、terminated、missing plan、infeasible、blocked。

## Model Experience

### 根锚协议段

#### 模型看到什么

每次请求都携带下面固定的协议文本作为系统提示段,模型在第一次工具调用前始终看到三符号契约与校验器规则。

##### 协议文本

```markdown
[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result,必须引用 result 且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
5. 根锚内部存在矛盾时,你可以在顶层边界之内权衡;任何输出不得违背根锚约束。
```

#### Token 影响

每次请求的固定文本;仅当锚文本本身变化时增长。

#### KV Cache 影响

系统提示前缀稳定;该段只随插件版本变化,因此在会话各步骤间保持缓存复用。

### `lcrd_plan` 工具 schema

#### 模型看到什么

工具出现在工具列表中,带 goal / stop_condition / feasibility / verifier 参数。校验器表达式列表是模型提供的数据;校验程序本身归插件所有,模型无法给自己写通过。

#### Token 影响

工具注册期间每次请求都携带 schema tokens。

#### KV Cache 影响

schema 稳定,跨步骤不变。

### 学习轮次工具(`lcrd_learn` / `lcrd_learn_verify`)

#### 模型看到什么

开启 `learningEnabled` 时,两个学习工具加入工具列表。`lcrd_learn` 接受 problem_analysis / knowledge_needed / learning_method / eval_criteria;`lcrd_learn_verify` 接受 learned / evidence。评价标准由模型自写,自评未通过消耗一次学习轮次。

#### Token 影响

注册期间每次请求都携带 schema tokens;每轮把声明、知识获取工具结果与自评加入历史。

#### KV Cache 影响

只追加;每轮内容跟在可复用前缀之后,不使既有缓存条目失效。

### 退回、学习与终止反馈

#### 模型看到什么

校验失败时插件拦截结果并注入纠正通知,说明原因与要求的下一步(重新声明不同计划;达到阈值进入学习模式;终止后停止并汇报)。

#### Token 影响

每次失败保留一条上下文消息;注入的原因文本随数据变化。

#### KV Cache 影响

只追加;反馈跟在可复用前缀之后。

## Known Limitations and Deferred Work

- 文件沙箱:文件沙箱处于 `workspace-write` 模式时,task-flow 根目录必须位于沙箱可写工作区内——否则模型经工具写入流程文件会被沙箱拒绝(插件自身的目录创建绕过沙箱,但模型对 `task.md`/`progress.md` 的更新无法绕过)。将 `logDir` 设在工作区下使 task-flow 根目录随之迁移,或配置沙箱放行该目录。
- 学习是会话内的:获取的知识只进入当前上下文,不落盘、不跨会话复用;学习评价标准由模型自写,插件只计数,真正判定学习效果的是重解是否通过外生校验器。
- 学习模式会增加 API 调用与 token 消耗(每轮含声明、知识获取与自评);`maxLearningAttempts` 与 `learningEnabled` 是预算与开关护栏。
- LLM 校验器每次校验花费一次独立 API 调用;verifierModel 默认与主模型相同(隔离性仅靠独立会话与固定提示词,未做跨账号隔离)。
- `assert` 校验器执行模型提供的 JS 表达式,表达式在 Node `Function` 沙箱内求值,仅用于校验数据,不提供任意代码能力。
- 流程导出在每个协议步骤(声明计划、每次工具校验)、每轮对话结束时(`turn/end` 会话事件)、agent 销毁时(`agent/disposed` 全局事件)以及进程退出时(`process.exit`)同步写盘;长驻进程内对话进行中即可看到最新导出。进程被强杀(SIGKILL)时可能缺最后一段事件(尽力而为)。
- Python 校验器依赖系统 `python` 命令;Windows 下需存在可执行解释器。