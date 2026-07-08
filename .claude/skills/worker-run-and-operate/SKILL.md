---
name: worker-run-and-operate
description: Use when operating the MCP server, running worker jobs, reading job output, inspecting artifacts, or managing long-running waits.
---

# Worker Run And Operate

## Operating Rules

- Use `start` for implementation loops and `wait` or `get` for compact status.
- Prefer `include_diff:false` unless patch review needs the diff.
- Use `get_artifact_slice` for large logs and diffs.
- Use `shell` with `digest:true` for tests and noisy commands.
- Do not poll aggressively; use longer waits and backoff.

## Reliability Tiers

- `standard`: default, advisory evidence.
- `strict`: expects checks and scoped patch.
- `critical`: expects checks, scoped patch, semantic gate, escalate model, and worktree isolation.

## When Not To Use

Do not use this to decide architecture. Use `worker-architecture-contract`.

## Verification

- `npm run smoke`
- `npm run codex:audit -- --since-minutes=60`

## Provenance and maintenance

Keep this aligned with `src/server.ts` tool descriptions.
