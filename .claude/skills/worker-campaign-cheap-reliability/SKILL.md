---
name: worker-campaign-cheap-reliability
description: Use for the executable campaign to reduce cheap-worker degradation with tiering, trajectory scoring, semantic gates, skills, and eval cases.
---

# Worker Campaign Cheap Reliability

## Goal

Turn "cheap worker feels degraded" into measured failure classes and gated mitigations.

## Phases

1. Baseline: run `npm test`, `npm run codex:audit -- --since-minutes=60`, and collect recent failed episodes.
2. Instrument: ensure reliability profile, episode summary, receipt abnormal verdict, and tool metrics exist.
3. Gate: use `strict` for normal risky edits and `critical` for security, release, migration, or broad refactors.
4. Review: send semantic-risk cases to main-thread or strong-model review.
5. Promote: only make a warning into a hard block after eval cases prove low false-positive risk.

## Wrong Paths To Fence Off

- Do not rely on more output tokens as thinking time.
- Do not expose all tools to a weak model by default.
- Do not trust a model-created Observation without runtime receipt.

## When Not To Use

Do not use this for one isolated failed command. Use `worker-debugging-playbook`.

## Verification

- `npm test`
- `npm run codex:guard`
- Compare trajectory scores before and after a change.

## Provenance and maintenance

Add real user feedback cases as eval episodes before tightening blocking gates.
