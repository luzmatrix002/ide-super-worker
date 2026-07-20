# Advanced Configuration

The default `.env.example` keeps only the settings most users need for a first run. Use this file when you are operating the worker continuously, comparing provider costs, or tuning reliability gates.

## Metrics And Pricing

Price inputs are accounting only. They must not gate, downgrade, or block primary, fallback, or escalation model usage.

```env
WORKER_METRICS_SHARD_BY_PID=1
WORKER_PRICE_INPUT=0.27
WORKER_PRICE_OUTPUT=1.10
WORKER_PRICE_CACHE=0.027
WORKER_PRICE_TABLE={"deepseek-v4-pro":{"input":0.55,"output":2.19}}
```

## Deterministic-Only Mode

Set this when the main Codex model should retain judgment and the worker should return only deterministic evidence. The default is `1` for backward compatibility.

```env
WORKER_LITE_LLM=0
```

With `0`, standard `analyze`/`review` return evidence packs, failed `shell` digests are deterministic, job `failure_digest` and diff red-team judgment are skipped, and `draft` is rejected. Explicit `quality_mode:"high"`, fan-out, the semantic reviewer, and `start` are unaffected.

## Lite Model Cache

Use these when `analyze`, `review`, or failure digests call a cheap gateway model often enough to benefit from a small disk cache.

```env
WORKER_LITE_MODEL=deepseek-v4-flash
WORKER_LITE_CACHE_DIR=D:/your/workspaces/.worker-lite-cache
WORKER_LITE_CACHE_TTL_MS=3600000
ADAPTER_PREFIX_CACHE=0
WORKER_FALLBACK_WARN_EVERY=5
```

## Routing Observation And Guard State

Keep hook-observable routing events separate from gateway/tool metrics, and keep the
atomic watchdog status outside the repository. The optional HMAC keys make local
fingerprints authenticated; without them the hashes are correlation identifiers only.

```env
WORKER_ROUTING_EVENTS_FILE=D:/your/workspaces/.worker-routing-observations.jsonl
WORKER_GUARD_STATUS_FILE=D:/your/workspaces/.worker-guard-status.json
WORKER_ROUTING_HASH_KEY=
WORKER_COMMAND_FINGERPRINT_KEY=
```

Until a real seven-day baseline exists, routing share, start share, latency, queue,
retry, fallback, and circuit metrics are warnings/observations rather than health-gate
failures. Canary failure, telemetry incompleteness, sampled execution-error rates,
required audit evidence, and oversized receipts without artifact references remain
eligible to fail the health gate.

## Outcome V1 Semantic Review

`semantic_gate=required` performs one independent, cache-free review after executor, scope, and checks pass. Missing configuration, timeout, invalid JSON, risky verdicts, or truncated evidence produce `outcome.status="needs_evidence"`; they never silently count as accepted.

```env
WORKER_SEMANTIC_REVIEW_MODEL=deepseek-v4-pro
WORKER_SEMANTIC_REVIEW_TIMEOUT_MS=60000
```

The reviewer receives only the declared task/policy, complete result or diff, and check evidence. It does not receive the executor transcript and cannot trigger auto-revise. Outcome v1 sends at most one upstream reviewer request: it uses the primary gateway when configured, or the fallback only when no primary gateway is configured; it never retries a failed primary review through another model route.

## Paired Evaluation

EvalSpan JSONL is intentionally separate from worker metrics. Set the context variables on an isolated worker process so upstream and tool rows can be joined to an externally produced direct/worker usage export.

```env
WORKER_EVAL_SPAN_FILE=D:/your/workspaces/.eval/eval-spans.jsonl
WORKER_EVAL_SUITE_ID=pilot-v1
WORKER_EVAL_TASK_ID=search-read-01
WORKER_EVAL_RUN_ID=run-001
WORKER_EVAL_ARM=worker
```

Import and gate producer JSONL with `npm run eval:gate -- --import producer.jsonl --out .eval/eval-spans.jsonl`, then run `npm run eval:gate -- --input .eval/eval-spans.jsonl --mode pilot`. Missing measured usage, cost, pair identity, evidence, or frozen-corpus linkage fails closed. `JobResult.total_cost_usd` is not a valid EvalSpan source.

After a real pilot passes, run `npm run eval:formal -- --input <spans.jsonl> --manifest <manifest.json>`. The formal harness fixes the bootstrap seed/sample count, McNemar diagnostic, non-inferiority margin, savings thresholds, sample expansion steps, and exit codes described in `eval/README.md`.

## Reliability Gates

These values control audit thresholds for worker tool-call health. Keep blocking policy at `observe` or `warn` until your own metrics show the gates are stable.

```env
WORKER_OVERALL_TOOL_ERROR_MAX_PCT=5
WORKER_SINGLE_TOOL_ERROR_MAX_PCT=3
WORKER_CATEGORY_ERROR_MAX_PCT=5
WORKER_TOOL_ERROR_MIN_CALLS=10
WORKER_TOOL_REVIEW_INTERVAL_MS=10800000
WORKER_TOOL_REVIEW_SINCE_MINUTES=180
WORKER_TOOL_REVIEW_GRACE_MS=300000
WORKER_TOOL_REVIEW_DISABLED=0
WORKER_RELIABILITY_TIER=standard
WORKER_BLOCKING_POLICY=observe
WORKER_SEMANTIC_GATE=off
WORKER_TOOL_BUDGET=20
```

When the MCP server is running, tool error review can enable escalation self-heal defaults for later `start` calls: stricter reliability tier, warning policy, semantic review warnings, auto-revise, and at least one revise pass.

## Tool Error Circuit Breaker

Runtime containment classifies tool errors, opens per-tool or per-error-class circuits, intercepts unhealthy routes, and uses deterministic fallbacks when safe.

```env
WORKER_TOOL_CIRCUIT_BREAKER=1
WORKER_TOOL_CIRCUIT_WINDOW_MS=900000
WORKER_TOOL_CIRCUIT_OPEN_MS=600000
WORKER_TOOL_CIRCUIT_MIN_CALLS=3
WORKER_TOOL_CIRCUIT_MIN_ERRORS=2
WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS=1
WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES=upstream_404,search_timeout,shell_mismatch
```

Persist open circuits across MCP restarts when metrics live on writable storage. The state file keeps a small rolling-event snapshot, checksum, and best-effort lock.

```env
WORKER_TOOL_CIRCUIT_STATE_FILE=D:/your/workspaces/.worker-metrics.jsonl.state.json
WORKER_TOOL_CIRCUIT_STATE_EVENT_MAX=200
WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS=30000
WORKER_TOOL_CIRCUIT_STATE_LOCK_STALE_MS=30000
```
