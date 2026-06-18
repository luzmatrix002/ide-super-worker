// Routing-contract regression tests.
// Locks the three money/safety invariants of the lite (read-only) route:
//   I3 no predictive classifier  - analyze/review each make exactly one upstream call.
//   I5 idempotent billing        - identical read-only requests are cache-served;
//                                   primary failure -> fallback bills exactly one successful upstream.
//   I6 read-only fail-safe        - analyze/review never write to the workspace.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sand = fs.mkdtempSync(path.join(os.tmpdir(), "routing-contract-"));
const cacheDir = path.join(sand, ".lite-cache");
const metricsFile = path.join(sand, "metrics.jsonl");
const repo = path.join(sand, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });

// Must be set before importing config-dependent modules. config.ts reads env at load.
process.env.SANDBOX_ROOT = sand;
process.env.ONEAPI_BASE_URL = "http://primary.test/v1";
process.env.ONEAPI_API_KEY = "pk-primary";
process.env.FALLBACK_BASE_URL = "http://fallback.test/v1";
process.env.FALLBACK_API_KEY = "fk-fallback";
process.env.FALLBACK_MODEL = "deepseek-v4-flash";
process.env.WORKER_LITE_CACHE_DIR = cacheDir;
process.env.WORKER_LITE_CACHE_TTL_MS = "3600000";
process.env.WORKER_METRICS_FILE = metricsFile;
process.env.CLAUDE_CODE_MODEL = "sonnet";

const lite = await import("../lite.js");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const realFetch = globalThis.fetch;

interface Counters {
  calls: number;
  success: number;
  byHost: Record<string, number>;
}

function installFetch(handler: (url: string) => { status: number; body: string }): Counters {
  const counters: Counters = { calls: 0, success: 0, byHost: {} };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    counters.calls += 1;
    const host = url.includes("fallback") ? "fallback" : "primary";
    counters.byHost[host] = (counters.byHost[host] || 0) + 1;
    const { status, body } = handler(url);
    if (status === 200) counters.success += 1;
    return new Response(body, { status });
  }) as typeof fetch;
  return counters;
}

function ok(content: string): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({ model: "m", choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
  };
}

const fileA = path.join(repo, "src", "a.ts");
fs.writeFileSync(fileA, "export const a = 1;\n");
for (const args of [["init"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
  spawnSync("git", args, { cwd: repo, stdio: "ignore" });
}
spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

{
  const c = installFetch(() => ok("A1"));
  const ans = await lite.analyzeDirect("i3 unique analyze", [fileA]);
  assert.equal(ans, "A1");
  assert.equal(c.calls, 1, "analyze must make exactly one upstream call; no classify pre-pass");
}
{
  const c = installFetch(() => ok("R1"));
  const ans = await lite.reviewDirect({ diff: "i3 unique diff --- a/x", maxTokens: 64 });
  assert.equal(ans, "R1");
  assert.equal(c.calls, 1, "review must make exactly one upstream call");
}
console.log("I3 no-predictive-classifier: OK");

{
  const c = installFetch(() => ok("CACHED"));
  const prompt = "i5 cache unique";
  const first = await lite.analyzeDirect(prompt, [fileA]);
  await delay(250);
  const second = await lite.analyzeDirect(prompt, [fileA]);
  assert.equal(first, "CACHED");
  assert.equal(second, "CACHED");
  assert.equal(c.calls, 1, "second identical analyze must be served from cache");
}
{
  const c = installFetch((url) => (url.includes("fallback") ? ok("FROM_FB") : { status: 500, body: "down" }));
  const ans = await lite.analyzeDirect("i5 fallback unique", [fileA]);
  assert.equal(ans, "FROM_FB");
  assert.equal(c.byHost.primary, 1, "primary tried exactly once");
  assert.equal(c.byHost.fallback, 1, "fallback tried exactly once");
  assert.equal(c.success, 1, "exactly one successful upstream; no double billing");
}
console.log("I5 idempotent-billing: OK");

{
  installFetch(() => ok("readonly"));
  await lite.analyzeDirect("i6 unique analyze", [fileA]);
  await lite.reviewDirect({ files: [fileA], focus: "i6 unique review" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  assert.equal(status, "", `analyze/review must not modify the workspace; git status was:\n${status}`);
}
console.log("I6 read-only-fail-safe: OK");

const metricLines = fs.existsSync(metricsFile) ? fs.readFileSync(metricsFile, "utf8").trim().split("\n").filter(Boolean) : [];
assert(metricLines.some((line) => line.includes('"route":"cache"')), "a cache-hit metric should be recorded");
assert(!metricLines.some((line) => line.includes("pk-primary") || line.includes("fk-fallback")), "no api key may appear in metrics");

globalThis.fetch = realFetch;
console.log("routing contract tests passed");
