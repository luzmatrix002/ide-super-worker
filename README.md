# IDE Super Worker

![IDE Super Worker async evidence lane](docs/social-card.png)

[中文说明](#中文说明) · [English](#ide-super-worker)

## 中文说明

> 让 Codex 专注于规划与审阅；把大文件阅读、修复循环和测试日志交给低成本异步 worker，并只返回可核查的压缩证据。

不要把宝贵的 Codex 上下文花在批量读文件、反复修补和超大 diff 上。

`ide-super-worker` 将耗时的编码工作委派给运行在更低成本
OpenAI 兼容网关上的异步 worker。Codex 仍负责规划、判断与审阅，只接收必要的
压缩证据：改动文件、检查结果、日志和可选的裁剪 diff。

> **2.6 测量状态：** 仓库已具备成对成本/质量指标和失败即停止的验收机制，但未附带
> 真实的 10 对试点或 200 任务正式评估。在这些门禁通过前，不应宣称已节省成本或质量
> 不劣，也不要仅凭此版本扩大默认自动路由。

![IDE Super Worker 效率通道 / efficiency lane](docs/efficiency-lane.svg)

### 它怎样工作

```mermaid
flowchart LR
  A["Codex\n规划与审阅"] -->|"精简 MCP 请求"| B["IDE Super Worker"]
  B -->|"启动"| C["Claude Code CLI\n后台任务"]
  C -->|"廉价模型网关"| D["OpenAI-compatible model"]
  C -->|"改动 + 检查"| B
  B -->|"压缩证据"| A
```

- `search`：零 LLM 的仓库发现。
- `analyze`、`review`：只读的低成本分析与审阅。
- `start`：将读文件、编辑、测试等实施循环放入后台 worker。
- `get`、`wait`：只把必要的文件变更、检查与摘要带回 Codex 主线程。

这样 Codex 专注于高价值判断，worker 吸收冗长的中间过程，减少主线程需要读取的
文件和测试日志。

### 纯证据模式（`WORKER_LITE_LLM=0`）

建议在本仓 MCP 配置中设置 `WORKER_LITE_LLM=0`，让判断权留在 Codex 主模型：标准 `analyze` / `review` 不再调用廉价 LLM，而是返回可核查的 `read_pack` / diff 证据；`shell` 失败摘要改为确定性提取，job `failure_digest` 与 red-team 跳过，`draft` 返回结构化拒绝。

该开关默认仍为 `1`，因此未配置时行为不变。显式 `quality_mode:"high"`、fan-out、语义审查和 `start` 执行路径不受影响。

### 质量优先模式

`analyze` 和 `review` 可显式传入 `quality_mode:"high"`。该模式是可选且
**失败即停止（fail-closed）** 的：三个固定角色分支完成分析后，交由独立审阅器裁决；
任何截断输出、空答案、模型不匹配、无效引用或未解决分歧，都会返回
`needs_direct_review` 或 `failed`，绝不悄悄回退为普通答案。

```mermaid
flowchart LR
  A["高质量请求"] --> B["主分析 / 独立 / 红队"]
  B --> C["独立审阅器"]
  C --> D{证据与结论完整？}
  D -->|是| E["quality.v1 结果"]
  D -->|否| F["人工直接审阅 / 失败"]
```

默认仍为 `standard`。只有通过真实冻结任务、盲评和 Trial A → B → C 的资格门禁，
才可讨论更改默认路由。详细的中英文迭代说明见
[质量优先迭代说明](docs/quality-first-iteration.zh-CN.md)。

### 快速开始

```bash
npm install
npm run build
npm test
```

配置示例与完整工具说明在下方英文文档中；质量模式环境变量示例见
[`.env.example`](.env.example)，评估要求见 [eval/README.md](eval/README.md)。

---

Stop spending premium Codex context on bulk code reading, patch loops, and giant diffs.

`ide-super-worker` lets Codex delegate the expensive part of a coding task to an async worker running on a cheaper OpenAI-compatible model gateway. Codex stays in charge, but it only receives the compact evidence it needs: changed files, checks, logs, and an optional trimmed diff.

> **2.6 measurement status:** the repository now has paired cost/quality instrumentation and fail-closed acceptance, but no real 10-pair pilot or formal 200-task evaluation is bundled. Treat savings and non-inferiority as unproven until those gates pass; do not expand default automatic routing from this release alone.

![IDE Super Worker efficiency lane](docs/efficiency-lane.svg)

## Efficiency First

Most AI coding tools optimize the model call. This project optimizes the route.

The fast path is deliberately split:

- `search` handles repo discovery with zero LLM calls.
- `analyze` and `review` use one cheap gateway call for read-only work.
- `start` moves implementation loops into an async worker so Codex is not blocked by every file read, failed attempt, or test log.
- `get` and `wait` return compact evidence instead of dumping the whole transcript back into the premium thread.

That routing discipline is the efficiency edge: Codex stays focused on planning and review while the worker absorbs the bulky middle.

## The Simple Picture

Without this worker, Codex often pays to ingest everything:

```text
Codex main thread
  -> reads large files
  -> runs repair loops
  -> receives full diffs
  -> burns premium context
```

With this worker, Codex delegates the noisy middle:

```mermaid
flowchart LR
  A["Codex<br/>planner and reviewer"] -->|"small MCP start request"| B["IDE Super Worker"]
  B -->|"launches"| C["Claude Code CLI<br/>background job"]
  C -->|"Anthropic messages"| D["Local adapter"]
  D -->|"OpenAI-compatible chat"| E["Cheap gateway model<br/>DeepSeek / OneAPI / New API"]
  C -->|"git diff + checks"| B
  B -->|"changed_files + checks<br/>optional diff"| A
```

Plain version:

```text
Codex asks: "fix this, run tests"
Worker does: read files -> edit -> test -> summarize
Codex gets: files changed + checks passed + optional diff
```

## Why It Exists

Codex is strongest when it coordinates, reviews, and decides. It is not always cost-effective to make the main Codex thread read huge files, run long repair loops, and ingest giant diffs.

This worker changes the shape of the bill:

- Codex sends a compact `start` request.
- Claude Code does the heavy local work in the background.
- The local adapter routes model traffic to your cheaper backend.
- Codex receives `changed_files`, `checks`, logs, and an optional trimmed diff.

For large code-reading and patching tasks, this can cut the expensive main-thread token intake dramatically because Codex no longer has to ingest every intermediate file read and full patch body.

## What Makes It Better Than "Just Use A Cheaper Model"

Cheap models alone are not enough. You still need routing, safety, result shape, and verification.

This project gives you the missing plumbing:

- A Codex-native MCP interface, so delegation is one tool call.
- A Claude Code execution loop, so the worker can actually edit and test.
- A local Anthropic-to-OpenAI adapter, so Claude Code can use cheaper gateways.
- Scope enforcement and check commands, so work is auditable.
- Compact result payloads, so Codex does not swallow unnecessary tokens.
- Metrics, fallback, retries, and optional worktree isolation for real operations.

## Efficiency Comparison

| Workflow | What usually happens | Efficiency gap | IDE Super Worker path |
| --- | --- | --- | --- |
| Direct premium-agent coding | The main agent reads files, retries fixes, sees every test log, and ingests large diffs. | Premium context becomes the workspace transcript. | Codex sends one small task; worker returns changed files, checks, logs, and optional diff. |
| Generic cheaper-model wrapper | A cheaper model runs, but the main agent still needs bulky context and manual verification. | Lower model price, same noisy workflow. | Cheap gateway handles bulk tokens; scoped checks and compact results decide whether work is trustworthy. |
| Full agent loop for read-only questions | Starting an edit-capable loop for summaries and discovery. | Slow startup and unnecessary write surface. | `search` is zero-LLM; `analyze`/`review` are read-only cheap calls. |
| Parallel implementation in one repo | Dirty worktrees collide and review payloads grow. | Coordination overhead eats the gain. | Optional worktree isolation plus scoped patch checks keep jobs separable. |

## Highlights

- Async MCP tools: `start`, `get`, `tail`, `wait`, `cancel`.
- Read-only lite tools: `read_pack`, `analyze`, `diff_digest`, `history`, and `draft` keep bulky reading/review/drafting out of the premium thread. `read_pack` keeps its inline payload at or below 16 KB; when not all slices fit, `truncated:true` signals that the complete pack is available through `receipt.artifact_refs`.
- Code review lite tool: `review` checks diffs/files through the cheap gateway.
- Zero-LLM repo discovery and mechanical work: `search` uses bounded local search, and `apply_edits` handles deterministic replacements without a model call.
- Worker-side command digesting: `shell` can run tests/builds/lint and return a compact failure digest. Test and typecheck exits return public `status:"failed"` with canonical `failure`, `failure_kind`, and `required_action`, while their receipt/metric remains `ok`; timeouts, missing commands, permission failures, and other infrastructure failures remain tool errors.
- Receipt abnormal-output assessment: every receipt carries a deterministic accept/repair verdict and bounded repair guidance without default multi-model voting.
- Runtime tool containment: the worker classifies tool errors, opens per-tool/per-error-class circuits, intercepts unhealthy routes, and uses deterministic fallbacks for `review`/`analyze` when the LLM route is unhealthy.
- Reliability tiers and episode summaries: `start` can record `lite`, `standard`, `strict`, or `critical` expectations without blocking old callers; hard rejection happens only with `blocking_policy:"enforce"`.
- Outcome v1: job-control, rejection, and failure payloads add one versioned semantic outcome while preserving the 2.5 legacy projection.
- Independent semantic verification: `semantic_gate:"required"` performs a dedicated cache-free review and fails closed when evidence is missing or inconclusive.
- Anthropic-to-OpenAI adapter: lets Claude Code talk to OpenAI-compatible gateways.
- 429 and 5xx retry handling with `Retry-After` support.
- Optional `include_diff:false` to return only `changed_files` and `checks`.
- Deterministic verification layer: scope checks, command checks, result signals, and bounded auto-revise.
- Cost telemetry: writes gateway token usage and worker tool-call categories to JSONL when `WORKER_METRICS_FILE` is set.
- Paired evaluation telemetry: validates and imports direct/worker EvalSpan JSONL into a separate `WORKER_EVAL_SPAN_FILE`.
- Optional fallback gateway when the primary provider fails.
- Optional worktree isolation for parallel jobs inside one repository.
- Secret redaction in logs and tool responses.

## Deterministic-Only Mode (WORKER_LITE_LLM=0)

Set `WORKER_LITE_LLM=0` when the main Codex model should retain judgment instead of importing unsupported conclusions from the cheap-LLM lane. Standard `analyze` and `review` then return deterministic `read_pack` or diff evidence for the caller to interpret.

In this mode, failed `shell` commands use a deterministic digest, job `failure_digest` and diff red-team judgment are skipped, and `draft` returns a structured rejection. The default remains `1`, so existing installations keep their current behavior unless they opt in.

Explicit `quality_mode:"high"`, fan-out, the semantic reviewer, and the `start` execution path are unaffected.

## Use Cases

Use it when you want Codex to stay sharp instead of stuffed:

| Task | Normal flow | Worker flow |
| --- | --- | --- |
| Fix a bug in a large repo | Codex reads many files and test outputs | Worker reads/edits/tests, Codex reviews compact result |
| Summarize implementation details | Full agent loop may start | `analyze` calls cheap gateway directly |
| Run repeated repair passes | Main thread absorbs every attempt | Worker handles loop and returns final evidence |
| Parallel scoped edits | One dirty worktree gets tangled | Optional git worktree isolation keeps jobs apart |
| Cost accounting | Claude Code cost may be misleading | Gateway token usage is written to JSONL |

## Tool Surface

| Tool | Purpose |
| --- | --- |
| `start` | Start an async Claude Code job in an allowed directory. Supports optional sequential `stages`. |
| `get` | Read current job lifecycle plus authoritative `outcome`; pass `verbose:true` for the full legacy payload. |
| `get_artifact_slice` | Read a bounded redacted slice from an artifact referenced by a worker receipt. Artifact refs are process-local and may expire after an MCP worker restart. |
| `tail` | Read recent worker logs. |
| `wait` | Wait for completion without killing the job on poll timeout; a poll timeout keeps `outcome.status="running"`. |
| `cancel` | Kill a running job process tree. |
| `analyze` | Read-only analysis for selected files or bounded globs. `quality_mode:"high"` opts into the fail-closed `quality.v1` three-target pipeline. |
| `review` | Review a job diff/checks or selected files. `quality_mode:"high"` requires three branches plus an independent evidence adjudicator. |
| `search` | Zero-LLM bounded repository search using `rg` when available. |
| `read_pack` | Zero-LLM context packer for selected paths; returns up to 16 KB of ordered symbol/keyword slices and stores the complete pack behind an artifact ref. |
| `diff_digest` | Summarize current git diff by file, hunk headers, and risk; optionally run cheap red-team review. |
| `shell` | Run bounded worker-side commands with optional `digest:true` for test/build/lint output. |
| `apply_edits` | Zero-LLM literal or regex replacements with replacement-count checks. |
| `history` | Bounded git log/blame timeline for file or line archaeology. |
| `draft` | Draft commit messages, PR descriptions, changelog notes, or release notes from the current diff. |

## Quick Start

```powershell
npm install
npm run build
npm run test
npm run smoke
```

Create a local `.env` from `.env.example` or set environment variables in your shell. Never commit real keys.

```powershell
setx ONEAPI_API_KEY "your-provider-key"
setx ONEAPI_BASE_URL "https://your-gateway.example.com/v1"
setx SANDBOX_ROOT "D:/workspaces"
```

Then run:

```powershell
npm run doctor
npm run doctor:network
```

## Codex Desktop Config

Copy and adapt `codex-mcp.example.toml` into your Codex config.

```toml
[mcp_servers.codex_async_worker]
command = "node"
args = ["D:/path/to/ide-super-worker/dist/index.js"]
cwd = "D:/path/to/ide-super-worker"
startup_timeout_sec = 10
tool_timeout_sec = 3600
env = { SANDBOX_ROOT = "D:/workspaces", ONEAPI_BASE_URL = "https://your-gateway.example.com/v1", CLAUDE_MODEL = "deepseek-v4-flash", CLAUDE_CODE_MODEL = "sonnet", WORKER_SEMANTIC_REVIEW_MODEL = "deepseek-v4-pro", CLAUDE_PERMISSION_MODE = "acceptEdits", USE_OPENAI_ADAPTER = "1", WAIT_DEFAULT_MS = "1800000" }
env_vars = ["ONEAPI_API_KEY"]
```

## Example Job

```json
{
  "prompt": "Fix the failing tests with the smallest safe code change.",
  "allowed_dirs": ["D:/workspaces/my-project"],
  "model": "deepseek-v4-flash",
  "permission_mode": "acceptEdits",
  "include_diff": false,
  "verification_policy": { "version": 1, "task_kind": "modifying" },
  "semantic_gate": "required",
  "scoped_patch": {
    "paths": ["src", "tests"],
    "max_diff_bytes": 20000
  },
  "checks": [
    { "name": "unit tests", "command": "npm test", "timeout_ms": 600000 }
  ]
}
```

Typical result:

```json
{
  "contract_version": "outcome.v1",
  "outcome": {
    "status": "accepted",
    "reason_codes": ["verification_passed"],
    "verification": {
      "executor": "passed",
      "scope": "passed",
      "checks": "passed",
      "semantic": "passed"
    }
  },
  "job_status": "completed",
  "changed_files": ["src/a.ts", "tests/a.test.ts"],
  "checks": ["scoped_patch: passed (src, tests)", "unit tests: passed"],
  "diff": ""
}
```

`outcome` is authoritative for acceptance. `job_status`, `status`, `receipt`, `abnormal`, and the verbose result retain their 2.5 meanings as compatibility projections; they remain throughout 2.x for at least 90 days and can only be removed in 3.0. A legacy request without `verification_policy` still executes, but its Outcome cannot become `accepted`.

Outcome v1 also fails closed as `needs_evidence` when the starting worktree is already dirty, Git cannot provide a reliable change summary, reviewer input is truncated, or a multi-stage pipeline lacks complete prior-stage evidence. Legacy execution is not blocked, but those cases are not claimed as accepted.

Outcome v1 workspace evidence is Git-based. Jobs with additional writable roots cannot become `accepted`, and Git-ignored file contents or side effects outside the workspace are not attested in 2.6. Prefer isolated worktrees and keep ignored/runtime data out of the declared modification scope; full WorkspaceCapsule evidence remains a later iteration.

Use `include_diff:false` by default when Codex only needs to decide whether the job succeeded. Ask for the diff only when you actually need to review patch details.

## Cost Controls

This project stacks several cost controls:

These controls reduce main-thread context, payload size, and accounting noise; they do not impose a spend ceiling on the worker LLM. Primary, fallback, and escalation models are chosen by capability and reliability configuration, not by price gates. `WORKER_PRICE_*` values are for reporting only and must not downgrade, block, or skip fallback/escalation usage.

- `include_diff:false` reduces high-cost Codex ingestion.
- `DIFF_MAX_BYTES` caps patch payloads.
- `INCLUDE_DIFF_DEFAULT=0` makes omitted `include_diff` behave like `false`.
- `CHECK_OUTPUT_RESPONSE_MAX` keeps failed check output compact in `get`/`wait` responses while `tail` retains fuller logs.
- `analyze` skips Claude Code for read-only summaries.
- `search` handles symbol/file discovery without any LLM call.
- `review` and `WORKER_FAILURE_DIGEST=1` move diff review and failure diagnosis to the cheaper gateway.
- `read_pack`, `diff_digest`, `shell digest`, `apply_edits`, `history`, and `draft` move the remaining high-token planning/review chores into worker lanes.
- `WORKER_METRICS_FILE` records real gateway token usage plus `event=tool_call` rows for zero-LLM worker calls. Successful/cache Lite rows also include additive `queue_wait_ms`, `upstream_ms`, `e2e_ms`, and `attempt_count` fields for latency diagnosis.
- `WORKER_EVAL_SPAN_FILE` stores validated paired-evaluation records separately; it never falls back to `JobResult.total_cost_usd`.
- `WORKER_ESCALATE_MODEL` upgrades only failed, difficult revise passes.
- `WORKER_RELIABILITY_TIER`, `WORKER_BLOCKING_POLICY`, `WORKER_SEMANTIC_GATE`, and `WORKER_TOOL_BUDGET` record reliability expectations and blocking risk. Defaults are observe-only to avoid surprise stalls.
- `WORKER_ISOLATION=worktree` allows safe parallel work in one repo.
- Prompt-cache-friendly usage keeps stable instructions before dynamic task text.

Claude Code's own `total_cost_usd` may reflect Anthropic pricing, not your gateway pricing. Use `WORKER_METRICS_FILE` and provider prices for real accounting.

## Cost-Saving Checklist

For best results:

1. Set `include_diff:false` for delegated implementation tasks.
2. Keep `scoped_patch.paths` narrow.
3. Add concrete `checks` so the worker proves completion.
4. Use `analyze` for read-only questions.
5. Enable `WORKER_METRICS_FILE` and compare token usage by route/model.
6. Use `read_pack` instead of full-file reads and `diff_digest` instead of full diff ingestion.
7. Use `shell` with `digest:true` for tests/builds/lint so command output is summarized before Codex sees it.
8. Keep `start` below 30% of worker calls; use finer tools for search, reading, diff digestion, history, drafts, and mechanical edits.
9. Treat receipt `abnormal.verdict !== "accept"` as a repair signal before considering multi-model parallel review. For `shell`, use `failure_kind` and `required_action` first; do not escalate to the main model just because the command exit code is non-zero.
10. Use a fit-for-task default model and reserve `WORKER_ESCALATE_MODEL` for difficult revise passes; do not downgrade primary, fallback, or escalation models because of cost.

## Important Environment Variables

For less common stats, cache, reliability, and circuit-breaker settings, see [Advanced Configuration](docs/advanced-config.md).

| Variable | Purpose |
| --- | --- |
| `SANDBOX_ROOT` | Root directory allowed for worker jobs and `analyze` file reads. |
| `WORKER_ALLOW_FILESYSTEM_ROOT` | Emergency override. Set `1` to permit jobs/searches at a drive root; disabled by default to prevent accidental whole-disk scans. |
| `ONEAPI_BASE_URL` / `ANTHROPIC_BASE_URL` | Primary gateway URL. |
| `ONEAPI_API_KEY` / `ANTHROPIC_API_KEY` | Primary gateway key. Keep it out of git. |
| `CLAUDE_MODEL` / `ANTHROPIC_MODEL` | Real backend model used by the gateway. |
| `CLAUDE_CODE_MODEL` | Model name passed to Claude Code for local validation, usually `sonnet`. |
| `USE_OPENAI_ADAPTER` | `1` to use the local Anthropic-to-OpenAI adapter. |
| `MAX_RUNNING_JOBS` | Per-MCP secondary limit for accepted heavy jobs, default `4`, clamped to `1-100`. |
| `WORKER_GLOBAL_COORDINATION_DIR` | Shared machine-local FIFO state directory. Defaults to a per-user namespace under the OS temp directory. All MCP instances that should share limits must use the same value. |
| `WORKER_GLOBAL_HEAVY_MAX` | Machine-global active `start` job limit, default `1`. |
| `WORKER_GLOBAL_HEAVY_QUEUE_MAX` | Machine-global waiting `start` job limit, default `8`; excess jobs fail with a retryable busy error. |
| `WORKER_GLOBAL_LITE_MAX` | Machine-global active gateway-call limit for analyze/review/semantic/fan-out work, default `1`. |
| `WORKER_GLOBAL_LITE_QUEUE_MAX` | Machine-global waiting lite-call limit, default `12`; excess calls fail with a retryable busy error. |
| `WORKER_GLOBAL_ACQUIRE_TIMEOUT_MS` | Maximum wait for a global Heavy or Lite slot, default `600000` ms. |
| `DIFF_MAX_BYTES` | Maximum returned diff size. |
| `INCLUDE_DIFF_DEFAULT` | Default for omitted `include_diff`; set `0` to omit diffs unless explicitly requested. |
| `CHECK_OUTPUT_RESPONSE_MAX` | Per-check output cap for compact `get`/`wait` responses. |
| `WORKER_METRICS_FILE` | Optional JSONL path for token usage, tool audit, and Lite latency metrics. |
| `WORKER_QUALITY_TARGETS_FILE` | Optional path to the untracked versioned three-branch + reviewer config used only by `quality_mode:"high"`; keys are referenced by environment-variable name. |
| `WORKER_EVAL_SPAN_FILE` | Optional, separate JSONL path for validated direct/worker EvalSpan records. |
| `WORKER_EVAL_SUITE_ID` / `WORKER_EVAL_TASK_ID` / `WORKER_EVAL_RUN_ID` / `WORKER_EVAL_ARM` | Optional correlation context appended to worker metrics during isolated eval runs. |
| `WORKER_PRICE_INPUT` / `WORKER_PRICE_OUTPUT` / `WORKER_PRICE_CACHE` | Optional USD-per-1M-token prices used by `npm run stats`; accounting only, never a worker LLM cost gate. |
| `WORKER_PRICE_TABLE` | Optional JSON model price overrides for `npm run stats`; must not affect primary/fallback/escalation selection. |
| `WORKER_LITE_LLM` | Set `0` to disable the cheap-LLM judgment lane: standard `analyze`/`review` return deterministic evidence packs, shell failure digests become deterministic, job `failure_digest` and red-team judgment are skipped, and `draft` is rejected. Explicit `quality_mode:"high"`, fan-out, the semantic reviewer, and `start` are unaffected. Default `1`. |
| `WORKER_FAILURE_DIGEST` | Set `1` to generate a cheap-gateway diagnosis on failed jobs. |
| `WORKER_DIGEST_BEFORE_REVISE` | Set `0` to avoid generating a failure digest before auto-revise. |
| `WORKER_LITE_MODEL` | Optional cheaper model for `analyze`, `review`, and `failure_digest`. |
| `WORKER_LITE_CACHE_DIR` | Optional disk cache directory for lite read-only tools; must be inside `SANDBOX_ROOT`. |
| `WORKER_LITE_CACHE_TTL_MS` | TTL for lite disk cache entries, default `3600000`; `0` bypasses cache. |
| `ADAPTER_PREFIX_CACHE` | Set `1` to use prefix-cache-friendly `analyze` messages. |
| `WORKER_FALLBACK_WARN_EVERY` | Warn every N fallback calls; default `5`, `0` disables. |
| `WORKER_OVERALL_TOOL_ERROR_MAX_PCT` | Gate threshold for total worker tool error rate; default `5`, and the rate must stay below this value. |
| `WORKER_SINGLE_TOOL_ERROR_MAX_PCT` | Gate threshold for each individual tool's error rate; default `3`, and the rate must stay below this value. |
| `WORKER_CATEGORY_ERROR_MAX_PCT` | Gate threshold for category-level tool error rate; default `5`. `WORKER_TOOL_ERROR_MAX_PCT` remains as a legacy alias. |
| `WORKER_TOOL_ERROR_MIN_CALLS` | Minimum sample count before category or single-tool error-rate gates apply; default `10`. |
| `WORKER_TOOL_REVIEW_INTERVAL_MS` | Runtime tool error-rate review interval while the MCP server is running; default `10800000` (3 hours). |
| `WORKER_TOOL_REVIEW_SINCE_MINUTES` | Review window for runtime tool error-rate control; default `180`. |
| `WORKER_TOOL_REVIEW_GRACE_MS` | How late a scheduled review can run before it is treated as overdue; default `300000`. |
| `WORKER_TOOL_REVIEW_DISABLED` | Set `1` to disable the runtime review loop. |
| `WORKER_IDLE_EXIT_MS` | Exit a worker process after this much inactivity when no job is running; default `300000` (5 minutes). Each MCP request resets the deadline; `0` disables idle exit. |
| `WORKER_TOOL_CIRCUIT_BREAKER` | Active runtime containment switch; default enabled. Set `0` to disable per-tool/per-error-class circuits. |
| `WORKER_TOOL_CIRCUIT_WINDOW_MS` | Rolling window for immediate circuit decisions; default `900000`. |
| `WORKER_TOOL_CIRCUIT_OPEN_MS` | How long an opened circuit intercepts the unhealthy route; default `300000`. |
| `WORKER_TOOL_CIRCUIT_MIN_CALLS` | Minimum calls before generic per-tool error-rate circuits can open; default `3`. |
| `WORKER_TOOL_CIRCUIT_MIN_ERRORS` | Minimum errors before generic per-tool circuits can open; default `2`. |
| `WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS` | Minimum same-class errors before a per-error-class circuit can open; default `2`. |
| `WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES` | Comma-separated classes that open a circuit immediately; default `upstream_404,shell_mismatch`. |
| `WORKER_TOOL_CIRCUIT_STATE_FILE` | Optional persisted circuit state path. Defaults to `WORKER_METRICS_FILE + ".state.json"` so open circuits and a bounded rolling-event snapshot survive MCP restarts. |
| `WORKER_TOOL_CIRCUIT_STATE_EVENT_MAX` | Maximum recent tool-control events persisted with circuit state; default `200`, set `0` to persist only open circuits. |
| `WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS` | Minimum interval for non-error state snapshots; default `30000`. Errors and circuit opens force a save. |
| `WORKER_TOOL_CIRCUIT_STATE_LOCK_STALE_MS` | Best-effort state lock stale threshold; default `30000`. Lock contention skips the snapshot instead of blocking tool calls. |
| `WORKER_ESCALATE_MODEL` | Optional stronger model for hard revise passes. |
| `WORKER_RELIABILITY_TIER` | Default `start` reliability profile: `lite`, `standard`, `strict`, or `critical`; default `standard`. |
| `WORKER_BLOCKING_POLICY` | How missing reliability gates behave: `observe`, `warn`, or `enforce`; default `observe`. |
| `WORKER_SEMANTIC_GATE` | Declared semantic-review expectation: `off`, `warn`, or `required`; critical jobs default to `warn`. |
| `WORKER_SEMANTIC_REVIEW_MODEL` | Dedicated model used for the independent semantic verifier. Required for a `required` gate to pass. |
| `WORKER_SEMANTIC_REVIEW_TIMEOUT_MS` | End-to-end semantic-review deadline, default `60000`, capped at 5 minutes. |
| `WORKER_TOOL_BUDGET` | Optional advisory max tool-call budget recorded in metrics and reliability profile. |
| `WORKER_ISOLATION` | Set to `worktree` for per-job git worktree isolation. |
| `FALLBACK_BASE_URL` / `FALLBACK_API_KEY` | Optional fallback gateway. |
| `FALLBACK_MODELS` | Optional comma-separated fallback model pool, capped at 3 model candidates for bounded routing. Overrides `FALLBACK_MODEL` / `FALLBACK_ESCALATE_MODEL` when set; not a cost cap. |

## Security Model

- All job paths must resolve inside `SANDBOX_ROOT`.
- `scoped_patch` rejects changes outside declared paths.
- `bypassPermissions` is blocked unless explicitly enabled with `ALLOW_BYPASS_PERMISSIONS=1`.
- Secrets are redacted from logs and tool responses.
- `.env`, archives, logs, `node_modules`, and `dist` are gitignored.

See [SECURITY.md](SECURITY.md) for responsible disclosure and operational notes.

## Validation

```powershell
npm run build
npm run test
npm run smoke
npm run doctor:network
npm run skills:validate
npm run eval:contracts
npm run eval:fixtures
npm run codex:audit -- --since-minutes=60
npm run codex:guard
```

`doctor:network` depends on your real gateway credentials. Build, test, and smoke should pass offline.

`npm run codex:audit -- --since-minutes=60` checks recent worker metrics, receipt artifact coverage, the persisted `AGENTS.md` routing rules, fallback usage, and worker category evidence. It also prints the known blind spot: direct main-thread shell output, full-file reads, chat context, and pasted prompts are outside `WORKER_METRICS_FILE`.

`npm run codex:guard` runs both the local Codex audit and `stats:gate`, even when the first check fails, and preserves strict point-gate exit behavior. `npm run codex:guard:watch` adds a two-attempt MCP initialize/tools-list canary, 1h/24h/7d health state, atomic status file, and deduplicated Windows Application Event Log transitions. Install the 15-minute, non-overlapping Windows task from an elevated shell with `npm run codex:guard:install`; remove only the task and Event Log source with `npm run codex:guard:uninstall`.

Set `WORKER_ROUTING_EVENTS_FILE` to a separate JSONL file and configure Codex `PreToolUse` plus `PostToolUse` hooks to pipe their JSON input to `node scripts/codex_routing_hook.mjs`. The hook records only bounded classifications and hashed correlation IDs, never raw commands, paths, patches, or responses. `npm run stats` then reports `scope=hook_observable` effective worker coverage, main-direct, rejection, and unknown rates. This is not global task coverage: hosted tools, hook opt-outs, missing Post events, and route-blind activity remain explicit blind spots. The previous `worker/(worker+main)` value is labelled `legacy_recorded_worker_share`.

The watch states are `HEALTHY`, `QUIET`, `RECOVERING`, `DEGRADED`, `TELEMETRY_FAULT`, and `UNAVAILABLE`. A point gate can fail on a sparse local breach, while an alert requires the same scope to breach both 1h and 24h in two consecutive watch runs. A 7d-only breach is `RECOVERING`; no eligible demand plus a passing canary is `QUIET`. The same-host task cannot notify while Windows is powered off or the task itself is disabled. Artifact refs remain process-local. Latency percentiles, queue time, retry, fallback, and circuit counts remain observe-only until a real seven-day baseline exists.

`npm run eval:contracts` validates the EvalSpan v1 importer and paired/pilot fail-closed rules. `npm run eval:fixtures` verifies the frozen 10-task pilot corpus and its SHA-256. Import external usage with `npm run eval:gate -- --import producer.jsonl --out .eval/eval-spans.jsonl`; gate a completed pilot with `npm run eval:gate -- --input .eval/eval-spans.jsonl --mode pilot`. `WORKER_METRICS_FILE` is operational telemetry, not a substitute for the required raw provider export for non-zero worker-model usage; without that provider export, the pilot is incomplete. The pilot proves measurement completeness only, not cost savings or quality non-inferiority. The full producer and formal-manifest contract is in [eval/README.md](eval/README.md); run the preregistered 200-400 task gate with `npm run eval:formal -- --input <spans.jsonl> --manifest <manifest.json>`.

`npm run eval:quality -- --input <quality-pairs.jsonl>` evaluates the separate
Trial A -> B -> C quality qualification program. Passing unit tests or a 40+40
engineering pilot does not authorize high mode as the default; only real frozen,
blindly evaluated pairs can produce that qualification. See
[QUALITY_FIRST_PLAN.md](QUALITY_FIRST_PLAN.md), [eval/README.md](eval/README.md),
and the bilingual [quality-first iteration guide](docs/quality-first-iteration.zh-CN.md).

`npm run skills:validate` checks the project-specific `.claude/skills/` library used to preserve project doctrine for cheaper or lower-context worker sessions.

`npm run stats` reports gateway token usage, receipt byte/artifact usage, a legacy recorded-worker-share audit, and—when `WORKER_ROUTING_EVENTS_FILE` is configured—hook-observable routing coverage. `npm run stats:gate -- <metrics.jsonl>` is a health gate with exit code 2 on failure. Category routing targets (search 80%, context_pack 70%, command_digest 70%, diff_digest 60%, review 60%, mechanical_edit 50%, history 60%, draft 80%, analysis 60%) and the `start` share target (at most 30%) remain warnings until a real seven-day baseline exists. Gate mode still fails if required categories have no audit evidence, sampled overall/category/tool execution-error rates breach their limits, large receipt payloads lack artifact refs, or `diff_digest` red-team coverage falls below 30%. Fallback share remains observable rather than blocking during the baseline period. Rejected/not-attempted calls are not worker execution errors. Shell metrics expose canonical `failure_class`, initial/final shell and exit code, reroute outcome, retry count, command fingerprint, process-local artifact refs, `worker_execution_result`, and the separate `workload_result`.

When the MCP server starts it immediately reviews recent tool error rates without blocking connection. True infrastructure errors schedule a trailing 30-second, single-flight review with at least 60 seconds between runs; workload failures and rejected inputs do not. The existing 3-hour timer remains a low-frequency reconciliation. A threshold breach, or a review that runs later than `WORKER_TOOL_REVIEW_GRACE_MS`, enables escalation self-heal defaults for later `start` calls: `reliability_tier=strict`, `blocking_policy=warn`, `semantic_gate=warn`, `auto_revise=true`, and at least one revise pass. Explicit `start` arguments still win over these defaults.

Runtime containment is more aggressive than the 3-hour review. Every tool result updates an in-memory rolling window. Real tool execution errors are classified (`upstream_404`, `upstream_error`, `shell_mismatch`, `search_timeout`, `timeout`, `missing_command`, `missing_path`, `permission_denied`, `dependency_missing`, or `unknown_failure`). Repeated errors, or any immediate-class error, open a temporary circuit. While open, unhealthy routes are intercepted as `rejected` instead of producing more errors; `review` and `analyze` degrade to deterministic local evidence when possible. Open circuits and a bounded rolling-event snapshot are persisted to a state sidecar file and reloaded on MCP startup or the next tool-control decision, so restarts do not immediately forget an unhealthy route or a tool already close to its circuit threshold. To keep the hot path cheap, OK outcomes are snapshotted only after `WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS`; errors and circuit opens force a save. Shell command business failures still record `command_status` and do not count as tool errors. On Windows, PowerShell-shaped shell commands accidentally sent through `cmd.exe` are retried once through `powershell -NoProfile -ExecutionPolicy Bypass -Command`.

Additional redundancy that is already in place:

- Gate redundancy: `codex:guard` combines recent routing audit evidence with `stats:gate`.
- Route redundancy: `review`/`analyze` can fall back to local deterministic evidence while LLM review routes are unhealthy.
- Shell redundancy: shell mismatch is retried once through the matching Windows shell before surfacing failure.
- State redundancy: circuit state is atomically written with a temp file plus rename, protected by a best-effort lock, guarded by a checksum, and pruned on load. Corrupt, mismatched, or expired state is ignored and rewritten instead of crashing the MCP server.
- Restart redundancy: a small rolling-event snapshot is restored with open circuits so a restart does not erase tools that are already near a circuit threshold.
- Efficiency guardrail: state writes are bounded by event count and save interval; lock contention skips a snapshot instead of delaying the worker.

The routing contract tests lock the core money/safety invariants:

- I3: no predictive classifier call before routing.
- I5: identical read-only requests hit cache; primary failure plus fallback records one successful upstream.
- I6: read-only tools do not write to the workspace.

The smoke test also verifies the current tool surface: `analyze`, `apply_edits`, `cancel`, `diff_digest`, `draft`, `get`, `get_artifact_slice`, `history`, `read_pack`, `review`, `search`, `shell`, `start`, `tail`, and `wait`.

## When To Use It

Use this worker for:

- long codebase reading tasks,
- scoped code edits with tests,
- repeated repair loops,
- cheap model summaries,
- background implementation while Codex continues planning/reviewing.

Keep the main Codex thread for high-level decisions, code review, final integration, and tasks that require your most capable model directly.

## Attribution

This project builds on ideas from several sources:

- **Latent-recurrent reasoning depth** — Geiping et al., 2025. The deterministic relaxation approach in `src/reasoning.ts` adapts the "relax a belief toward a fixed point" idea to code-worker execution signals (checks, scope, exit code, diff, stderr).
- **Mythos reasoning architecture** — The plan → recurrent depth → verify → calibrate → contradiction → gate pipeline is a self-contained port adapted to concrete execution signals. The code runs no LLM and makes no network calls.
- **Claude Code** by Anthropic — used as the background execution engine for worker jobs.
- **Model Context Protocol (MCP)** — the open protocol this worker implements.

All source code in this repository is original work by the project maintainer. The adapted algorithms are clearly documented in code comments with their origin.

## License

MIT — see [LICENSE](LICENSE).
