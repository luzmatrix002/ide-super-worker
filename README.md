# MCP Codex Worker

Run expensive Codex sub-tasks on a cheaper worker model, keep Codex focused on orchestration, and return only the evidence Codex needs.

`mcp-codex-worker` is a Model Context Protocol server for Codex Desktop. It starts Claude Code as an async background worker, translates Claude Code's Anthropic `/v1/messages` traffic to OpenAI-compatible `/chat/completions`, and sends the heavy token work to a low-cost gateway such as DeepSeek, OneAPI, New API, or another compatible provider.

## Why It Exists

Codex is strongest when it coordinates, reviews, and decides. It is not always cost-effective to make the main Codex thread read huge files, run long repair loops, and ingest giant diffs.

This worker changes the shape of the bill:

- Codex sends a compact `start` request.
- Claude Code does the heavy local work in the background.
- The local adapter routes model traffic to your cheaper backend.
- Codex receives `changed_files`, `checks`, logs, and an optional trimmed diff.

For large code-reading and patching tasks, this can cut the expensive main-thread token intake dramatically because Codex no longer has to ingest every intermediate file read and full patch body.

## Highlights

- Async MCP tools: `start`, `get`, `tail`, `wait`, `cancel`.
- Read-only lite tool: `analyze` answers file-summary questions without launching Claude Code.
- Anthropic-to-OpenAI adapter: lets Claude Code talk to OpenAI-compatible gateways.
- 429 and 5xx retry handling with `Retry-After` support.
- Optional `include_diff:false` to return only `changed_files` and `checks`.
- Deterministic verification layer: scope checks, command checks, result signals, and bounded auto-revise.
- Cost telemetry: writes gateway token usage to JSONL when `WORKER_METRICS_FILE` is set.
- Optional fallback gateway when the primary provider fails.
- Optional worktree isolation for parallel jobs inside one repository.
- Secret redaction in logs and tool responses.

## Tool Surface

| Tool | Purpose |
| --- | --- |
| `start` | Start an async Claude Code job in an allowed directory. |
| `get` | Read current job status and structured result. |
| `tail` | Read recent worker logs. |
| `wait` | Wait for completion without killing the job on timeout. |
| `cancel` | Kill a running job process tree. |
| `analyze` | Read-only cheap-model analysis for selected files. |

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
args = ["D:/path/to/mcp-codex-worker/dist/index.js"]
cwd = "D:/path/to/mcp-codex-worker"
startup_timeout_sec = 10
tool_timeout_sec = 3600
env = { SANDBOX_ROOT = "D:/workspaces", ONEAPI_BASE_URL = "https://your-gateway.example.com/v1", CLAUDE_MODEL = "deepseek-v4-flash", CLAUDE_CODE_MODEL = "sonnet", CLAUDE_PERMISSION_MODE = "acceptEdits", USE_OPENAI_ADAPTER = "1", WAIT_DEFAULT_MS = "1800000" }
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
  "job_status": "completed",
  "changed_files": ["src/a.ts", "tests/a.test.ts"],
  "checks": ["scoped_patch: passed (src, tests)", "unit tests: passed"],
  "diff": ""
}
```

Use `include_diff:false` by default when Codex only needs to decide whether the job succeeded. Ask for the diff only when you actually need to review patch details.

## Cost Controls

This project stacks several cost controls:

- `include_diff:false` reduces high-cost Codex ingestion.
- `DIFF_MAX_BYTES` caps patch payloads.
- `analyze` skips Claude Code for read-only summaries.
- `WORKER_METRICS_FILE` records real gateway token usage.
- `WORKER_ESCALATE_MODEL` upgrades only failed, difficult revise passes.
- `WORKER_ISOLATION=worktree` allows safe parallel work in one repo.
- Prompt-cache-friendly usage keeps stable instructions before dynamic task text.

Claude Code's own `total_cost_usd` may reflect Anthropic pricing, not your gateway pricing. Use `WORKER_METRICS_FILE` and provider prices for real accounting.

## Important Environment Variables

| Variable | Purpose |
| --- | --- |
| `SANDBOX_ROOT` | Root directory allowed for worker jobs and `analyze` file reads. |
| `ONEAPI_BASE_URL` / `ANTHROPIC_BASE_URL` | Primary gateway URL. |
| `ONEAPI_API_KEY` / `ANTHROPIC_API_KEY` | Primary gateway key. Keep it out of git. |
| `CLAUDE_MODEL` / `ANTHROPIC_MODEL` | Real backend model used by the gateway. |
| `CLAUDE_CODE_MODEL` | Model name passed to Claude Code for local validation, usually `sonnet`. |
| `USE_OPENAI_ADAPTER` | `1` to use the local Anthropic-to-OpenAI adapter. |
| `DIFF_MAX_BYTES` | Maximum returned diff size. |
| `WORKER_METRICS_FILE` | Optional JSONL path for token usage metrics. |
| `WORKER_ESCALATE_MODEL` | Optional stronger model for hard revise passes. |
| `WORKER_ISOLATION` | Set to `worktree` for per-job git worktree isolation. |
| `FALLBACK_BASE_URL` / `FALLBACK_API_KEY` | Optional fallback gateway. |

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
```

`doctor:network` depends on your real gateway credentials. Build, test, and smoke should pass offline.

## When To Use It

Use this worker for:

- long codebase reading tasks,
- scoped code edits with tests,
- repeated repair loops,
- cheap model summaries,
- background implementation while Codex continues planning/reviewing.

Keep the main Codex thread for high-level decisions, code review, final integration, and tasks that require your most capable model directly.
