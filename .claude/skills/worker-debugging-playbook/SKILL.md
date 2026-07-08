---
name: worker-debugging-playbook
description: Use when a worker job fails, stalls, returns huge output, loses a job id, or produces a result that looks successful but is not trustworthy.
---

# Worker Debugging Playbook

## Symptom Table

| Symptom | First check | Likely cause | Next action |
| --- | --- | --- | --- |
| `Job not found` | Job TTL and id source | Expired or wrong id | Re-run `start`, capture id in the caller |
| Receipt says `missing_artifact` | Receipt bytes and refs | Large output without artifact | Fix tool to save artifact before returning |
| `scoped_patch violation` | Changed files vs paths | Worker edited outside scope | Narrow prompt and rerun with scoped paths |
| Checks passed but output feels wrong | Episode and semantic risk | Semantic failure | Use strict or critical tier review |
| Repeated revise passes | Reasoning blockers | Stalled repair loop | Escalate model or stop for main review |

## Minimal Triage

1. Read compact `get` output first.
2. If receipt has artifact refs, inspect slices instead of full logs.
3. Check `episode.trajectory_score` and missing gates.
4. Run the smallest failing check outside the worker if needed.

## When Not To Use

Do not use this for planned feature work. Use `worker-change-control` first.

## Verification

- `npm run codex:audit -- --since-minutes=60`
- `npm run stats:gate`

## Provenance and maintenance

Refresh symptoms with `rg -n "Job not found|missing_artifact|scoped_patch|revise" src scripts`.
