# Promotion Kit

## One-Liner

MCP Codex Worker lets Codex delegate expensive code-reading and patch loops to cheaper worker models while Codex receives only compact, verifiable results.

## Short Pitch

Codex is excellent at orchestration and review, but large implementation loops can burn a lot of premium context. MCP Codex Worker adds an async background worker: Codex sends a task, Claude Code runs locally, a built-in adapter routes model calls to cheap OpenAI-compatible gateways, and Codex gets back changed files, checks, logs, and optional diffs.

It is built for people who want practical AI coding throughput without turning every subtask into a premium-token bonfire.

## Key Benefits

- Lower Codex token intake by returning compact evidence instead of full intermediate context.
- Use cheaper model gateways for bulk code reading and repair.
- Keep safety rails: sandbox root, scoped patch checks, secret redaction, and permission controls.
- Keep quality rails: test commands, deterministic result assessment, and bounded auto-revise.
- Use `analyze` for fast read-only summaries without launching a full agent loop.

## Suggested GitHub Description

Cost-saving async MCP worker for Codex: run Claude Code through cheap OpenAI-compatible gateways, return compact verified results, and cut main-thread token waste.

## Suggested Topics

`mcp`, `codex`, `claude-code`, `ai-coding`, `openai-compatible`, `developer-tools`, `cost-optimization`, `typescript`

## Launch Post

I built an MCP worker for Codex that changes where the expensive tokens go.

Instead of asking the main Codex thread to read every file, run every repair loop, and ingest every diff, Codex can delegate the job to a background worker. The worker launches Claude Code, routes model traffic through a local Anthropic-to-OpenAI adapter, and sends the heavy work to cheaper compatible gateways.

Codex gets back the part it actually needs: changed files, checks, logs, and an optional diff.

Useful pieces:

- async `start/get/tail/wait/cancel` tools
- read-only `analyze` tool for cheap summaries
- 429/5xx retry handling
- `include_diff:false` to avoid dumping large patches into the main thread
- token usage JSONL for real cost tracking
- scoped patch checks and secret redaction
- optional fallback gateway and worktree isolation

If your AI coding workflow is bottlenecked by cost, quota, or long context churn, this is a small piece of plumbing that can buy back a surprising amount of headroom.

## Target Audiences

- Codex Desktop power users.
- Developers using Claude Code plus cheaper gateway models.
- Teams trying to reduce AI coding cost without giving up verification.
- MCP builders looking for a practical async worker pattern.

## Promotion Channels

- GitHub README plus Topics.
- X/Twitter launch thread with before/after workflow diagram.
- Hacker News "Show HN" if the repo includes a reproducible demo.
- Reddit: r/LocalLLaMA, r/ClaudeAI, r/OpenAI, r/programming where rules allow.
- Discord communities around MCP, Codex, Claude Code, and local/cheap model gateways.
- A short demo video: one task with `include_diff:false`, `tail`, and checks passing.

## Demo Script

1. Show Codex starting a worker job with `include_diff:false`.
2. Show `tail` streaming progress while Codex stays clean.
3. Show `wait` returning changed files and checks.
4. Show metrics JSONL with gateway token usage.
5. Show a second read-only `analyze` call returning quickly without Claude Code startup.
