---
name: worker-failure-archaeology
description: Use when a problem may have happened before and you need prior failed fixes, reverted approaches, or metrics evidence before changing code.
---

# Worker Failure Archaeology

Use this to avoid re-fighting settled battles.

## Method

- Start with `git log --oneline -- src scripts README.md`.
- Search for the exact symptom string.
- Read tests that encode the old failure.
- Preserve the root cause, evidence, rejected fix, and current status in a note or test.

## Failure Record Template

| Field | Content |
| --- | --- |
| Symptom | User-visible failure |
| Root cause | Mechanism, not guess |
| Evidence | Commit, test, metric, or log |
| Rejected paths | Fixes that failed or were too risky |
| Current guard | Test, gate, or doc that prevents recurrence |

## When Not To Use

Do not use this for fresh prototype ideas with no production implication. Use `worker-research-frontier`.

## Verification

- `rg -n "<symptom>" .`
- `git log --oneline -- <files>`

## Provenance and maintenance

Update the record when a guard moves from docs into tests or code.
