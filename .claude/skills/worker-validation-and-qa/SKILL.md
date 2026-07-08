---
name: worker-validation-and-qa
description: Use before declaring a worker change complete, accepting a worker result, or deciding whether a cheap-model output is reliable enough.
---

# Worker Validation And QA

## Evidence Bar

- Passing checks prove only the checked behavior.
- A receipt proves runtime execution shape, not semantic correctness.
- A low trajectory score is a review signal.
- Critical tasks need independent semantic review or main-thread review.

## Acceptance Checklist

- Relevant tests passed.
- Scope is clean.
- Receipt abnormal verdict is accepted or explicitly handled.
- Episode has no unexpected missing gates.
- No new blocking behavior without `blocking_policy=enforce`.

## When Not To Use

Do not use this for writing user-facing docs. Use `worker-docs-and-writing`.

## Verification

- `npm test`
- `npm run codex:guard`

## Provenance and maintenance

Add failed QA cases to tests before changing acceptance rules.
