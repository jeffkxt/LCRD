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
      # fileFlowEnabled: true  # 文件化任务流程开关,默认 false;极简部署(无 web 工具)开启
      # fileFlowPathViolationsMax: 3  # 任务上下文路径越界次数上限,默认 3;达到即判幻觉严重终止
      # workspaceRoot: D:/workspace  # 工作区绝对路径(任务产物落点),默认取 session.header.cwd → 沙箱 workspaceRoot → DSH_CWD → fs 后端工作根
      # fileFlowTools: [str_replace_editor, write, edit]  # 守卫检查的文件工具集,默认极简部署三件套
      # failedCheckConsumesRetry: true  # 断言被引擎判为无效是否消耗任务重试预算,默认 true(关闭则用独立计数限制)
      # datasetExport: off             # 任务结束是否自动导出数据集:off(默认)/ run 结束时追加 dataset.jsonl、trainable.jsonl、needs_review.jsonl 与 dpo.jsonl
      # datasetDir: ./dataset          # 数据集目录,默认取 flow 日志目录同级的 dataset/
      # attributionModule: ./domain-attribution.mjs  # 领域归因 bundle 的模块路径/包名,默认用日志启发式分类学
      # hooksModule: ./policy-hooks.mjs  # 策略 hook 模块的路径/包名,默认关闭(纯协议)
