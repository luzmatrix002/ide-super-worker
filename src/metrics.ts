import * as fs from "node:fs";
import * as path from "node:path";

let fallbackCallCount = 0;

export function resolvedMetricsFile(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const raw = env.WORKER_METRICS_FILE?.trim();
  return raw ? path.resolve(raw) : undefined;
}

export type WorkerCategory =
  | "artifact"
  | "implementation"
  | "context_pack"
  | "diff_digest"
  | "command_digest"
  | "mechanical_edit"
  | "history"
  | "draft"
  | "search"
  | "review"
  | "analysis"
  | "job_control";

function fallbackWarnEvery(): number {
  const raw = process.env.WORKER_FALLBACK_WARN_EVERY;
  if (raw === "0") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export function recordFallbackCall(): void {
  fallbackCallCount += 1;
  const warnEvery = fallbackWarnEvery();
  if (warnEvery > 0 && fallbackCallCount % warnEvery === 0) {
    console.error(
      `[warn][fallback] ${fallbackCallCount} fallback calls so far this session. ` +
        "Primary gateway may be degraded. Check ONEAPI_BASE_URL."
    );
  }
}

// Lightweight usage/cost observability (optimization O7).
//
// IMPORTANT: Claude Code's own `total_cost_usd` is computed from Anthropic's
// price for the *cliModel* (sonnet) and is therefore meaningless for this setup,
// where the real backend is a cheap third-party gateway. The only trustworthy
// signal is the token usage returned by the gateway, captured here per upstream
// call. Aggregate the JSONL externally and multiply by your provider's price.
//
// Enabled only when WORKER_METRICS_FILE is set. Failures are swallowed so that
// observability can never break the main request path.
export function appendMetrics(row: Record<string, unknown>): void {
  const baseFile = resolvedMetricsFile();
  const file = baseFile && process.env.WORKER_METRICS_SHARD_BY_PID === "1" ? `${baseFile}.${process.pid}` : baseFile;
  if (!file) return;
  try {
    const evalContext = Object.fromEntries(
      [
        ["suite_id", process.env.WORKER_EVAL_SUITE_ID],
        ["task_id", process.env.WORKER_EVAL_TASK_ID],
        ["run_id", process.env.WORKER_EVAL_RUN_ID],
        ["arm", process.env.WORKER_EVAL_ARM]
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    );
    fs.appendFileSync(file, `${JSON.stringify({ ...row, ...evalContext, ts: new Date().toISOString() })}\n`);
  } catch {
    // observability must never throw
  }
}

export function appendToolMetric(
  tool: string,
  category: WorkerCategory,
  status: "ok" | "error" | "rejected" = "ok",
  extra: Record<string, unknown> = {}
): void {
  appendMetrics({
    event: "tool_call",
    route: "worker",
    tool,
    category,
    status,
    ...extra,
    prompt_tokens: 0,
    completion_tokens: 0
  });
}

/** Different gateways expose prompt-cache hits under different usage keys. */
export function pickCacheTokens(usage: any): number | null {
  return (
    usage?.prompt_cache_hit_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    null
  );
}
