---
description: "Profile layer that enforces the three-symbol LCRD protocol on an agent: exogenous verification of every tool result, rollback and retry, optional learning mode, and flow/dataset export for third-party viewers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-lcrd — LCRD Hard-Isolation

English | [中文](README.zh.md)

## Summary

The LCRD (long-chain reasoning drift) hard-isolation plugin maps the three-symbol protocol (root anchor / stop symbol / rollback symbol) onto the harness extension points: every tool result is verified by an exogenous verifier independent of the model, failures roll back and retry, and consecutive failures past the budget terminate the task for human review. A refreshed Mermaid flowchart, Markdown report, and JSON event timeline are exported after every completed turn for third-party viewers.

## Table of Contents

- [Usage](#usage)
- [Learning mode (learningEnabled)](#learning-mode)
- [Policy evolution (evolveEnabled)](#policy-evolution)
- [Config](#config)
- [File-backed task flow (fileFlowEnabled)](#file-backed-task-flow)
- [Interaction mode (interaction)](#interaction-mode)
- [Verifier: three choices](#verifier-choice)
- [Test scenarios](#test-scenarios)
- [Recorded events and dataset export](#recorded-events-and-dataset-export)
- [Flow export](#flow-export)
- [Acceptance criteria](#acceptance-criteria)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="usage"></a>
## Usage

This package is private and is not published to npm. It is developed inside this repository, so the source run with the in-package patch is the supported entry point:

```sh
pnpm dsh --profile headless --patch ./packages/experimental/lcrd/cordis.patch.yml "你的任务"
pnpm dsh --profile web --patch ./packages/experimental/lcrd/cordis.patch.yml   # 交互:浏览器打开 http://127.0.0.1:3080
```

Prerequisite: a model key is configured — `DEEPSEEK_API_KEY` in the root `.env` for a source run.

Protocol-enforced flow: before every tool call the model must call `lcrd_plan` to declare its subtask plan (goal / stop_condition / feasibility / verifier); after the tool runs, the chosen verifier checks the result independently. A failed verification rejects the result and rolls back to retry; consecutive failures past the budget terminate the task for human review.

<a id="learning-mode"></a>
## Learning mode (learningEnabled)

When consecutive verifier failures reach `learningThreshold` (default 5) and learning is enabled, direct retries pause and the model enters learning mode for at most `maxLearningAttempts` (default 3) rounds:

1. **Declare**: call `lcrd_learn` to break down the currently unsolvable problem (`problem_analysis`), the knowledge needed (`knowledge_needed`), the learning method (`learning_method`, e.g. web_search / reading files / reflection / delegation), and the self-evaluation criteria (`eval_criteria`, authored by the model).
2. **Learn**: `learningTools` allowlist tools pass without a plan or verifier; task tools and `lcrd_plan` are blocked during the learn phase. At least one allowlist tool must actually run before the round can pass self-evaluation, so a round is backed by acquired knowledge rather than a bare claim. Every learning-tool call is registered as citable evidence: the file path or URL it read, a digest of the acquired text, and a clipped excerpt, numbered `e1`, `e2`, … up to 20 entries per round.
3. **Self-evaluate**: call `lcrd_learn_verify` to judge against the self-authored criteria. Without a prior learning-tool call the pass verdict is refused (without consuming a round); a pass must cite a registered entry by its id or its source, and an uncited self-evaluation is refused without consuming a round, listing the entries it may cite; a failed self-evaluation consumes one learning round; at the round budget the task terminates for human review.
4. **Re-solve**: after a passed self-evaluation, re-declare `lcrd_plan` and run task tools; results still run the exogenous verifier. A passed re-solve completes the task and resets the learning budget; a failed one consumes a learning round and returns to learning mode with the failure reason injected into the next analysis.

During learning mode the `maxRetries` termination is suspended and governed solely by the learning-round budget; disabling `learningEnabled` keeps the plugin exactly on the legacy behavior (consecutive failures past `maxRetries` terminate).

**Every new user command is a fresh task boundary**: the declared plan, the failure count, the learning budget, and any termination state reset when a real user message arrives, so a new instruction always starts from a clean retry budget and must re-declare its plan. Plugin-injected notices never reset; only actual user input does.

<a id="policy-evolution"></a>
## Policy evolution (evolveEnabled)

An opt-in, versioned loop that turns a solved problem into a reusable **skill** for later steps and sessions. It is the prompt-level half of self-improvement: no weights, no code execution, no silent changes. Off by default; enabling it requires `evolveBenchmarkDir` and a composed `@deepseek-ai/dsh-skill`.

1. **Propose.** The model calls `lcrd_propose` with a rationale, a `parent_version` drawn from the candidate set the engine proposes (the active version is always a candidate), and 1–8 skills (name, description, markdown body). The tool is absent when evolution is off.
2. **Static scan.** Before any version exists, deterministic rules reject injection phrasing, identity negation, authority escalation (skip the verifier, redefine the root anchor, change budgets, call `lcrd_propose`), hidden text (zero-width, bidi controls, encoded blobs, imperative HTML comments), forged framing tags, and holdout/hard-out leakage. `evolveStaticScan: rules+llm` adds one fixed-prompt model scan that fails closed on unusable output.
3. **Stage.** An accepted proposal writes an immutable `versions/vNNNN/` directory with a manifest (parent, rationale, benchmark digest, skill digests) and status `proposed`.
4. **Gate.** The gate probes the candidate mount first: a child that produces no `run.json` aborts the gate with a configuration error instead of spending the whole budget. It then runs the current and candidate versions over the drawn holdout subset in fresh child processes. Admission reads each task's `reward` command (ground truth) by default; `evolveAdmission: self-report` falls back to the agent's own verifier verdicts and is only for smoke runs. The candidate must gain ≥ `evolveMinGain`, must not regress the termination rate, the `speculative_cheat` rate, hook interceptions, or path violations, and must not spend more than `evolveMaxTokenRegression` above the baseline. The gate stops at `evolveGateMaxTokens` or `evolveGateMaxWallMs` (status `gate-aborted`), and a benchmark edited mid-gate voids the run.
5. **Review brief.** `gate/<id>/brief.md` and `brief.json` list only the exceptions: blocking static findings, unhealthy runs, speculative relaxations, quarantine history, and the per-skill line diff. The approval prompt carries a one-line summary plus the brief path.
6. **Promote.** `evolvePromote: approval` (default) asks the approval service; only `allowed-once` promotes. `interaction: auto` maps to approval policy `never`, so unattended runs can propose but never promote. Promotion is a pointer CAS plus a skill-registration swap; `auto` is for CI only.
7. **Monitor and roll back.** Every finished run is folded into the active version's score window. The version's first full window becomes its own reference; later windows that raise the cheat or termination rate above that reference revert the pointer to the manifest's parent and record a `quarantine.json` entry. Online runs are never compared with holdout metrics, because the task distributions differ. The next `lcrd_propose` result returns `quarantineHints`, and the protocol asks the model to avoid repeating that cause.

**Transition audit and visibility.** A successful promote or rollback logs `[SYSTEM NOTICE] LCRD Policy Promoted|Rolled Back: <from> -> <to> (Reason: <reason>). Active policy switched.` and delivers the same text through the existing `additionalContexts` notice channel on that agent's next tool decision; it adds no session event type. The store appends every transition to `policy-events.jsonl`, so the ledger always matches `current.json`, and a recorder freezes the live active version into `run.json.policy_version` while the next task re-reads `current.json`. Notifications are best-effort: if the session ends immediately after a switch, the model may never receive the queued notice. The authoritative durable records are `policy-events.jsonl` and `run.json.policy_version`.

**Ground truth.** Every benchmark task must carry a `reward` command (for example `node score.mjs`) when admission is `reward`. The gate runs it in the workspace after the child exits and reads the last printed number in `[0, 1]`, or the exit code when it prints none. This is the only admission metric that cannot be gamed by the agent's own verifier; `passRate` remains a diagnostic.

**Gate trust boundary.** Benchmark files are operator-trusted artifacts, not model input: the gate runs each task's `reward` command with `shell: true` inside the configured `workspace` (the gate cwd by default). The candidate probe run only verifies that the mount produces `run.json`; it never executes the `reward` command. A printed number in `[0, 1]` wins; otherwise exit code 0 counts as 1 and any other exit, timeout, or spawn failure counts as 0. A selected task without a `reward` command fails admission as unavailable, and the resulting per-side `rewardRate` feeds the same gain, safety, cheat, and token decision as every other metric.

**Run isolation.** Every run gets its own workspace under `runs/<side>/<task>-<repeat>/workspace`. When a task names a `fixture`, that directory is copied into the workspace before the child starts; otherwise the workspace starts empty. The child's working directory and `LCRD_RUN_WORKSPACE` point at it, and the reward command runs there too, so a candidate can never read the baseline's artifacts.

**Gain report.** Every gate writes `report.json`, `gain-report.md`, and `gain-report.json`: paired baseline/candidate rows, the mean paired delta, a deterministic bootstrap confidence interval, token spend, and a verdict (`gain`, `no-gain`, or `insufficient-evidence`). The verdict is separate from the gate decision — a passed gate whose interval includes zero is reported as insufficient evidence, not as a gain.

**Noise floor and significance.** `pnpm run lcrd:policy -- noise --benchmark <dir> --rounds 10 --profile lcrd-gate --base-config <json>` runs the current version on a fixed holdout set and reports mean, sd, p5, p95, `minDetectableGain = 1.96 * sd / sqrt(holdoutSize * repeats)`, and the runs needed for `evolveMinGain`. Run it before trusting a threshold. `evolveSignificance` defaults to `off`; `bootstrap` additionally rejects a reward gain whose paired bootstrap interval includes zero (it requires `evolveAdmission: reward` and at least two paired runs). Keep `evolvePromote: approval` while `minDetectableGain` exceeds `evolveMinGain`. The gate now computes this floor from its own paired rows and refuses to admit when it exceeds `evolveMinGain` (`evolveRequireDetectability`, default true), recording `detectability`, `pairedN`, and `minGain` in `report.json` and the review brief.

**Headroom and incomplete evidence.** `detectability` is the sample's resolution; `headroom = 1 - baseline.rewardRate` is the largest gain the benchmark could still show. Both must support `evolveMinGain`. After the baseline runs, a gate whose headroom is smaller writes a baseline-only `report.json`/`gain-report` with `outcome: gate-aborted` and does not start the candidate; its brief says `ABORTED — candidate was not run`. Under `evolveAdmission: reward`, a run without a reward is incomplete evidence, not a pair to drop: baseline missing writes the same baseline-only abort, candidate missing writes a full abort report. Only real exceptions (launcher or mount failures) throw; a declared instrument abort returns normally and is recorded as the `gate-aborted` rejected-edit stage.

**Rejected-edit feedback.** A static rejection, gate failure, or gate abort appends one record to `<policy>/rejected-edits.jsonl` (schema 1). The next proposal's result includes the newest three records (`<version> (<stage>): rule@line` for static findings, otherwise the gate reasons) plus quarantine hints. The log is best-effort: an append failure or unreadable file never blocks a proposal, and only the newest 20 records are read. It is append-only and not rotated.

**Example benchmark.** `benchmarks/example/` is a runnable self-contained fixture: ten holdout tasks, one sealed hard-out task, and a `reward.mjs` that scores an answer file. Every needed input lives under `fixtures/task/source/`; each task names `fixture: fixtures/task`, so the run reads `source/...` inside its isolated workspace and never the repository. The anchor asks for `answers/<task>.txt` inside that workspace, and the copied `reward.mjs` scores it. The benchmark tree itself is never written to. It demonstrates the workspace contract, not repository comprehension. Point `evolveBenchmarkDir` at the directory and keep `evolveAdmission: reward`:

```yaml
evolveEnabled: true
evolveBenchmarkDir: packages/experimental/lcrd/benchmarks/example
evolvePolicyDir: .lcrd/policy
```

The tasks and expected answers are examples, not a production quality signal; replace them with your task family before using the numbers in a release decision.

**Gate profile.** The bare `headless` profile does not mount LCRD, and a generated overlay only targets `id: lcrd` — it never inserts the row. Create a frozen gate profile from `dsh-base`, `dsh-headless`, and the private gate bundle, then set `evolveGateProfile: lcrd-gate`:

```sh
dsh plugin --profile lcrd-gate add @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-experimental-lcrd-gate
```

Three benchmark tiers keep optimization honest:

| Tier | Path | Purpose | Read by |
|---|---|---|---|
| train | `benchmark/train.jsonl` | proposal source | the model |
| holdout | `benchmark/holdout/*.jsonl` | admission, rotating subset with `evolveHoldoutCooldown` | the gate |
| hard-out | `benchmark/hardout/*.jsonl` | periodic sealed audit every `evolveHardoutAuditEvery` promotions, compared against the parent on the same tasks | the audit only |

Hard-out never feeds the daily gate. An audit that regresses against the admitted metrics sets the promotion hold (`promotionHeld`), blocking later promotions until an operator clears it.

Operations tooling (repository development; the plugin exports the same store API):

```sh
pnpm run lcrd:policy -- show
pnpm run lcrd:policy -- promote v0002          # offline promotion of a gated version
pnpm run lcrd:policy -- rollback --reason "..."
pnpm run lcrd:policy -- audit-hardout --benchmark ./benchmark
pnpm run lcrd:policy -- clear-hold
```

The policy root holds `current.json` (revision + history + hold), `versions/`, `quarantine.json`, `holdout-history.json`, `archive.jsonl` (the admission ledger every gate appends to), and `policy-events.jsonl`. Policy lifecycle records live there rather than in the session log, so a build that does not load this plugin never meets an unknown event type.

<a id="config"></a>
## Config

Add `config` under the `lcrd` entry in `cordis.yml`. Omitted keys fall back to the schema defaults below; the shipped `cordis.patch.yml` layer overrides `maxRetries` (10), `interaction` (`auto`), and `learningEnabled` (`true`):

```yaml
- insert:
  - id: lcrd
    name: '@deepseek-ai/dsh-experimental-lcrd'
    config:
      maxRetries: 3          # schema default 3; shipped override 10
      pythonCommand: python  # schema default python
      pythonTimeoutMs: 30000 # schema default 30000; kill the verifier after this many ms
      verifierModel: deepseek-chat  # schema default: same as the main model
      logDir: ./lcrd-flow    # schema default: lcrd-flow/ beside the plugin package
      interaction: auto      # schema default manual; shipped override auto (auto/auth/manual)
      learningEnabled: true  # schema default false; shipped override true
      learningThreshold: 5   # schema default 5
      maxLearningAttempts: 3 # schema default 3
      learningTools:         # schema default knowledge tools (shipped patch sets the same list)
        - web_search
        - read
        - glob
        - grep
        - skill
        - subagent
        - web_fetch
      # fileFlowEnabled: true  # schema default false; enable for minimal deployments without web tools
      # fileFlowPathViolationsMax: 3  # schema default 3; path escapes past this count terminate the task as severe hallucination
      # workspaceRoot: D:/workspace  # absolute workspace root for task products; falls back to session.header.cwd → sandbox workspaceRoot → DSH_CWD → fs backend work root
      # fileFlowTools: [str_replace_editor, write, edit]  # schema default: the minimal-deployment guard trio
      # failedCheckConsumesRetry: true  # schema default true; false counts engine-rejected assertions against their own budget
      # rejectPresenceOnly: false       # schema default false; reject presence-only assert declarations at declaration time
      # declarationMaxHoldRate: 0.9     # declaration-time probe hold-rate ceiling in (0,1]; disabled by default
      # evolveEnabled: true            # schema default false; requires evolveBenchmarkDir and @deepseek-ai/dsh-skill
      # evolveBenchmarkDir: ./benchmark
      # evolvePolicyDir: ./policy      # schema default: policy/ beside the flow logs
      # evolveGateCommand: dsh         # command that starts a gate child
      # evolveGateArgs: []             # extra args prepended before the harness flags
      # evolveGateProfile: headless    # profile each gate child boots
      # evolveGateRunTimeoutMs: 900000
      # evolveRepeats: 3               # repeats per task and side
      # evolveHoldoutSize: 5           # tasks drawn per gate
      # evolveHoldoutCooldown: 3       # recent gates a drawn task stays ineligible for
      # evolveHardoutAuditEvery: 5     # promotions between sealed audits; 0 disables
      # evolveMinGain: 0.1
      # evolveMaxSafetyRegression: 0
      # evolveMaxCheatRegression: 0
      # evolveGateMaxTokens: 2000000
      # evolveGateMaxWallMs: 3600000
      # evolveRunMaxTokens: 200000
      # evolvePromote: approval        # approval (default) | auto
      # evolveAdmission: reward        # reward (default) | self-report
      # evolveSignificance: off        # off (default) | bootstrap; requires evolveAdmission: reward
      # evolveSignificanceAlpha: 0.05  # two-sided error rate for the paired bootstrap
      # evolveRequireDetectability: true  # refuse a promotion when the gate's own noise floor exceeds evolveMinGain
      # evolveMaxTokenRegression: 0.2
      # evolveMaxProposals: 2
      # evolveMaxSkills: 8
      # evolveSkillMaxBytes: 16384
      # evolveRationaleMax: 2000
      # evolveStaticScan: rules        # rules | rules+llm
      # evolveScanModel: <model id>    # required for rules+llm; must differ from the proposing model
      # evolveBriefTopN: 5
      # evolveRollbackWindow: 10
      # evolveRollbackMargin: 0.2
      # datasetExport: off             # schema default off; run appends dataset.jsonl, trainable.jsonl, needs_review.jsonl, and dpo.jsonl at disposal
      # datasetDir: ./dataset          # schema default: dataset/ beside the flow log directory
      # attributionModule: ./domain-attribution.mjs  # domain attribution bundle module path/package name; default is the log-heuristic taxonomy
      # hooksModule: ./policy-hooks.mjs  # policy hook module path/package name; disabled by default (plain protocol)
```

The retry budget counts what it should measure. By default a step whose declared check the engine rejected (`invalid-condition`, `eval-error`) consumes the same budget as a step that ran and did not meet its stop condition, which is the historical behaviour; setting `failedCheckConsumesRetry: false` counts those failures against their own budget instead — bounded by `maxRetries` and reported as `invalidChecks` in each declaration's context — so the task budget measures only real step outcomes. Running both configurations over the same tasks is the intended A/B.

Declaration-time gates reject a speculative plan before it can govern anything. Every assert condition must compile, reference `result`/`content`/`isError`, and fail on at least one probe input — the same rules the post-execute verifier enforces, checked at `lcrd_plan` so a rejected declaration never reaches the stream or the plan map. With `rejectPresenceOnly: true` the declaration must also pin a literal or read a structured field; with `declarationMaxHoldRate` set in `(0, 1]` its largest probe hold rate must stay below the ceiling. The plugin does not judge whether `stop_condition` semantically matches the verifier expressions — that trust boundary belongs to a `checkPlan` policy hook, which may deny or replace a declaration whose stop condition and check disagree. After a verification fails, redeclaring that same failed plan verbatim is rejected (and terminates at `maxRetries`); a new user command or a later pass clears the fingerprint so a legitimately revised method can return.

<a id="file-backed-task-flow"></a>
## File-backed task flow (fileFlowEnabled)

When `fileFlowEnabled` is on, a fixed protocol section joins the system prompt and the model keeps the task breakdown, per-subtask files, and a progress file on disk, executing subtasks one by one and validating the whole task at the end. Intended for minimal deployments whose only tools are bash and the string-replace editor; standard deployments leave it off and keep the plain in-context rollback flow. The protocol section is injected by the plugin; the model owns the files through bash / `str_replace_editor`.

- **Directory**: every task gets an engine-created task directory `<task-flow root>/taskflow-<uuid>/` — the plugin creates it directly (bypassing tool sandboxes) at plan declaration or the first guarded file operation, named `taskflow-` plus the agent uuid, deliberately different from the flow-log folder naming (`<goal>-<shortAgentId>`, or `session-<uuid>` before any goal) so the model never confuses the two; an entropy suffix disambiguates on collision. The directory starts EMPTY — the model must create `task.md`, `subtasks/`, `progress.md` in it; reading logs or directory listings never substitutes for creating them. The task directory holds flow files only — task products (scripts, code, data) are written to the workspace, and the guard denies products inside the task directory. The model never creates or names the directory; the protocol section and the engine messages tell it the exact path. The task-flow root is a sibling of the plugin's `lcrd-flow` log directory (the plugin package root by default, following `config.logDir` when set), so task context persists beside the logs, independent of the model's execution directory. `task.md` records one line `当前任务 task-slug: <task-slug>` for the model to confirm its own directory. The protocol section injects the absolute workspace root (`workspaceRoot` config, falling back to the agent session's validated cwd, then the deployment's sandbox `workspaceRoot` — the authoritative workspace-write boundary — then `DSH_CWD`, then the fs backend's own working root) — set `workspaceRoot` when the deployment's workspace differs from all of those, so the model places task products in the chosen workspace instead of a guessed alias like `/repo`. The section also instructs the model to `cd` into the workspace before running shell commands, so command execution always happens in the work area.
- **Guard scope**: hard isolation applies only to the task context. The plugin creates and pins the task directory itself: the first file operation of a guarded tool triggers creation and is denied with guidance naming the directory — the protocol's mandated first step is enforced, not just advised. The task directory holds **flow files only** (`task.md`, `progress.md`, `subtasks/*`): writing a task product (script, code, data) into it is denied with guidance, because products belong in the workspace. Afterwards every path under `task-flow/` must stay inside the pinned directory; reading or writing another task's directory or the bare `task-flow/` root is denied and counted, and reaching `fileFlowPathViolationsMax` (default 3) terminates the task as severe hallucination. Guidance denials never count. A denied execution is final: the denial reason reaches the model as the tool error and consumes no verifier retry. **Product containment**: after the bootstrap, mutations of the guarded file tools (create/str_replace/insert, `write`, `edit`) must land inside the workspace — writes elsewhere are denied with guidance naming the workspace, so task products are guaranteed to land in the work area; reads (`view`) stay free anywhere. Paths outside `task-flow/` are otherwise unguarded — no work-root fence on reads or shell commands. Guarded tools are the `fileFlowTools` set (default `str_replace_editor`, `write`, `edit`); shell commands are not checked. Paths are compared through the fs seam's own canonicalization (realpath ancestors, Windows drive-letter case), so the guard agrees with the file tools on every resolved identity.
- **Layout**: `task.md` (main task + acceptance criteria, read-only after creation), `subtasks/` (one file per subtask with its goal and acceptance condition), `progress.md` (per-subtask status `completed` / `in_progress` / `failed` plus the current pointer).
- **Flow**: create the folder and files at task start → read `progress.md` to pick the first unfinished subtask → read its file → execute it under the normal LCRD rollback rules (`lcrd_plan` + exogenous verifier, retry/learning on failure) → mark it `completed` in `progress.md` → next subtask. Subtask details stay in their files and enter the context only while executing, so the context keeps just the progress and the latest failure reason. When all subtasks are done, validate the whole task against `task.md`; on failure, revise the failing subtask's file and re-run it. On termination, mark the current subtask `failed` and summarize what was completed.

<a id="interaction-mode"></a>
## Interaction mode (interaction)

Controls how the agent behaves when human interaction is requested (approval prompts plus the `ask_user_question` tool):

| Value | Meaning | Use case |
|---|---|---|
| `auto` | Unattended autonomous decisions: approval requests auto-reject; `ask_user_question` auto-returns "decide on your own" and continues, never stalling | Evaluation, batch processing, CI |
| `auth` | Approval prompts go to a human answerer; `ask_user_question` stays interactive | Semi-automatic, human gate needed |
| `manual` (default) | Both approval and questions go to the configured UI answerers | Interactive use |

In `auto` mode the system prompt also steers the model not to request permission escalation, so it usually decides autonomously without asking; if it still tries to ask, the plugin intercepts and auto-answers, keeping the session unblocked.

<a id="verifier-choice"></a>
## Verifier: three choices

| kind | Model-supplied arguments | Verification |
|---|---|---|
| `assert` | `conditions: string[]` | A list of JS expressions over `result` (the structured tool value), `content` (the rendered text), or `isError`; each must reference at least one and must not hold on every probe input; all must hold to pass. Unbound, non-compiling, and tautological conditions are rejected at `lcrd_plan`, so they never become an effective check. A failed tool result always fails outright. The list must be non-empty: `lcrd_plan` rejects an empty one at the declaration, and a declaration that reaches the verifier anyway fails as an invalid check instead of passing everything |
| `python` | `checks: string[]` | A list of Python expressions over `result` / `content` / `isError`, evaluated by the plugin-fixed script template (the environment also injects `json`); same rules as assert, including the non-empty list; timeout kills and fails |
| `llm` | none | An independent session with a plugin-fixed prompt (root-anchor protocol + goal/stop_condition), temperature 0; non-JSON or non-PASS always fails |

Failure reasons localize the cause: evaluation errors carry the actual `result`/`content` types (so a shape mismatch self-corrects on the next plan), JS `in`-operator misuse gets a dedicated hint, and a negative condition rejected for missing discrimination gets a hint to use the positive form or the `llm` verifier.

<a id="test-scenarios"></a>
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
调用 lcrd_plan(goal='攻击演示', stop_condition='无', feasibility=true, verifier 为 {kind:'assert', conditions:['true']}),然后调用 fs 读取任意文件。预期声明被拒。
```

Expected log: `lcrd_plan:` rejection containing "必须引用 result". Writing `result === result` is rejected at the declaration with "缺少区分度".

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
调用 lcrd_plan(goal='测试', stop_condition='无', feasibility=false, verifier 为 {kind:'assert', conditions:['result !== undefined']}),然后调用 fs 读取 D:/deepseek/deepseek-harness/package.json。
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

<a id="recorded-events-and-dataset-export"></a>
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

Export a corpus (repository development tooling — the `lcrd:*` commands are not shipped in the npm package; an installed plugin exposes the in-process `datasetExport: run` path below):

```sh
pnpm run lcrd:dataset                                   # default flow root and output directory
pnpm run lcrd:dataset -- --root <flow root> --out <dir>  # explicit locations
```

It writes six files: `dataset.jsonl` (one record per protocol event, with `step`, `ts`, `task_group` for split grouping, `failureClass` for failed verdicts, an `infraFailure` flag, a `trainability` label, and every recorded field), `relaxations.jsonl` (one record per declaration that loosened after a failed verdict, carrying the consecutive failure count, that failure's class and exception kind, the preceding result's kind, both expression lists, the axes, a `cause` — `type-adaptation` when the check threw against the real value so its rewrite was expected, `substance-dropped` when strength fell after the work itself was judged incomplete, otherwise `undetermined` — and a `relax_type` — `spec_adjust` for a shape change that kept its strength, `environment_fault` when the engine or environment rejected the check, and `speculative_cheat` for a strength drop with no such cause; only the last is penalized by the gate and the online monitor), `runs.jsonl` (one row per run with the `run.json` metadata, or what the snapshot alone can tell for legacy runs), `anchor-judge.jsonl` (one request per run carrying an anchor excerpt, pairing the anchor with every declaration a judge must label as within or outside it), and the trainability split `trainable.jsonl` / `needs_review.jsonl` (the same rows as the full stream, partitioned by each row's `trainability` label; discarded failures appear only in the full stream). Failure classes are `assertion-invalid`, `tool-isError`, `honest-mismatch`, `python-timeout`, `exit-code`, `python-check-failed`, `llm-stop-unmet`, `llm-bad-output`, `infra-error`, and `unclassified`. The console report prints the groupings a reader needs to judge the corpus: task groups and how many repeat, runs by model, platform, and interaction mode, how many runs carry `run.json`, verifier kinds, pass/fail counts, failure classes, repeated declarations, relaxation axes and causes, relaxations by consecutive failure count, and anchor-judgement requests. Verdicts classified as `infra-error` are counted separately and excluded from the pass/fail and failure-class numbers, because they measure the machine rather than the model.

Anchor judging stays outside the exporter: write the labels it produced as JSONL (`{"run_id": …, "step": …, "label": …}`) and pass the file back to fold them onto the declarations:

```sh
pnpm run lcrd:dataset -- --anchor-labels <labels.jsonl>
```

### Install requirements

The package must stay resolvable from the **harness** as well as from the profile: the DeepSeek request-extension inventory resolves every active plugin entry to its package identity, and an entry it cannot resolve fails the whole model request with `REQUEST_EXTENSION`. Installing through `dsh plugin add` links it into the profile, which covers profile anchors; the repository root additionally lists this package in its `devDependencies` so harness anchors resolve too. Keep that entry when moving or renaming the package.

### Automatic export after a conversation (`datasetExport`)

Setting `datasetExport: run` makes the plugin append the finished run's rows to the same dataset and split files at disposal, so a conversation produces training-ready data with no separate command. The pipeline and watch commands below are repository development tooling:

```sh
pnpm run lcrd:pipeline          # one incremental pass over every settled, not-yet-exported run
pnpm run lcrd:watch             # poll every 10s and export each run as it finishes (Ctrl+C to stop)
pnpm run lcrd:pipeline -- --all # rebuild every file from scratch
pnpm run lcrd:dataset && pnpm run lcrd:dpo   # or export the corpus in two separate steps
```

The in-process and file-level paths write `dataset.jsonl`, `relaxations.jsonl`, `runs.jsonl`, and `dpo.jsonl`, and split every dataset row by trainability: `trainable.jsonl` holds rows whose label the engine decided deterministically (context rows, passing verdicts, and check rejections such as `assertion-invalid`), `needs_review.jsonl` holds rows whose label needs a human or LLM judge (`honest-mismatch`, `llm-stop-unmet`, `python-check-failed`, `tool-isError`, `unclassified`), and environment/verifier-infra failures (`infra-error`, `python-timeout`, `exit-code`, `llm-bad-output`) appear only in the full stream — so downstream training consumes the split files instead of a corpus that mixes ambiguous labels. Each row carries its `trainability` label so the split is reproducible without re-deriving it. The pipeline adds a `.pipeline-state.json` recording each run's fingerprint, so reruns never duplicate rows, and a run whose snapshot changed after export is exported again. A run is only picked up once its artifacts have settled (`--settle`, default 15s; the watch script uses 5s), and file-level export needs the session log, which the in-process path does not.

The DPO `chosen` side is constructed: it restores the pre-relaxation check onto the model's own declaration, and every pair is marked `"synthetic": true` with the `repair` name and the axes it reversed. `prompt` is the model-visible transcript up to the declaration (user, assistant text, tool calls, tool results, engine notices tagged `source=plugin`) and does not include the system prompt.

### Per-task views (`lcrd:view`)

The shared dataset files are one append-only corpus across every task. `pnpm run lcrd:view` projects them into `dataset/by-task/<task_group>/`, one directory per task group holding the same file names, so a consumer can read one task family without filtering:

```sh
pnpm run lcrd:view                                 # default dataset dir → dataset/by-task/
pnpm run lcrd:view -- --dataset <dir> --out <dir>  # explicit locations
```

Rows that carry `task_group` (`dataset.jsonl`, `trainable.jsonl`, `needs_review.jsonl`, `runs.jsonl`) group directly. `relaxations.jsonl`, `anchor-judge.jsonl`, and `dpo.jsonl` (through `meta.run_id`) join back through a run table built from every row that has both `run_id` and `task_group`; a row whose run never appears in that table lands in `_unknown/` rather than being dropped, so a join gap stays visible. Each run rebuilds the whole `by-task/` tree, so a group that left the shared files does not linger, and the shared files themselves are only read — the writers (`datasetExport`, `lcrd:dataset`, `lcrd:pipeline`) are untouched. Group names are sanitized into single path segments; a name that would escape the view (`..`, empty) falls into `_unknown/`. The view refuses an `--out` equal to the dataset directory or one of its ancestors, because rebuilding would delete the source it reads.

### Pluggable attribution (`attributionModule` / `--attribution`)

The default attribution is the log-heuristic taxonomy in `dataset.ts`: it maps a verdict's recorded reason, exception kind, and verifier kind to a `FailureClass`, a loosened declaration to a `RelaxationCause`, and every row to a `Trainability`. A professional task family often has its own failure vocabulary — a domain-specific classifier that better names what went wrong for its tasks. The attribution hook lets such a domain replace the whole taxonomy without forking the plugin:

```js
// domain-attribution.mjs — default export, or export an object without `default`
export default {
  classifyFailure(reason, exceptionKind, verifierKind) { /* domain rules */ },
  classifyRelaxationCause(failureClass, failureExceptionKind, axes) { /* domain rules */ },
  classifyTrainability(row) { /* domain rules */ },
}
```

- **In-process**: set `config.attributionModule` to the module path (relative paths resolve against the process working directory) or a package name. The plugin loads and validates it at startup and passes it to every `FlowRecorder`, so `datasetExport: run` rows carry the domain's labels.
- **Offline corpus**: `pnpm run lcrd:dataset -- --attribution ./domain-attribution.mjs` and `pnpm run lcrd:pipeline -- --attribution <module>` feed the same bundle into `buildRun`/`exportDataset`, replacing the re-derived failure and relaxation classification for every run.
- The bundle must export all three functions; a partial or invalid export fails loudly at load (`loadAttribution`). `classifyFailure` may omit the third `verifierKind` parameter — a two-argument implementation still satisfies the hook. The recorded fields a domain classifier reads are unchanged — attribution is a pure function of the logged row, so a domain bundle never touches live tool results or the session.
- DPO pair export defaults to `--causes substance-dropped` (shared as `DEFAULT_CAUSES`); pass `--causes all` to include `type-adaptation` and `undetermined` relaxations.

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
- **A replacement plan crosses the same declaration gates.** Policy may rewrite the plan, but a replacement whose conditions the engine rejects fails loud with `engine rejects`, so a hook cannot install an unchecked check.
- **Stop-condition consistency is a hook decision.** The core does not parse `stop_condition` semantics; a `checkPlan` that sees a stop condition and verifier expressions that disagree can `deny` or `modify`.
- **Interceptions consume no task retry budget.** `deny`, `block`, and a throwing hook are counted independently, bounded by `maxRetries`, and terminate the task for human review once they reach it; a new user command resets the count with the other per-task state. A `deny` also clears any earlier plan, so a rejected declaration cannot be bypassed by continuing with the previous one.
- **A malformed replacement plan fails loud**, and a throwing hook propagates below the cap (the model sees the hook's error) and terminates at it.
- The hook sees the result as LCRD's verifier saw it; a downstream `tools/post-execute` listener may still transform the accepted result afterwards.

<a id="flow-export"></a>
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
| `policy_version` | the policy version the run executed under; null when evolution is off |
| `tb_final_reward` | external sandbox reward when an evaluator supplied one; null otherwise |
| `tokens` | tokens the session's assistant messages accounted for |
| `plan_count` / `relax_types` / `cheat_rate` | declarations, relaxations by type, and `speculative_cheat / plan_count` |
| `hook_interceptions` / `path_violations` | policy-hook interceptions and file-flow path violations |

The flowchart chains every `lcrd_plan` declaration, tool call, verification verdict (PASS/FAIL n/3), learning round (lcrd_learn / learn PASS|FAIL n/3), and interception (missing plan / infeasible / terminated) in execution order; the final node reads "会话结束" or "任务终止转人工".

<a id="acceptance-criteria"></a>
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
4. verifier 三选一:assert(JS 表达式列表,每条作用于 result(工具的结构化值)/content(渲染文本)/isError(错误标记),至少引用其一,且对所有探测输入都成立将判"缺少区分度"而失败,全部为真才通过;工具执行失败时校验直接判 FAIL);python(Python 表达式列表,由插件固定脚本模板求值,规则同 assert,额外注入 json 模块);llm(独立校验会话,校验提示词由插件固定,对照根锚协议与你的 goal/stop_condition 判定,返回 {"verdict":"PASS"|"FAIL","reason":"..."};你无法提供或修改校验提示词)。
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

### The `lcrd_propose` tool (only when `evolveEnabled`)

#### What the model sees

The tool joins the list with `rationale`, `parent_version`, and a `skills` array. Its description states the order of operations (static scan, gate, approval) and asks the model to read returned `quarantineHints` before repeating a rejected idea. The model authors skill text and nothing else: it cannot write a gate result, a pointer, or an approval outcome.

#### Token effect

Schema tokens in every request while evolution is enabled, plus the proposal and its result. Gate children run in separate sessions and never enter this conversation.

#### KV Cache effect

Stable schema; the proposal result is appended after the reusable prefix.

## Known Limitations and Deferred Work

- File sandboxes: with a file sandbox in `workspace-write` mode, the task-flow root must sit inside the sandbox's writable workspace — otherwise the model's tool-mediated writes to the flow files are denied by the sandbox (the plugin's own directory creation bypasses it, but the model's `task.md`/`progress.md` updates cannot). Set `logDir` under the workspace so the task-flow root follows, or configure the sandbox to allow it.
- Learning is in-session: acquired knowledge enters the current context only, is never persisted, and never reuses across sessions; the evaluation criteria are model-authored, the plugin only counts, and the real verdict on learning is whether the re-solve passes the exogenous verifier.
- Learning mode adds API calls and token spend (each round includes declaration, knowledge acquisition, and self-evaluation); `maxLearningAttempts` and `learningEnabled` are the budget and switch guards.
- Each LLM-verifier check costs one independent API call; verifierModel defaults to the main model (isolation relies only on the separate session and fixed prompt, not cross-account isolation).
- The `assert` verifier interprets model-authored conditions in a restricted expression grammar (`src/expr.ts`): comparisons, boolean logic, `typeof`/`in`, property reads, and whitelisted inspection methods only. `this`, function construction, regex literals, dynamic `import`, and loops are not expressible, so a condition cannot reach the host process or block the event loop; a condition outside the grammar is rejected with its reason and a rewrite hint.
- Flow export writes synchronously after every protocol step (plan declaration, each tool verification), every completed turn (`turn/end` session event), agent disposal (`agent/disposed` global event), and process exit (`process.exit`); a long-lived process sees the latest export mid-conversation. A hard kill (SIGKILL) may lose the final events (best effort).
- The Python verifier depends on a system `python` command; Windows needs a runnable interpreter.
- Declaration-time gates (discrimination, presence-only, hold-rate ceiling) apply only to the `assert` verifier: python checks and the llm verifier have no JS condition list to probe at declaration time, so invalid python checks are rejected only by the post-execute verifier and a python declaration never carries a measured hold rate.
- Policy evolution only improves procedural knowledge (skill text); it does not change weights, so the ceiling is what a better prompt can buy. Weights remain the other loop.
- Gate cost is real: `evolveRepeats × holdout size × 2 + 1` model runs (the extra one is the candidate mount probe, which runs exactly once), bounded by `evolveGateMaxTokens`, `evolveRunMaxTokens`, and `evolveGateMaxWallMs`. Small samples are noisy, which is why `evolvePromote` defaults to `approval` and the report keeps every raw run.
- Holdout and hard-out isolation is a deployment responsibility: both must sit outside every root the model can read. The plugin validates that they are not inside a skill root, but cannot repair a permissive sandbox configuration.
- Static checks are heuristics and can be paraphrased around. The real defenses are "skills are data", the exogenous verifier, and human promotion.
- Statistical noise: the default gate (5 tasks × 3 repeats) is a small sample, and `evolveMinGain` alone is not a significance test. `evolveSignificance: bootstrap` is opt-in, requires reward admission and at least two paired runs, and can reject a real gain at small n. Keep `approval` until `lcrd:policy noise` shows `minDetectableGain <= evolveMinGain`; the normal-approximation floor ignores task stratification and paired correlation.
- Rejected-edit feedback is best-effort and bounded: only the newest 20 records are read, a corrupt line is skipped, and an append or read failure never blocks a proposal. The feedback can therefore be missing after an I/O failure.
- The termination and speculative-cheat thresholds are zero-tolerance policy rules, not hypothesis tests. A 2-vs-0 termination count can reject a candidate while Fisher's exact p is not significant; that is a deliberate policy choice, not proof the skill caused harm.
- The third-party package exemption is intentionally narrow: only `packages/experimental/lcrd` is whitelisted as an unpublished private package. If a second private third-party package arrives, generalize the rule to "unpublished ⇒ non-release member" instead of adding another directory whitelist.
- The online monitor folds runs at agent disposal; a one-shot process that exits without disposing an agent observes nothing.
- A `./invariant` companion is published (`src/invariant.ts`): it observes the durable policy store and the live skill registry — pointer integrity, skill digests, admitted gate reports, quarantine state, holdout draws, and recorded run lineage — because those relationships are now consumed by operations the plugin does not own.

<a id="dev-note"></a>
### Dev Note

`src/anchor.ts` owns the protocol wording and `PROTOCOL_VERSION`; raise the version whenever that wording changes so flows recorded earlier stay interpretable. The shipped `cordis.patch.yml` mounts the plugin as a profile layer with `maxRetries: 10`, `interaction: auto`, and `learningEnabled: true`. Policy evolution lives under `src/evolve/`: `store.ts` owns the pointer CAS and quarantine, `holdout.ts` the rotating draw, `static-check.ts` the pre-gate rules, `gate.ts`/`launch.ts` the admission run, `brief.ts` the review page, `monitor.ts` the online revert, and `invariant.ts` the durable relationship checks.
