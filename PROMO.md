# Promotion Kit

## One-Liner

Make Codex stop eating giant diffs: delegate heavy code work to a cheaper async worker and return only compact, verified results.

## Short Pitch

Codex is excellent at orchestration and review. It is wasteful to make the main thread ingest every file read, every failed repair attempt, and every huge diff.

MCP Codex Worker adds a cheaper background lane. Codex sends a small MCP request, Claude Code runs the task locally, the adapter routes model calls to an OpenAI-compatible gateway, and Codex gets back the clean part: changed files, checks, logs, and an optional diff.

It is built for people who want more AI coding throughput without turning every subtask into a premium-context bonfire.

## Dead Simple Diagram

```text
Before:
Codex -> reads repo -> edits -> tests -> reads diff -> burns context

After:
Codex -> Worker -> cheap model does heavy loop -> Codex gets summary/checks
```

```text
               small request
Codex --------------------------------> MCP Worker
  ^                                         |
  | compact result                          | launches
  | changed_files + checks                  v
  +---------------------------------- Claude Code
                                            |
                                            | adapter
                                            v
                               cheap OpenAI-compatible gateway
```

## Key Benefits

- Lower Codex token intake by returning compact evidence instead of full intermediate context.
- Use cheaper model gateways for bulk code reading and repair.
- Keep safety rails: sandbox root, scoped patch checks, secret redaction, and permission controls.
- Keep quality rails: test commands, deterministic result assessment, and bounded auto-revise.
- Use `analyze` for fast read-only summaries without launching a full agent loop.

## Stronger Positioning

This is not a chatbot wrapper. It is cost-control infrastructure for AI coding:

- Codex stays as the high-quality planner/reviewer.
- Cheap models do the bulky implementation labor.
- Tests and scoped patch checks decide whether the worker earned trust.
- Large diffs become optional instead of the default payload.

The pitch is simple: keep the expensive brain clean; move repetitive muscle work to a cheaper lane.

## Suggested GitHub Description

Cost-saving async MCP worker for Codex: delegate heavy Claude Code loops to cheap OpenAI-compatible gateways and return compact verified results.

## Suggested Topics

`mcp`, `codex`, `claude-code`, `ai-coding`, `openai-compatible`, `developer-tools`, `cost-optimization`, `typescript`

## Launch Post

I built an MCP worker for Codex that changes where the expensive tokens go.

The problem: Codex is great at planning and review, but implementation loops are noisy. Reading lots of files, trying fixes, running tests, and ingesting big diffs can burn premium context fast.

The fix: Codex delegates the noisy middle to a background worker.

The worker launches Claude Code, routes model traffic through a local Anthropic-to-OpenAI adapter, and sends the heavy work to cheaper compatible gateways.

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

Diagram:

```text
Codex planner -> MCP worker -> Claude Code -> cheap gateway
Codex reviewer <- changed files + checks <- worker
```

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

## Landing Page Headline Options

- Stop feeding Codex giant diffs.
- Give Codex a cheaper worker lane.
- Keep Codex for decisions. Move bulk code work elsewhere.
- The async worker that keeps Codex context clean.
