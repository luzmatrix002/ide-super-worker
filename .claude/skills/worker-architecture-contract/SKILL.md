---
name: worker-architecture-contract
description: Use when explaining or changing the boundary between main Codex, worker tools, cheap gateway calls, receipts, artifacts, and deterministic gates.
---

# Worker Architecture Contract

## Load-Bearing Boundaries

- Main Codex plans, decides, and performs final review.
- Worker tools absorb bulk reading, shell output, diff digestion, and implementation loops.
- Lite tools are read-only cheap gateway calls. They are not authoritative for high-risk acceptance.
- Receipts and artifacts are the evidence boundary. Model prose is not proof.
- Deterministic gates can reject scope, failed checks, and malformed output without extra LLM calls.

## Invariants

- All paths stay inside `SANDBOX_ROOT`.
- `bypassPermissions` is rejected unless explicitly allowed.
- Large outputs should be artifact-backed.
- New strictness must be advisory unless `blocking_policy=enforce`.

## When Not To Use

Do not use this for single failing command diagnosis. Use `worker-debugging-playbook`.

## Verification

- `npm test`
- `rg -n "SANDBOX_ROOT|bypassPermissions|artifact_refs|blocking_policy" src`

## Provenance and maintenance

Re-read `src/server.ts`, `src/security.ts`, `src/artifacts.ts`, and `src/reliability.ts` after contract changes.
