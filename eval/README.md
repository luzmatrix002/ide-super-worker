# Paired Evaluation Contract

Eval data is intentionally separate from `WORKER_METRICS_FILE`. An external producer must emit one `EvalSpanV1` JSON object per line for both the `direct` and `worker` arms. The runtime contract and validator live in `src/evaluation.ts`.

## Producer requirements

- Pair key: `suite_id + task_id + run_id`; exactly one span per arm.
- Both arms use the same commit, workspace/task/prompt fingerprints, premium model, permissions, deadline, cache policy, price snapshot, and evaluator version.
- `usage.premium` is measured for both arms. `usage.worker` is measured for the worker arm and explicitly `not_applicable` with zero values plus a reason for the direct arm.
- Premium measured token totals cannot be empty. A deterministic worker lane may report zero worker tokens only with `source:"worker_metrics"`, zero worker cost, and routing reason `zero_llm`; every other zero-token worker record is rejected.
- Premium token sources are restricted to `codex_export` or `provider_export`; non-zero worker tokens require `provider_export`, deterministic zero-LLM worker usage requires `worker_metrics`, and only the direct arm may use `worker_not_used`. Estimates and `JobResult.total_cost_usd` are rejected. Every measured record carries a producer version and SHA-256 of its raw export record.
- `usage.cost_source` distinguishes billing export from a frozen price snapshot, and both arms must carry the same price-snapshot ID and SHA-256.
- `usage.total_cost_usd` must exactly equal premium plus worker component cost.
- `queue_wait_ms` cannot exceed `e2e_ms`; the monotonic duration must agree with the wall-clock timestamps within the validator's bounded clock tolerance.
- Evidence refs are unique `artifact://...` or `sha256:<64-hex>` identifiers. The producer must retain the referenced bytes for audit; syntactic validation does not prove that an external artifact store is durable or honest.
- Isolated cache namespaces are non-empty, different between arms, and unique across the suite.
- Major/critical defect counts must match unique defect-ID lists. A passing arm cannot carry a major/critical defect, and routed-only critical defects are compared by ID rather than count difference.

Validate the whole producer batch before appending it:

```text
npm run eval:gate -- --import producer.jsonl --out .eval/eval-spans.jsonl
npm run eval:gate -- --input .eval/eval-spans.jsonl --mode paired
```

Set `WORKER_EVAL_SUITE_ID`, `WORKER_EVAL_TASK_ID`, `WORKER_EVAL_RUN_ID`, and `WORKER_EVAL_ARM=worker` on the isolated worker process to correlate its ordinary metrics. These variables do not create premium Codex usage; that still comes from the external producer/export.

The external producer/export is an explicit trust boundary: the importer validates hashes, provenance fields, pairing, and internal consistency, but it cannot prove a provider signature that the producer does not supply. Keep the raw provider/billing exports and artifact bytes under access control, and do not describe imported values as tamper-proof.

## Pilot

`fixtures/pilot-v1.json` freezes the 10-task measurement pilot, exact prompts, fact rubrics, material refs, and task/corpus hashes. The distribution is 2 search/read, 2 analysis/diagnosis, 2 review, 2 bugfix, 1 small feature/refactor, and 1 test/log task.

For each task and arm, use a fresh session and worktree at the same commit. Keep prompt, premium model, permission profile, deadline, and evaluator fixed; disable cache or isolate it per span. Retain the raw usage/cost exports and all evidence artifacts. Then run:

```text
npm run eval:fixtures
npm run eval:gate -- --input .eval/pilot/eval-spans.jsonl --mode pilot
```

Pilot mode requires exactly 10 pairs/20 spans, complete evidence with artifact refs, measured premium usage, the frozen task hashes, and zero routed-only critical defects. Passing proves measurement completeness only. It does not authorize an economic or quality claim.

## Formal evaluation

Formal evaluation additionally requires a manifest:

```json
{
  "schema_version": 1,
  "suite_id": "formal-v1",
  "evaluator_version": "rubric-v1",
  "tasks": [
    {
      "task_id": "task-001",
      "category": "search_read",
      "source": "real",
      "visual": false,
      "task_spec_sha256": "...",
      "prompt_sha256": "..."
    }
  ]
}
```

The first complete manifest contains 200 unique tasks: 140 anonymized real tasks and 60 registered edge tasks, with category quotas 40/35/35/35/35/20 for search/read, analysis/diagnosis, review, bugfix, small feature/refactor, and test/log. It contains at least 10 visual tasks. If power is insufficient, add 50 preregistered tasks at a time up to 400 while preserving the registered minimum quotas and 70/30 real-edge split.

Both arms must run from the same commit in fresh sessions/worktrees with the same prompt, premium model, permissions, and deadline. Evaluators must be blind to the arm. Read-only tasks use preregistered fact rubrics; modifying tasks use hidden tests, scope checks, and blind major/critical-defect review. Unsupported visual routing remains a route failure and cannot be dropped from the sample.

```text
npm run eval:formal -- --input .eval/formal/eval-spans.jsonl --manifest .eval/formal/manifest.json
```

The command uses the registered 50% premium-token, 30% total-cost, one-sided 95% non-inferiority (`>= -5pp`), zero routed-only-critical, 10,000 paired-bootstrap resamples with seed `20260710`, McNemar exact diagnostic, and 80% power gates. Exit codes are: `0` passed, `2` failed/invalid, `3` add 50 tasks, and `4` inconclusive at 400 tasks. Until this gate passes, keep routing shadow/explicit-only and do not claim cost reduction without quality loss.
