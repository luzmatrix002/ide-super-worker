---
name: worker-change-control
description: Use when changing worker behavior, tool contracts, routing gates, metrics, or defaults so changes stay non-blocking unless explicitly enforced.
---

# Worker Change Control

Use this before behavior changes to the MCP tool surface, gateway adapter, metrics, or verification gates.

## Rules

- Default to observe or warn. Only block a request when a caller explicitly chooses `blocking_policy=enforce`.
- Keep old clients compatible: new fields must be optional and have conservative defaults.
- Do not turn cost controls into correctness claims. A cheap lane result needs evidence.
- Prefer additive receipt, metrics, and episode fields over changing existing response meanings.

## Checklist

- Identify the contract boundary: tool schema, env var, metric row, receipt, or job result.
- Add tests for both default behavior and strict/enforced behavior.
- Record blocking risk in the response or metrics when a gate is advisory.
- Update README or `.env.example` if an operator needs to know the flag.

## When Not To Use

Do not use this for pure docs edits that do not alter behavior. Use `worker-docs-and-writing` instead.

## Verification

- `npm test`
- `npm run build`

## Provenance and maintenance

Re-check tool schemas with `rg -n "inputSchema|reliability_tier|blocking_policy" src/server.ts src/types.ts`.
