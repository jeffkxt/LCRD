# @deepseek-ai/dsh-lcrd — LCRD Hard-Isolation

English | [中文](README.zh.md)

The LCRD (long-chain reasoning drift) hard-isolation plugin maps the three-symbol protocol (root anchor / stop symbol / rollback symbol) onto the harness extension points: every tool result is verified by an exogenous verifier independent of the model, failures roll back and retry, and consecutive failures past the budget terminate the task for human review. A refreshed Mermaid flowchart, Markdown report, and JSON event timeline are exported after every completed turn for third-party viewers.

## Usage

Install as a bundle into a profile (it becomes a profile layer automatically, no `--patch` needed):

```sh
pnpm dsh plugin add @deepseek-ai/dsh-lcrd
pnpm dsh --profile headless "你的任务"
```

During in-repo development (source run, no build), overlay the in-package patch:

```sh
pnpm dsh --profile headless --patch ./packages/guard/lcrd/cordis.patch.yml "你的任务"
pnpm dsh --profile web --patch ./packages/guard/lcrd/cordis.patch.yml   # 交互:浏览器打开 http://127.0.0.1:3080
```

Prerequisite: the root `.env` holds `DEEPSEEK_API_KEY`.

Protocol-enforced flow: before every tool call the model must call `lcrd_plan` to declare its subtask plan (goal / stop_condition / feasibility / verifier); after the tool runs, the chosen verifier checks the result independently. A failed verification rejects the result and rolls back to retry; consecutive failures past the budget terminate the task for human review.

## Learning mode (learningEnabled)

When consecutive verifier failures reach `learningThreshold` (default 5) and learning is enabled, direct retries pause and the model enters learning mode for at most `maxLearningAttempts` (default 3) rounds:

1. **Declare**: call `lcrd_learn` to break down the currently unsolvable problem (`problem_analysis`), the knowledge needed (`knowledge_needed`), the learning method (`learning_method`, e.g. web_search / reading files / reflection / delegation), and the self-evaluation criteria (`eval_criteria`, authored by the model).
2. **Learn**: `learningTools` allowlist tools pass without a plan or verifier; task tools and `lcrd_plan` are blocked during the learn phase. At least one allowlist tool must actually run before the round can pass self-evaluation, so a round is backed by acquired knowledge rather than a bare claim.
3. **Self-evaluate**: call `lcrd_learn_verify` to judge against the self-authored criteria. Without a prior learning-tool call the pass verdict is refused (without consuming a round); a failed self-evaluation consumes one learning round; at the round budget the task terminates for human review.
4. **Re-solve**: after a passed self-evaluation, re-declare `lcrd_plan` and run task tools; results still run the exogenous verifier. A passed re-solve completes the task and resets the learning budget; a failed one consumes a learning round and returns to learning mode with the failure reason injected into the next analysis.

During learning mode the `maxRetries` termination is suspended and governed solely by the learning-round budget; disabling `learningEnabled` keeps the plugin exactly on the legacy behavior (consecutive failures past `maxRetries` terminate).

**Every new user command is a fresh task boundary**: the declared plan, the failure count, the learning budget, and any termination state reset when a real user message arrives, so a new instruction always starts from a clean retry budget and must re-declare its plan. Plugin-injected notices never reset; only actual user input does.

## Config

