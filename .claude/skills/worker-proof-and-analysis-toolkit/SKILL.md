---
name: worker-proof-and-analysis-toolkit
description: Use when a reliability hypothesis needs first-principles analysis, falsifiable predictions, or evidence stronger than model prose.
---

# Worker Proof And Analysis Toolkit

## Recipes

### Hypothesis To Numbers

- State the mechanism.
- Predict which metric changes and by how much.
- Run the smallest controlled comparison.
- Keep negative evidence.

### Semantic Failure Audit

- Pick jobs where checks passed but review disagreed.
- Classify root cause: missing context, wrong tool, weak model, or bad acceptance criteria.
- Add a test or episode fixture for the class.

### Blocking Risk Review

- Estimate false positive cost.
- Prefer observe mode until measured.
- Promote to warn, then enforce only after regression coverage exists.

## When Not To Use

Do not use this for routine feature implementation. Use `worker-change-control`.

## Verification

- `npm run stats -- --since-minutes=60`
- `npm test`

## Provenance and maintenance

Retire disproven hypotheses in docs or tests so they are not rediscovered.
