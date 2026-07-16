# Quality-first analyze/review

`quality_mode:"high"` is an opt-in, fail-closed path for `analyze` and `review`.
It is not enabled by default and it does not claim that thinking or model agreement
is statistically reliable. Default routing may change only after the separate
Trial A -> B -> C qualification gate passes on real, frozen, blindly scored data.

## Runtime contract

- `standard` preserves the existing single-call and `fanout.v1` behavior.
- `high` supplies three fixed roles, uses exactly three configured branch targets,
  and sends their complete structured claims to a distinct reviewer target.
- High mode bypasses the Lite cache, requests target-specific thinking, rejects
  `finish_reason=length`, empty visible output, unexpected models, missing thinking
  signals, truncated evidence, invalid citations, incomplete claim adjudication,
  unresolved disagreements, and an `approve` verdict that masks an accepted
  high/critical finding.
- The hard internal deadline is 270 seconds: queue acquisition gets 15 seconds,
  branches share the first 195 seconds, and the reviewer gets the remainder.
  The caller retains 30 seconds of the five-minute budget for transport cleanup.
- Any incomplete high-mode result returns `quality.v1` with
  `status:"needs_direct_review"` or `status:"failed"`; it never silently falls
  back to a standard answer.
- Every response and coordinator metric includes a non-secret configuration
  fingerprint so the evaluation producer can invalidate certificates after any
  endpoint/model/thinking/template configuration change.

## Target configuration

Set `WORKER_QUALITY_TARGETS_FILE` to an untracked JSON file. API keys stay in
environment variables referenced by `api_key_env`; key values are never loaded
into the serializable configuration.

```json
{
  "version": 1,
  "branches": [
    { "id": "primary", "base_url": "https://a.example/v1", "api_key_env": "QUALITY_KEY_A", "model": "model-a", "thinking": "probe" },
    { "id": "independent", "base_url": "https://b.example/v1", "api_key_env": "QUALITY_KEY_B", "model": "model-b", "thinking": "probe" },
    { "id": "red_team", "base_url": "https://c.example/v1", "api_key_env": "QUALITY_KEY_C", "model": "model-c", "thinking": "probe" }
  ],
  "reviewer": { "base_url": "https://review.example/v1", "api_key_env": "QUALITY_REVIEW_KEY", "model": "strong-reviewer", "thinking": "probe" }
}
```

The loader requires exactly three branches, at least two distinct branch
endpoint/model pairs, and a reviewer endpoint/model pair not used by a branch.
`thinking` is `probe`, `on`, or `off`. `probe` runs a cached capability check;
`on` still requires an observable reasoning signal on every real request.

Recommended five-minute settings:

```env
WORKER_FANOUT_ENABLED=1
WORKER_FANOUT_MAX_BRANCHES=3
WORKER_FANOUT_MAX_ACTIVE=1
WORKER_LITE_MAX_CONCURRENCY=3
WORKER_GLOBAL_LITE_MAX=3
WORKER_GLOBAL_LITE_QUEUE_MAX=6
WORKER_GLOBAL_ACQUIRE_TIMEOUT_MS=15000
WORKER_FANOUT_TIMEOUT_MS=270000
```

## Qualification data

Run the versioned quality gate with one JSON object per line:

```json
{"schema_version":1,"trial":"A","category":"analyze_diagnosis","source":"real","repo_id":"repo-1","task_id":"task-1","evaluator_version":"rubric-v1","baseline_config_sha256":"<64 hex>","candidate_config_sha256":"<64 hex>","blind_evaluator":true,"baseline_pass":true,"candidate_pass":true,"candidate_only_critical_ids":[]}
```

```powershell
npm run eval:quality -- --input .eval/quality/pairs.jsonl
```

Trial A compares thinking off/on, Trial B compares the winning single path with
the heterogeneous pipeline, and Trial C compares direct premium output with the
complete production path. Analyze and review are gated separately. Official
looks are 200 pairs/category at alpha 0.01 and one optional 500-pair/category
look at alpha 0.015. The gate resamples whole repositories, requires both
categories' one-sided lower bound to be greater than zero, and fails immediately
on a candidate-only critical defect. Each official category look must contain
exactly 70% real tasks and 30% registered edge tasks. A trial is invalid when its
baseline/candidate configuration fingerprint drifts or evaluators are not declared
blind.

Exit codes are `0` passed, `2` failed/invalid, and `4` inconclusive. Passing code
tests or an engineering pilot is not a quality certificate; real frozen tasks,
blind evaluation, provider exports, isolated sessions, and retained evidence are
still required.