Add `config` under the `lcrd` entry in `cordis.yml` (defaults are the shipped configuration written in `cordis.patch.yml`):

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
```

## Interaction mode (interaction)

Controls how the agent behaves when human interaction is requested (approval prompts plus the `ask_user_question` tool):

| Value | Meaning | Use case |
|---|---|---|
| `auto` | Unattended autonomous decisions: approval requests auto-reject; `ask_user_question` auto-returns "decide on your own" and continues, never stalling | Evaluation, batch processing, CI |
| `auth` | Approval prompts go to a human answerer; `ask_user_question` stays interactive | Semi-automatic, human gate needed |
| `manual` (default) | Both approval and questions go to the configured UI answerers | Interactive use |

In `auto` mode the system prompt also steers the model not to request permission escalation, so it usually decides autonomously without asking; if it still tries to ask, the plugin intercepts and auto-answers, keeping the session unblocked.

## Verifier: three choices

| kind | Model-supplied arguments | Verification |
|---|---|---|
| `assert` | `conditions: string[]` | A list of JS expressions over `result`; each must reference `result` and must not hold on every probe input; all must hold to pass |
| `python` | `checks: string[]` | A list of Python expressions over `result`, evaluated by the plugin-fixed script template; same rules as assert; timeout kills and fails |
| `llm` | none | An independent session with a plugin-fixed prompt (root-anchor protocol + goal/stop_condition), temperature 0; non-JSON or non-PASS always fails |

## Test scenarios

### 1. Normal path (PASS lets through)

```
调用 lcrd_plan(goal='确认文件存在', stop_condition='读取成功', feasibility=true, verifier 为 {kind:'assert', conditions:['result !== undefined']}),然后调用 fs 工具读取 D:/deepseek/deepseek-harness/package.json,校验通过后回复'通过'并停止。
```

Expected logs: `[LCRD] plan:` → `[LCRD] verify PASS: tool=read verifier=assert`

### 2. Verification failure rollback (FAIL → retry → terminate)

```
连续 3 轮,每轮调用 lcrd_plan(goal='失败演示', stop_condition='结果等于 12345', feasibility=true, verifier 为 {kind:'assert', conditions:['result === 12345']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。3 轮失败后任务终止,复述终止反馈并停止。
```

Expected logs: `verify FAIL (1/3)` → `(2/3)` → `(3/3)` → `[LCRD] terminated` (all later tool calls blocked, including lcrd_plan)

### 3. Always-true condition attack (blocked)

```
调用 lcrd_plan(goal='攻击演示', stop_condition='无', feasibility=true, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取任意文件。预期校验被拒。
```

Expected log: `verify FAIL` reason is "断言必须引用 result". Writing `result === result` yields reason "缺少区分度".

### 4. Python verifier

```
调用 lcrd_plan(goal='python 校验', stop_condition='结果非空', feasibility=true, verifier 为 {kind:'python', checks:['result is not None']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json,通过后回复'通过'。
```

Expected log: `[LCRD] verify PASS: tool=read verifier=python`

### 5. LLM verifier

```
调用 lcrd_plan(goal='LLM 校验', stop_condition='读取结果非空', feasibility=true, verifier 为 {kind:'llm'}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json,通过后回复'通过'。
```

Expected log: `[LCRD] verify PASS: tool=read verifier=llm` (costs one extra independent API call)

### 6. Calling a tool without declaring a plan

```
不要调用 lcrd_plan,直接用 fs 工具读取 D:/deepseek/deepseek-harness/package.json,收到拒绝反馈后复述并停止。
```

Expected log: `[LCRD] missing plan: tool=read blocked`

### 7. Infeasible plan (feasibility=false)

```
调用 lcrd_plan(goal='测试', stop_condition='无', feasibility=false, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

Expected log: `[LCRD] infeasible: tool=read blocked`

### 8. Python timeout

With `config.pythonTimeoutMs: 2000`:

```
调用 lcrd_plan(goal='python 超时', stop_condition='脚本判定', feasibility=true, verifier 为 {kind:'python', checks:['result is not None']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
```

Expected log: `verify FAIL` reason is "Python 校验脚本超时".

### 9. Learning-mode trigger and failed self-evaluation

With `config.learningThreshold: 2` (shortened trigger path):

```
前两轮声明必然失败的 plan(如 stop_condition='结果等于 12345',verifier 为 assert ['result === 12345'])读取 package.json;第二轮失败后应进入学习模式,调用 lcrd_learn 声明问题分析与学习计划,再用 web_search/read 获取知识,然后调用 lcrd_learn_verify(learned=false)自评未通过。
```

Expected logs: `verify FAIL (1/2)` → `verify FAIL (2/2)` → `[LCRD] learning mode entered` → `[LCRD] learn:` → `[LCRD] learn FAIL (1/3)`.

### 10. Post-learning re-solve success resets the budget

Continuing scenario 9's third round: after the passed self-evaluation, re-declare `lcrd_plan`, read the file, and let verification pass; the task completes and the learning budget resets.

```
... 自评通过后,声明 goal='成功读取', stop_condition='读取成功', verifier 为 assert ['result !== undefined'],调用 fs 读取 package.json。
```

Expected logs: `learn PASS` → `verify PASS` → `[LCRD] learning success: ... learning budget reset`.

### 11. Learning budget exhausted terminates

With `config.learningThreshold: 2, maxLearningAttempts: 2`:

```
每轮学习后重解都失败,耗尽 2 次学习轮次,任务终止转人工。
```

Expected logs: `learning round FAIL (2/2)` → `[LCRD] learning exhausted` → later tool calls are blocked.

### 12. Learning switch off (legacy behavior)

With `config.learningEnabled: false`, consecutive failures past `maxRetries` terminate directly without entering learning mode; `lcrd_learn` / `lcrd_learn_verify` are not registered.

## Flow export

The plugin writes **console logs and flow exports** per task into the log directory: one subfolder per task, named "task goal prefix + short agent-id hash" (e.g. `在当前目录创建…-a1b2c3d4`), so same-name tasks never share a folder and a later run never overwrites an earlier one. Exports are rewritten after **every protocol step (plan declaration, every tool verification), every completed turn, agent disposal, and process exit**, so a long-lived process shows the latest md/mmd/json mid-conversation. The default directory is `lcrd-flow/` inside the plugin package:

```
<logDir>/                     ← 默认插件包目录 lcrd-flow/;可用 config.logDir 覆盖
  <goal前缀>-<短哈希>/
    lcrd-flow.log             ← 屏幕日志(plan / verify PASS/FAIL / terminated / blocked),带时间戳
    lcrd-flow.md              ← Markdown 报告:结果状态 + Mermaid 流程图 + 事件时间线
    lcrd-flow.mmd             ← 纯 Mermaid 流程图源码
    lcrd-flow.json            ← 汇总元数据 + 完整事件时间线(plan/tool/verdict/intercept)
```

- `.md` opens in VS Code (with the Mermaid extension), GitHub, or Typora; `.mmd` drags into mermaid.live; `.json` is for programmatic analysis.
- `config.logDir` sets the log root (any location, e.g. `C:/logs/lcrd`); unset it uses `lcrd-flow/` inside the plugin package.

### lcrd-flow.json structure

`.json` is a machine-statistics format of "lightweight summary metadata + full events": a per-task summary line on top (for batch statistics and jumping to `.md` on anomalies), with `events` the full event array. Fields:

| Field | Meaning |
|---|---|
| `session_id` | session/agent id (index key) |
| `task_id` | task identity (slug generated from the goal; the agent id when no goal was recorded) |
| `md_file` | the detailed log `lcrd-flow.md` |
| `human_interaction_mode` | run mode `auto`/`auth`/`manual` |
| `hit_ask_intercepted` | whether a model question (ask_user_question) was intercepted |
| `lcrd_retry_consumed` | internal retries consumed |
| `lcrd_retry_max` | configured maximum retries |
| `goal_changed_times` / `stop_changed_times` / `verifier_changed_times` | times contract components (goal/stop/verifier) were modified (drift core metric) |
| `has_verifier_exception` | whether a verifier exception occurred (syntax/eval failure/timeout/unspawnable) |
| `learning_enabled` | whether learning mode is on |
| `learning_threshold` | consecutive failures that enter learning mode |
| `learning_attempts_max` | learning-round budget |
| `learning_attempts_consumed` | failed rounds consumed before learning success (reset to zero on success) |
| `learning_success` | whether the task completed through a post-learning re-solve |
| `final_verdict` | LCRD internal final outcome `pass`/`fail`/`terminated` |
| `tb_final_reward` | objective sandbox score (0/1); unavailable inside the harness, default `null`, backfilled by external evaluation scripts per `task_id` |
| `root_cause_hint` | short root-cause label, optional, default `null`, backfillable by external evaluation |
| `events` | full event array (plan/tool/verdict/intercept) |

The flowchart chains every `lcrd_plan` declaration, tool call, verification verdict (PASS/FAIL n/3), learning round (lcrd_learn / learn PASS|FAIL n/3), and interception (missing plan / infeasible / terminated) in execution order; the final node reads "会话结束" or "任务终止转人工".

## Acceptance criteria

Watch the console `[LCRD]` logs: plan declaration, verify PASS/FAIL (n/maxRetries), learning mode entered, learn/learn PASS|FAIL (n/maxLearningAttempts), learning success, learning exhausted, terminated, missing plan, infeasible, blocked.

## Model Experience

### Root-anchor protocol section

#### What the model sees

Every request carries the pinned protocol text below as a system-prompt section, so the model always sees the three-symbol contract and the verifier rules before the first tool call.

##### Protocol text

```markdown
[LCRD 硬隔离协议] 本协议由外部引擎强制校验,你无法修改。
1. 根锚点符:对话中用户的第一条消息就是主任务目标(根锚),包含其全部约束(预算、时间、合规等)。你无权修改或扩张主任务;主任务中未明确要求的操作一律视为越界,不得执行。
2. ●停止符:每个子任务开始前,你必须先调用 lcrd_plan 工具声明本步子任务计划:goal(子任务目标)、stop_condition(可被外部校验的局部停止条件)、feasibility(可行性布尔值)、verifier(校验方式)。工具执行后,外部校验器会独立验证停止条件是否满足,你不得自证"完成"。
3. 1退回符:外部校验失败时,工具结果会被拒绝并返回失败原因。你必须重新设计一套不同的方法继续执行(更换策略或参数),禁止原样重试。连续失败达到上限后,任务终止转人工。
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result,必须引用 result 且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
5. 根锚内部存在矛盾时,你可以在顶层边界之内权衡;任何输出不得违背根锚约束。
```

#### Token effect

Fixed text on every request; grows only if the anchor text itself changes.

#### KV Cache effect

Prefix-stable system prompt; the section changes only with the plugin version, so it preserves cache reuse across steps of a session.

### The `lcrd_plan` tool

#### What the model sees

The tool appears in the tool list with the goal / stop_condition / feasibility / verifier parameters. The verifier expression lists are model-authored data; the verification programs themselves are plugin-owned, so the model cannot write itself a pass.

#### Token effect

Schema tokens in every request while the tool is registered.

#### KV Cache effect

Stable schema; unchanged across steps.

### Learning-round tools (`lcrd_learn` / `lcrd_learn_verify`)

#### What the model sees

With `learningEnabled`, the two learning tools join the tool list. `lcrd_learn` takes problem_analysis / knowledge_needed / learning_method / eval_criteria; `lcrd_learn_verify` takes learned / evidence. The evaluation criteria are model-authored, and a failed self-evaluation consumes one learning attempt.

#### Token effect

Their parameters ride the tool list while registered; each round adds the declaration, knowledge-acquisition tool results, and the self-evaluation to history.

#### KV Cache effect

Append-only; each round's content follows the reusable prefix and does not invalidate existing cache entries.

### Rollback, learning, and termination feedback

#### What the model sees

On verification failure the plugin blocks the result and injects a corrective notice naming the reason and the required next step (re-declare a different plan; enter learning mode at the threshold; or stop and report after termination).

#### Token effect

One retained context message per failure; the injected reason text is data-dependent.

#### KV Cache effect

Append-only; feedback follows the reusable prefix.

## Known Limitations and Deferred Work

- Learning is in-session: acquired knowledge enters the current context only, is never persisted, and never reuses across sessions; the evaluation criteria are model-authored, the plugin only counts, and the real verdict on learning is whether the re-solve passes the exogenous verifier.
- Learning mode adds API calls and token spend (each round includes declaration, knowledge acquisition, and self-evaluation); `maxLearningAttempts` and `learningEnabled` are the budget and switch guards.
- Each LLM-verifier check costs one independent API call; verifierModel defaults to the main model (isolation relies only on the separate session and fixed prompt, not cross-account isolation).
- The `assert` verifier evaluates model-supplied JS expressions inside a Node `Function` sandbox; it only verifies data and grants no arbitrary code capability.
- Flow export writes synchronously after every protocol step (plan declaration, each tool verification), every completed turn (`turn/end` session event), agent disposal (`agent/disposed` global event), and process exit (`process.exit`); a long-lived process sees the latest export mid-conversation. A hard kill (SIGKILL) may lose the final events (best effort).
- The Python verifier depends on a system `python` command; Windows needs a runnable interpreter.