```

The retry budget counts what it should measure. By default a step whose declared check the engine rejected (`invalid-condition`, `eval-error`) consumes the same budget as a step that ran and did not meet its stop condition, which is the historical behaviour; setting `failedCheckConsumesRetry: false` counts those failures against their own budget instead — bounded by `maxRetries` and reported as `invalidChecks` in each declaration's context — so the task budget measures only real step outcomes. Running both configurations over the same tasks is the intended A/B.

## File-backed task flow (fileFlowEnabled)

When `fileFlowEnabled` is on, a fixed protocol section joins the system prompt and the model keeps the task breakdown, per-subtask files, and a progress file on disk, executing subtasks one by one and validating the whole task at the end. Intended for minimal deployments whose only tools are bash and the string-replace editor; standard deployments leave it off and keep the plain in-context rollback flow. The protocol section is injected by the plugin; the model owns the files through bash / `str_replace_editor`.

- **Directory**: every task gets an engine-created task directory `<task-flow root>/taskflow-<uuid>/` — the plugin creates it directly (bypassing tool sandboxes) at plan declaration or the first guarded file operation, named `taskflow-` plus the agent uuid, deliberately different from the flow-log folder naming (`<goal>-<shortAgentId>`, or `session-<uuid>` before any goal) so the model never confuses the two; an entropy suffix disambiguates on collision. The directory starts EMPTY — the model must create `task.md`, `subtasks/`, `progress.md` in it; reading logs or directory listings never substitutes for creating them. The task directory holds flow files only — task products (scripts, code, data) are written to the workspace, and the guard denies products inside the task directory. The model never creates or names the directory; the protocol section and the engine messages tell it the exact path. The task-flow root is a sibling of the plugin's `lcrd-flow` log directory (the plugin package root by default, following `config.logDir` when set), so task context persists beside the logs, independent of the model's execution directory. `task.md` records one line `当前任务 task-slug: <task-slug>` for the model to confirm its own directory. The protocol section injects the absolute workspace root (`workspaceRoot` config, falling back to the agent session's validated cwd, then the deployment's sandbox `workspaceRoot` — the authoritative workspace-write boundary — then `DSH_CWD`, then the fs backend's own working root) — set `workspaceRoot` when the deployment's workspace differs from all of those, so the model places task products in the chosen workspace instead of a guessed alias like `/repo`. The section also instructs the model to `cd` into the workspace before running shell commands, so command execution always happens in the work area.
- **Guard scope**: hard isolation applies only to the task context. The plugin creates and pins the task directory itself: the first file operation of a guarded tool triggers creation and is denied with guidance naming the directory — the protocol's mandated first step is enforced, not just advised. The task directory holds **flow files only** (`task.md`, `progress.md`, `subtasks/*`): writing a task product (script, code, data) into it is denied with guidance, because products belong in the workspace. Afterwards every path under `task-flow/` must stay inside the pinned directory; reading or writing another task's directory or the bare `task-flow/` root is denied and counted, and reaching `fileFlowPathViolationsMax` (default 3) terminates the task as severe hallucination. Guidance denials never count. A denied execution is final: the denial reason reaches the model as the tool error and consumes no verifier retry. **Product containment**: after the bootstrap, mutations of the guarded file tools (create/str_replace/insert, `write`, `edit`) must land inside the workspace — writes elsewhere are denied with guidance naming the workspace, so task products are guaranteed to land in the work area; reads (`view`) stay free anywhere. Paths outside `task-flow/` are otherwise unguarded — no work-root fence on reads or shell commands. Guarded tools are the `fileFlowTools` set (default `str_replace_editor`, `write`, `edit`); shell commands are not checked. Paths are compared through the fs seam's own canonicalization (realpath ancestors, Windows drive-letter case), so the guard agrees with the file tools on every resolved identity.
- **Layout**: `task.md` (main task + acceptance criteria, read-only after creation), `subtasks/` (one file per subtask with its goal and acceptance condition), `progress.md` (per-subtask status `completed` / `in_progress` / `failed` plus the current pointer).
- **Flow**: create the folder and files at task start → read `progress.md` to pick the first unfinished subtask → read its file → execute it under the normal LCRD rollback rules (`lcrd_plan` + exogenous verifier, retry/learning on failure) → mark it `completed` in `progress.md` → next subtask. Subtask details stay in their files and enter the context only while executing, so the context keeps just the progress and the latest failure reason. When all subtasks are done, validate the whole task against `task.md`; on failure, revise the failing subtask's file and re-run it. On termination, mark the current subtask `failed` and summarize what was completed.

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
| `assert` | `conditions: string[]` | A list of JS expressions over `result` (the structured tool value), `content` (the rendered text), or `isError`; each must reference at least one and must not hold on every probe input; all must hold to pass. A failed tool result always fails outright. The list must be non-empty: `lcrd_plan` rejects an empty one at the declaration, and a declaration that reaches the verifier anyway fails as an invalid check instead of passing everything |
| `python` | `checks: string[]` | A list of Python expressions over `result` / `content` / `isError`, evaluated by the plugin-fixed script template (the environment also injects `json`); same rules as assert, including the non-empty list; timeout kills and fails |
| `llm` | none | An independent session with a plugin-fixed prompt (root-anchor protocol + goal/stop_condition), temperature 0; non-JSON or non-PASS always fails |

Failure reasons localize the cause: evaluation errors carry the actual `result`/`content` types (so a shape mismatch self-corrects on the next plan), JS `in`-operator misuse gets a dedicated hint, and a negative condition rejected for missing discrimination gets a hint to use the positive form or the `llm` verifier.

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

Expected log: `verify FAIL` reason contains "必须引用 result". Writing `result === result` yields reason "缺少区分度".

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

## Recorded events and dataset export

Every recorded event carries an envelope — `seq` (1-based position, equal to its `.jsonl` line number) and `ts` (ISO-8601) — so a transcript is ordered and timeable without parsing the log text. The fields the protocol's meaning depends on are recorded beside it:

| Event | Recorded fields |
|---|---|
| `plan` | `strictness` — expressions, tautological count, whether any expression pins a literal or reads a field of the structured value, whether it reads the rendered text, whether it is presence-only, the largest hold rate among its probed expressions (so `1 - maxHoldRate` reads as the declaration's constraint), and the aggregate probe reading (`discriminating` / `tautological` / `unbound` / `invalid` / `empty` for a declaration with no expression at all, or `unchecked` for the python and llm kinds); `relaxation` — the axes this declaration loosened along against the agent's own previous declaration (`verifier-kind`, `fewer-expressions`, `presence-only`, `lost-structural`, `dropped-literals`, `substring-text`, `weaker-constraint`); `repeatPlan` — whether the declaration repeats the previous one verbatim, so no method change happened; `context` — what the model had just seen: the consecutive failure count, the learning phase, the preceding verdict's pass flag, verifier kind and clipped reason, and how many of its checks the engine had already rejected |
| `tool` | `callId` (joins the session log's tool records), `argsSummary` (clipped JSON of the arguments), `resultKind` (`error` for a failed call, otherwise the JSON kind of the value), `resultSummary` (clipped JSON of the value, or the rendered content for a failed call), `errorMessage` and `errorCode` (the failed call's message and its machine-routable code, when the runtime supplied one) |
| `verdict` | `verifierKind` — which verifier produced the verdict; `callId` and `tool` — the verified call, so a verdict names its referent instead of relying on event order; `exceptionKind` — why the verifier threw (`invalid-condition`, `eval-error`, `timeout`, `unspawnable`, `exit-code`, `bad-output`, `no-provider`) |

`exceptionKind` is what separates the model's understanding from its work: `invalid-condition` and `eval-error` mean the engine rejected the model's own check, so a failure with those kinds says nothing about the task; `unspawnable` and `no-provider` are environment or configuration failures. `context` makes each declaration a `(state, action)` sample on its own, without joining the session log.

`strictness` is read at declaration time from the same probe matrix the post-execute verifier runs, but it records rather than judges: the assertion is measured before the tool executes, and the verdict still belongs to the verifier. The probe covers assert only, because the python check needs an interpreter process whose cost belongs to the verdict.

The relaxation axes are monotone shape signals, not verdicts: a rewrite that keeps a check just as tight while changing its shape (replacing two substring tests with one stricter pattern, say) still trips `fewer-expressions` and `dropped-literals`. `weaker-constraint` is the quantitative reading — the declaration's largest probe hold rate rose — and `repeatPlan` is the mechanical one — the declaration repeats the previous goal, stop condition, and verifier verbatim. It is recorded, never enforced: refusing a repeat would change the trajectory instead of labeling it. Both expression lists are recorded on every relaxation record so a reader — human or model — judges the pair instead of trusting the axes.

`lcrd-flow.jsonl` is append-only and sits beside the rewritten snapshot files, one JSON event per line: an interrupted run keeps every event already appended, and a later dump never rewrites what earlier turns recorded. `lcrd-flow.json` remains the current snapshot and takes precedence for a completed run; the exporter falls back to the snapshot's `events` array for runs recorded before the stream existed and re-derives each legacy declaration's `strictness` from its `verifierSpec`, so old and new runs land in one dataset with the same vocabulary.

`anchor_digest` in the meta is the digest of the task's first user message (whole message, non-text blocks included), so runs sharing one root anchor group together without copying the anchor text into every artifact. `schema_version` names the artifact vocabulary, and `events_file` names the stream. A backfilled `tb_final_reward` / `root_cause_hint` in the snapshot is preserved across later dumps, because the recorder reads the previous snapshot before rewriting it; the constructor options still win over the file.

`run.json` carries what makes runs comparable: the plugin version, the injected protocol version (`PROTOCOL_VERSION`, bumped whenever the anchor text or the corrective notices change), the configuration the plugin was mounted with, the model and provider, the platform and Node version, the session's working directory, start and end times, the final verdict, and how the run stands (`terminated`, `completed`, or `incomplete`). The same plugin/protocol/model/platform identity also lands in the snapshot meta, so a single file answers which release recorded it.

Export a corpus:

```sh
pnpm run lcrd:dataset                                   # default flow root and output directory
pnpm run lcrd:dataset -- --root <flow root> --out <dir>  # explicit locations
```

It writes four files: `dataset.jsonl` (one record per protocol event, with `step`, `ts`, `task_group` for split grouping, `failureClass` for failed verdicts, an `infraFailure` flag, and every recorded field), `relaxations.jsonl` (one record per declaration that loosened after a failed verdict, carrying the consecutive failure count, that failure's class and exception kind, the preceding result's kind, both expression lists, the axes, and a `cause` — `type-adaptation` when the check threw against the real value so its rewrite was expected, `substance-dropped` when strength fell after the work itself was judged incomplete, otherwise `undetermined`), `runs.jsonl` (one row per run with the `run.json` metadata, or what the snapshot alone can tell for legacy runs), and `anchor-judge.jsonl` (one request per run carrying an anchor excerpt, pairing the anchor with every declaration a judge must label as within or outside it). The console report prints the groupings a reader needs to judge the corpus: task groups and how many repeat, runs by model, platform, and interaction mode, how many runs carry `run.json`, verifier kinds, pass/fail counts, failure classes, repeated declarations, relaxation axes and causes, relaxations by consecutive failure count, and anchor-judgement requests. Verdicts classified as `infra-error` are counted separately and excluded from the pass/fail and failure-class numbers, because they measure the machine rather than the model.

Anchor judging stays outside the exporter: write the labels it produced as JSONL (`{"run_id": …, "step": …, "label": …}`) and pass the file back to fold them onto the declarations:

```sh
pnpm run lcrd:dataset -- --anchor-labels <labels.jsonl>
```

### Automatic export after a conversation (`datasetExport`)

Setting `datasetExport: run` makes the plugin append the finished run's rows to the same four files at disposal, so a conversation produces training-ready data with no separate command:

```sh
pnpm run lcrd:pipeline          # one incremental pass over every settled, not-yet-exported run
pnpm run lcrd:watch             # poll every 10s and export each run as it finishes (Ctrl+C to stop)
pnpm run lcrd:pipeline -- --all # rebuild every file from scratch
pnpm run lcrd:dataset && pnpm run lcrd:dpo   # or export the corpus in two separate steps
```

The in-process path writes `dataset.jsonl`, `relaxations.jsonl`, `runs.jsonl`, and `dpo.jsonl`, and splits every dataset row by trainability: `trainable.jsonl` holds rows whose label the engine decided deterministically (context rows, passing verdicts, and check rejections such as `assertion-invalid`), `needs_review.jsonl` holds rows whose label needs a human or LLM judge (`honest-mismatch`, `tool-isError`, `unclassified`), and environment/verifier-infra failures (`infra-error`, `python-timeout`, `llm-bad-output`) appear only in the full stream — so downstream training consumes the split files instead of a corpus that mixes ambiguous labels. Each row carries its `trainability` label so the split is reproducible without re-deriving it. The pipeline adds a `.pipeline-state.json` recording each run's fingerprint, so reruns never duplicate rows, and a run whose snapshot changed after export is exported again. A run is only picked up once its artifacts have settled (`--settle`, default 15s; the watch script uses 5s), and file-level export needs the session log, which the in-process path does not.

The DPO `chosen` side is constructed: it restores the pre-relaxation check onto the model's own declaration, and every pair is marked `"synthetic": true` with the `repair` name and the axes it reversed. `prompt` is the model-visible transcript up to the declaration (user, assistant text, tool calls, tool results, engine notices tagged `source=plugin`) and does not include the system prompt.

### Pluggable attribution (`attributionModule` / `--attribution`)

The default attribution is the log-heuristic taxonomy in `dataset.ts`: it maps a verdict's recorded reason and exception kind to a `FailureClass`, a loosened declaration to a `RelaxationCause`, and every row to a `Trainability`. A professional task family often has its own failure vocabulary — a domain-specific classifier that better names what went wrong for its tasks. The attribution hook lets such a domain replace the whole taxonomy without forking the plugin:

```ts
// domain-attribution.mjs — default export, or export an object without `default`
export default {
  classifyFailure(reason, exceptionKind) { /* domain rules */ },
  classifyRelaxationCause(failureClass, failureExceptionKind, axes) { /* domain rules */ },
  classifyTrainability(row) { /* domain rules */ },
}
```

- **In-process**: set `config.attributionModule` to the module path (relative paths resolve against the process working directory) or a package name. The plugin loads and validates it at startup and passes it to every `FlowRecorder`, so `datasetExport: run` rows carry the domain's labels.
- **Offline corpus**: `pnpm run lcrd:dataset -- --attribution ./domain-attribution.mjs` and `pnpm run lcrd:pipeline -- --attribution <module>` feed the same bundle into `buildRun`/`exportDataset`, replacing the re-derived failure and relaxation classification for every run.
- The bundle must export all three functions; a partial or invalid export fails loudly at load (`loadAttribution`). The recorded fields a domain classifier reads are unchanged — attribution is a pure function of the logged row, so a domain bundle never touches live tool results or the session.

### Policy hooks (`hooksModule`)

A deployment can inspect LCRD's own declared plan and every verified tool result through one configured module. The hook is trusted deployment code; it never sees the harness's logged tool arguments and never writes harness state — LCRD stays the only writer of its plan, budgets, and termination state.

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

- **Two points.** `checkPlan` runs on the completed declaration, before it governs execution; `checkResult` runs after the exogenous verifier produced its verdict. Both may be async and should observe the call's `signal`.
- **A replacement plan is silent to the model.** `lcrd_plan`'s result still echoes the declaration, while the flow artifacts record the effective plan and the verifier runs the effective check. Two consequences are visible: a failed verification quotes the effective condition in its reason, and a replacement that flips `feasibility` to false takes the existing infeasible branch, which does tell the model. A domain that must not disclose its check can choose the `llm` verifier, whose fixed prompt owns the reason text.
- **Interceptions consume no task retry budget.** `deny`, `block`, and a throwing hook are counted independently, bounded by `maxRetries`, and terminate the task for human review once they reach it; a new user command resets the count with the other per-task state. A `deny` also clears any earlier plan, so a rejected declaration cannot be bypassed by continuing with the previous one.
- **A malformed replacement plan fails loud**, and a throwing hook propagates below the cap (the model sees the hook's error) and terminates at it.
- The hook sees the result as LCRD's verifier saw it; a downstream `tools/post-execute` listener may still transform the accepted result afterwards.

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
| `events` | full event array (plan/tool/verdict/intercept), each stamped with its `seq`/`ts` envelope |
| `schema_version` | artifact vocabulary version; a recorded field that changes meaning bumps it |
| `events_file` | name of the append-only event stream written beside this snapshot (`lcrd-flow.jsonl`) |
| `anchor_digest` | digest of the task's first user message (the root anchor); null before one is recorded |
| `relaxation_count` | how many declarations loosened their check against the previous declaration |
| `repeat_plan_count` | how many declarations repeated the previous one verbatim |
| `anchor_excerpt` | clipped first user message (the root anchor), for offline anchor judgement |
| `plugin_version` / `protocol_version` | the recording release and the injected protocol version |
| `model` / `provider` | the model and provider the agent ran with |
| `platform` | the platform the run was recorded on |

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

- File sandboxes: with a file sandbox in `workspace-write` mode, the task-flow root must sit inside the sandbox's writable workspace — otherwise the model's tool-mediated writes to the flow files are denied by the sandbox (the plugin's own directory creation bypasses it, but the model's `task.md`/`progress.md` updates cannot). Set `logDir` under the workspace so the task-flow root follows, or configure the sandbox to allow it.
- Learning is in-session: acquired knowledge enters the current context only, is never persisted, and never reuses across sessions; the evaluation criteria are model-authored, the plugin only counts, and the real verdict on learning is whether the re-solve passes the exogenous verifier.
- Learning mode adds API calls and token spend (each round includes declaration, knowledge acquisition, and self-evaluation); `maxLearningAttempts` and `learningEnabled` are the budget and switch guards.
- Each LLM-verifier check costs one independent API call; verifierModel defaults to the main model (isolation relies only on the separate session and fixed prompt, not cross-account isolation).
- The `assert` verifier evaluates model-supplied JS expressions inside a Node `Function` sandbox; it only verifies data and grants no arbitrary code capability.
- Flow export writes synchronously after every protocol step (plan declaration, each tool verification), every completed turn (`turn/end` session event), agent disposal (`agent/disposed` global event), and process exit (`process.exit`); a long-lived process sees the latest export mid-conversation. A hard kill (SIGKILL) may lose the final events (best effort).
- The Python verifier depends on a system `python` command; Windows needs a runnable interpreter.