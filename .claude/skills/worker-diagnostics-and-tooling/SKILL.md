---
name: worker-diagnostics-and-tooling
description: Use when measuring worker quality, cost, receipt health, artifact coverage, tool routing, or reliability-tier behavior.
---

# Worker Diagnostics And Tooling

## Tools

| Command | Reads | Use |
| --- | --- | --- |
| `npm run stats` | Metrics JSONL | Cost and route mix |
| `npm run stats:gate` | Recent metrics | CI-style route thresholds |
| `npm run codex:audit` | Metrics and receipts | Routing contract audit |
| `npm run skills:validate` | `.claude/skills` | Skill library structure |

## Interpretation

- High fallback ratio means gateway degradation or bad primary config.
- High start ratio means too much work is delegated as full implementation.
- Missing artifact refs on large outputs means main-thread context can balloon.
- Missing reliability gates in strict jobs are warnings unless enforced.
- Overall worker tool error rate must stay below 5%.
- Each individual tool error rate must stay below 3% once it reaches the sample floor.

## When Not To Use

Do not use this for manual code review. Use `worker-validation-and-qa`.

## Verification

- `npm run stats:gate`
- `npm run skills:validate`

## Provenance and maintenance

Update this when scripts under `scripts/` add or remove gate fields.
