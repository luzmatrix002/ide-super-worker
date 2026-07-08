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

## Lite Model Cache

Use these when `analyze`, `review`, or failure digests call a cheap gateway model often enough to benefit from a small disk cache.

```env
WORKER_LITE_MODEL=deepseek-v4-flash
WORKER_LITE_CACHE_DIR=D:/your/workspaces/.worker-lite-cache
WORKER_LITE_CACHE_TTL_MS=3600000
ADAPTER_PREFIX_CACHE=0
WORKER_FALLBACK_WARN_EVERY=5
```

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
