---
name: worker-config-and-flags
description: Use when adding, changing, or auditing environment variables, tool parameters, defaults, or operator-facing configuration flags.
---

# Worker Config And Flags

## Flag Discipline

- Env defaults must be safe for existing users.
- Per-call fields override env only for that request.
- Any flag that can block work needs an observe or warn mode.
- Document drift-prone defaults in `.env.example` and README.

## Reliability Flags

| Flag or field | Purpose |
| --- | --- |
| `reliability_tier` / `WORKER_RELIABILITY_TIER` | `lite`, `standard`, `strict`, or `critical` evidence expectations |
| `blocking_policy` / `WORKER_BLOCKING_POLICY` | `observe`, `warn`, or `enforce` missing gates |
| `semantic_gate` / `WORKER_SEMANTIC_GATE` | Declare semantic review expectation |
| `tool_budget` / `WORKER_TOOL_BUDGET` | Advisory call budget for metrics |

## When Not To Use

Do not use this for model-quality research without config changes. Use `worker-research-frontier`.

## Verification

- `npm test`
- `rg -n "WORKER_|reliability_tier|blocking_policy|semantic_gate|tool_budget" src README.md .env.example`

## Provenance and maintenance

Date-sensitive provider/model facts must be rechecked against current gateway docs before publishing.
