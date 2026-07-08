---
name: worker-research-methodology
description: Use when turning community ideas or hunches into accepted worker changes with predictions, experiments, adversarial review, and retirement criteria.
---

# Worker Research Methodology

## Lifecycle

1. Capture source signal and label its evidence strength.
2. State the mechanism and predicted metric movement.
3. Implement behind observe-only instrumentation.
4. Run against real and synthetic episodes.
5. Promote, revise, or retire with a written reason.

## Evidence Bar

- One mechanism should explain positive and negative cases.
- A change must survive adversarial review for blocking risk.
- Claims about cheap-model improvement need before/after data.
- Treat prompt-leak analysis posts as weak-to-medium evidence: useful for hypothesis generation, not for asserting vendor behavior or copying hidden instructions.

## Reference Handling

- Record the URL and claim type.
- Prefer public summaries over copying long source text.
- Convert every borrowed idea into a falsifiable worker hypothesis.
- If a source discusses leaked or proprietary prompts, use structure-level observations only.

## When Not To Use

Do not use this for already-specified config or docs updates. Use `worker-config-and-flags`.

## Verification

- Store experiment data in metrics or test fixtures.
- Re-run `npm test` after promotion.

## Provenance and maintenance

Record retired ideas so future agents do not repeat the same experiment.
