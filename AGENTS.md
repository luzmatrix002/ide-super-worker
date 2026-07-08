# AGENTS.md - Codex Worker Routing Rules

This repository exists to reduce premium Codex context usage. Treat worker
routing as part of the task, not as an optional optimization.

## Routing Contract

- Before repository-wide search, bulk file reads, review, diffs, test output, or
  implementation loops, expose `mcp__codex_async_worker` tools with
  `tool_search` if they are not already callable.
- Use `mcp__codex_async_worker.search` for repo discovery instead of main-thread
  `rg` when the output could be more than a few lines.
- Use `mcp__codex_async_worker.read_pack` or `analyze` for file-reading and
  explanation tasks instead of reading whole files into the main thread.
- Use `mcp__codex_async_worker.shell` with `digest:true` for tests, builds, lint,
  and noisy commands.
- Use `mcp__codex_async_worker.diff_digest` and `review` before ingesting full
  diffs.
- Use `mcp__codex_async_worker.start` for implementation loops. Prefer
  `include_diff:false`, scoped paths, and explicit checks.

## Main-Thread Budget

Keep the main Codex thread for planning, decisions, small verification, and final
review. Do not use main-thread shell or file reads as a substitute for worker
tools when the task is large enough to affect context usage.

## Audits

- Run `npm run codex:audit -- --since-minutes=60` when checking whether recent
  work is being routed through the worker.
- Run `npm run stats:gate` for the existing metrics gate.
- Remember that worker metrics can only see worker/tool audit rows. Direct
  main-thread file reads, shell output, and chat context are outside the metrics
  file unless explicitly instrumented.
