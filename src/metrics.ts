import * as fs from "node:fs";

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
  const file = process.env.WORKER_METRICS_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
  } catch {
    // observability must never throw
  }
}
