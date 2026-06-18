import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReasoningReport } from "../reasoning.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-codex-worker-test-root-"));
const project = path.join(root, "project");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-codex-worker-outside-"));
fs.mkdirSync(project);

process.env.SANDBOX_ROOT = root;
process.env.ONEAPI_BASE_URL = "https://gateway.example.test/v1";
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.CLAUDE_CODE_MODEL = "sonnet";
process.env.WORKER_LITE_MODEL = "lite-env-model";
process.env.WORKER_LITE_CACHE_DIR = path.join(root, "lite-cache");

const security = await import("../security.js");
const jobsModule = await import("../jobs.js");
const claude = await import("../claude.js");
const workspace = await import("../workspace.js");
const adapter = await import("../anthropic_openai_adapter.js");
const server = await import("../server.js");
const lite = await import("../lite.js");
const reasoning = await import("../reasoning.js");
const search = await import("../search.js");
const metrics = await import("../metrics.js");
const originalFetch = globalThis.fetch;

function readSourceFiles(dir: string): Array<{ file: string; text: string }> {
  const entries: Array<{ file: string; text: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "tests") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...readSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      entries.push({ file: full, text: fs.readFileSync(full, "utf8") });
    }
  }
  return entries;
}

function gitPorcelain(cwd: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function expectRejectsPath(input: string): void {
  assert.throws(() => security.validatePath(input), /Security/);
}

security.validatePath(project);
expectRejectsPath(outside);

const sibling = `${root}-sibling`;
fs.mkdirSync(sibling);
expectRejectsPath(sibling);

try {
  const link = path.join(root, "link-outside");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  expectRejectsPath(link);
} catch {
  console.log("[skip] symlink test unavailable on this platform");
}

fs.mkdirSync(path.join(project, "src"));
fs.writeFileSync(path.join(project, "src", "needle.txt"), "alpha\nneedle here\n", "utf8");
const scoped = security.validateScopedPatch({ paths: ["src"] }, project);
assert.deepEqual(scoped?.relativePaths, ["src"]);
assert.throws(() => security.validateScopedPatch({ paths: [".."] }, project), /Security/);

const job = jobsModule.createJobState("job-1", "claude", [], project, "test-model");
jobsModule.parseStreamJSON(job, JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "abc" }).slice(0, 20));
jobsModule.appendStderrChunk(job, "stderr line\n");
jobsModule.parseStreamJSON(job, JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "abc" }).slice(20) + "\n");
assert.equal(job.result.result, "done");
assert.equal(job.result.session_id, "abc");
assert(job.logBuffer.some((line) => line.includes("[stderr] stderr line")));

const rawJob = jobsModule.createJobState("job-raw", "claude", [], project, "test-model");
jobsModule.parseStreamJSON(rawJob, "x".repeat(6 * 1024 * 1024));
assert(rawJob.stdoutRemainder.length <= 5 * 1024 * 1024);
assert(rawJob.logBuffer.some((line) => line.includes("partial line exceeded")));

const logJob = jobsModule.createJobState("job-log", "claude", [], project, "test-model");
for (let i = 0; i < 2500; i += 1) {
  jobsModule.appendLog(logJob, `line-${i}`);
}
assert(logJob.logBuffer.length <= 2000);
assert.equal(logJob.logBuffer.at(-1), "line-2499");

const diffJob = jobsModule.createJobState("job-diff", "claude", [], project, "test-model", [project], undefined, [], [], {
  originalPrompt: "hello",
  additionalDirs: [],
  launchInput: { prompt: "hello", allowed_dirs: [project], include_diff: false },
  reasoningEnabled: false,
  autoReviseEnabled: false,
  maxRevisePasses: 0
});
diffJob.result.diff = "large diff";
diffJob.result.checks = [`unit: failed\n${"x".repeat(3000)}`];
diffJob.result.result = "worker summary";
diffJob.result.session_id = "session-1";
diffJob.result.total_cost_usd = 0.01;
const publicDiffJob = server.publicJob(diffJob);
assert.equal(publicDiffJob.diff, "");
assert.equal("result" in publicDiffJob, false);
assert(publicDiffJob.checks[0].includes("response output truncated"));
assert.equal(publicDiffJob.summary, "worker summary");
assert.equal(publicDiffJob.session_id, "session-1");
assert.equal(publicDiffJob.total_cost_usd, 0.01);
const verboseDiffJob = server.publicJob(diffJob, undefined, true) as any;
assert.equal(verboseDiffJob.result.diff, "");
assert.equal(verboseDiffJob.checks[0], diffJob.result.checks[0]);
assert.equal(metrics.pickCacheTokens({ prompt_tokens_details: { cached_tokens: 12 } }), 12);
assert.equal(metrics.pickCacheTokens({ cache_read_input_tokens: 7 }), 7);

const originalConsoleError = console.error;
const fallbackWarnings: string[] = [];
process.env.WORKER_FALLBACK_WARN_EVERY = "2";
console.error = (...args: unknown[]) => {
  fallbackWarnings.push(args.join(" "));
};
try {
  metrics.recordFallbackCall();
  assert.equal(fallbackWarnings.length, 0);
  metrics.recordFallbackCall();
  assert.equal(fallbackWarnings.length, 1);
  assert(fallbackWarnings[0].includes("[warn][fallback] 2 fallback calls so far this session"));
  process.env.WORKER_FALLBACK_WARN_EVERY = "0";
  metrics.recordFallbackCall();
  metrics.recordFallbackCall();
  assert.equal(fallbackWarnings.length, 1);
} finally {
  console.error = originalConsoleError;
  delete process.env.WORKER_FALLBACK_WARN_EVERY;
}

const statsFile = path.join(root, "metrics.jsonl");
fs.writeFileSync(
  statsFile,
  [
    JSON.stringify({
      route: "primary",
      tool: "analyze",
      model: "lite-test",
      prompt_tokens: 1000,
      completion_tokens: 500,
      cache_hit_tokens: 100,
      cache_miss_tokens: 900
    }),
    JSON.stringify({
      route: "fallback",
      tool: "adapter",
      model: "fallback-test",
      prompt_tokens: 2000,
      completion_tokens: 1000
    }),
    JSON.stringify({
      route: "primary",
      tool: "adapter",
      model: "deepseek-v4-pro",
      prompt_tokens: 1000,
      completion_tokens: 0
    })
  ].join("\n"),
  "utf8"
);
const statsRun = spawnSync(process.execPath, ["scripts/stats.mjs", statsFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_PRICE_INPUT: "1",
    WORKER_PRICE_OUTPUT: "2",
    WORKER_PRICE_CACHE: "0.1"
  }
});
assert.equal(statsRun.status, 0, statsRun.stderr);
assert(statsRun.stdout.includes("cost_usd"));
assert(statsRun.stdout.includes("0.001910"));
assert(statsRun.stdout.includes("fallback_ratio\t33.3%"));
assert(statsRun.stdout.includes("escalate_calls\t1"));
assert(statsRun.stderr.includes("[warn] fallback ratio 33.3% exceeds 10%"));

const searchResult = search.searchWorkspace({ pattern: "needle", dirs: [project], glob: "*.txt" });
assert.equal(searchResult.mode, "lines");
assert(searchResult.results.some((line) => line.includes("needle.txt")));
const dashSearchResult = search.searchWorkspace({ pattern: "-needle", dirs: [project], glob: "*.txt" });
assert.equal(dashSearchResult.mode, "lines");

const sourceFiles = readSourceFiles(path.join(process.cwd(), "src"));
for (const { file, text } of sourceFiles) {
  assert(!/classif(?:y|ier|ication)[\s\S]{0,160}route/i.test(text), `I3 classify-then-route pattern found in ${file}`);
  assert(!/route[\s\S]{0,160}classif(?:y|ier|ication)/i.test(text), `I3 route classifier pattern found in ${file}`);
}

let capturedAnalyzeBody = "";
let analyzeFetchCount = 0;
const liteMetricsFile = path.join(root, "lite-metrics.jsonl");
process.env.WORKER_METRICS_FILE = liteMetricsFile;
globalThis.fetch = (async (_url: any, init: any) => {
  analyzeFetchCount += 1;
  capturedAnalyzeBody = String(init.body);
  return new Response(
    JSON.stringify({
      model: "lite-test",
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 },
      choices: [{ message: { content: "analysis ok" } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;
try {
  const answer = await lite.analyzeDirect("Where is the needle?", [path.join(project, "src", "*.txt")], 64);
  assert.equal(answer, "analysis ok");
  const request = JSON.parse(capturedAnalyzeBody);
  assert.equal(request.model, "lite-env-model");
  const content = request.messages[0].content;
  assert(content.indexOf("# FILE:") < content.indexOf("# QUESTION"));
  assert(content.includes("needle here"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cachedAnswer = await lite.analyzeDirect("Where is the needle?", [path.join(project, "src", "*.txt")], 64);
  assert.equal(cachedAnswer, "analysis ok");
  assert.equal(analyzeFetchCount, 1);
  const liteMetricRows = fs.readFileSync(liteMetricsFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert(liteMetricRows.some((row) => row.route === "cache" && row.tool === "analyze" && row.model === "(cached)"));
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.WORKER_METRICS_FILE;
}

let fallbackAttemptCount = 0;
const fallbackMetricsFile = path.join(root, "lite-fallback-metrics.jsonl");
process.env.FALLBACK_BASE_URL = "https://fallback.example.test/v1";
process.env.FALLBACK_API_KEY = "fallback-unit-test-api-key";
process.env.FALLBACK_MODEL = "fallback-lite-model";
process.env.WORKER_METRICS_FILE = fallbackMetricsFile;
globalThis.fetch = (async (url: any) => {
  fallbackAttemptCount += 1;
  if (String(url).startsWith("https://gateway.example.test")) {
    return new Response("primary failed", { status: 500 });
  }
  return new Response(
    JSON.stringify({
      model: "fallback-lite-model",
      usage: { prompt_tokens: 11, completion_tokens: 3 },
      choices: [{ message: { content: "fallback analysis ok" } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;
try {
  const answer = await lite.analyzeDirect("I5 fallback success count", [path.join(project, "src", "needle.txt")], 64);
  assert.equal(answer, "fallback analysis ok");
  assert.equal(fallbackAttemptCount, 2);
  const rows = fs.readFileSync(fallbackMetricsFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const successfulUpstreamRows = rows.filter((row) => row.route !== "cache");
  assert.equal(successfulUpstreamRows.length, 1);
  assert.equal(successfulUpstreamRows[0].route, "fallback");
  assert.equal(successfulUpstreamRows[0].tool, "analyze");
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.FALLBACK_BASE_URL;
  delete process.env.FALLBACK_API_KEY;
  delete process.env.FALLBACK_MODEL;
  delete process.env.WORKER_METRICS_FILE;
}

const invalidCacheDirRun = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", "await import('./dist/lite.js')"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SANDBOX_ROOT: root,
      WORKER_LITE_CACHE_DIR: outside
    }
  }
);
assert.notEqual(invalidCacheDirRun.status, 0);
assert((invalidCacheDirRun.stderr + invalidCacheDirRun.stdout).includes("WORKER_LITE_CACHE_DIR must be inside SANDBOX_ROOT"));

const prefixCacheRun = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
const lite = await import("./dist/lite.js");
const bodies = [];
globalThis.fetch = async (_url, init) => {
  bodies.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ model: "lite-test", usage: {}, choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
await lite.analyzeDirect("first question", [process.env.TEST_FILE], 64);
await lite.analyzeDirect("second question", [process.env.TEST_FILE], 64);
console.log(JSON.stringify(bodies));
`
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ADAPTER_PREFIX_CACHE: "1",
      SANDBOX_ROOT: root,
      TEST_FILE: path.join(project, "src", "needle.txt"),
      WORKER_LITE_CACHE_DIR: path.join(root, "prefix-cache")
    }
  }
);
assert.equal(prefixCacheRun.status, 0, prefixCacheRun.stderr);
const prefixBodies = JSON.parse(prefixCacheRun.stdout);
assert.equal(prefixBodies[0].system, "You are a read-only code analyst. Answer concisely based only on the files below.");
assert.equal(prefixBodies[0].messages[0].content, prefixBodies[1].messages[0].content);
assert.equal(prefixBodies[0].messages[1].role, "assistant");
assert.notEqual(prefixBodies[0].messages[2].content, prefixBodies[1].messages[2].content);

const reviseReport: ReasoningReport = {
  enabled: true,
  decision: "revise" as const,
  ready: false,
  belief: 0.1,
  difficulty: 0.5,
  halted_reason: "stalled",
  blockers: ["1 failing check"],
  risks: [{ kind: "failing_check" as const, detail: "check unit failed", severity: "high" as const }],
  unknowns: [],
  evidence: [],
  calibration: { stated_success: 0.1, evidence_confidence: 0.1, calibration_gap: 0, overconfident: false },
  required_changes: ["Make unit pass."],
  recommended_checks: [],
  should_revise: true,
  depth_trace: []
};
const revisePrompt = reasoning.buildRevisePrompt("Fix it", reviseReport, 1, "unit failed with stack trace");
assert(revisePrompt.includes("Evidence from the failing run"));

const largeFailureEvidence = `unit failed\n${"raw check output ".repeat(1000)}`;
const digestEvidence = "root cause: import mismatch\nkey evidence: tsc failure\nnext action: fix import";
const noRiskReport: ReasoningReport = { ...reviseReport, risks: [] };
const largeRevisePrompt = reasoning.buildRevisePrompt("Fix it", noRiskReport, 1, largeFailureEvidence);
const digestRevisePrompt = reasoning.buildRevisePrompt("Fix it", noRiskReport, 1, digestEvidence);
assert(digestRevisePrompt.includes(digestEvidence));
assert(!digestRevisePrompt.includes("raw check output raw check output"));
assert(Buffer.byteLength(digestRevisePrompt, "utf8") < Buffer.byteLength(largeRevisePrompt, "utf8") / 4);

const plan = claude.buildClaudeLaunchPlan(
  {
    prompt: "hello",
    allowed_dirs: [project],
    model: "gateway-model",
    permission_mode: "acceptEdits"
  },
  []
);
assert(plan.args.includes("--print"));
assert(plan.args.includes("--model"));
assert(plan.args.includes("sonnet"));
assert(plan.args.includes("--permission-mode"));
assert(!plan.args.includes("--bare"));
assert.equal(plan.model, "gateway-model");
assert.equal(plan.cliModel, "sonnet");
assert.equal(plan.env.ANTHROPIC_MODEL, "sonnet");
assert.equal(plan.env.CLAUDE_MODEL, "gateway-model");
assert.equal(plan.env.ANTHROPIC_API_KEY, "unit-test-api-key");
assert.equal(plan.env.ONEAPI_API_KEY, undefined);

assert.throws(
  () =>
    claude.buildClaudeLaunchPlan(
      {
        prompt: "hello",
        allowed_dirs: [project],
        permission_mode: "bypassPermissions"
      },
      []
    ),
  /bypassPermissions/
);

const gitProject = path.join(root, "git-project");
fs.mkdirSync(path.join(gitProject, "src"), { recursive: true });
spawnSync("git", ["init"], { cwd: gitProject, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: gitProject, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "Test"], { cwd: gitProject, stdio: "ignore" });
fs.writeFileSync(path.join(gitProject, "src", "a.txt"), "old\n", "utf8");
spawnSync("git", ["add", "."], { cwd: gitProject, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "init"], { cwd: gitProject, stdio: "ignore" });
fs.writeFileSync(path.join(gitProject, "src", "a.txt"), "new\n", "utf8");
fs.writeFileSync(path.join(gitProject, "src", "b.txt"), "created\n", "utf8");
const summary = workspace.collectWorkspaceSummary(gitProject, { relativePaths: ["src"], absolutePaths: [path.join(gitProject, "src")] });
assert(summary.changed_files.includes("src/a.txt"));
assert(summary.changed_files.includes("src/b.txt"));
assert(summary.diff.includes("new"));
assert(summary.diff.includes("created"));

const readonlyProject = path.join(root, "readonly-project");
fs.mkdirSync(path.join(readonlyProject, "src"), { recursive: true });
spawnSync("git", ["init"], { cwd: readonlyProject, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: readonlyProject, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "Test"], { cwd: readonlyProject, stdio: "ignore" });
const readonlyFile = path.join(readonlyProject, "src", "readme.txt");
fs.writeFileSync(readonlyFile, "stable read-only content\n", "utf8");
spawnSync("git", ["add", "."], { cwd: readonlyProject, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "init"], { cwd: readonlyProject, stdio: "ignore" });
assert.equal(gitPorcelain(readonlyProject), "");

globalThis.fetch = (async (_url: any, init: any) => {
  const request = JSON.parse(String(init.body));
  const content = JSON.stringify(request.messages ?? []);
  const answer = content.includes("Return ONLY JSON")
    ? '{"verdict":"approve","issues":[],"summary":"clean"}'
    : "readonly analysis ok";
  return new Response(JSON.stringify({ model: "lite-test", usage: {}, choices: [{ message: { content: answer } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}) as typeof fetch;
try {
  assert.equal(await lite.analyzeDirect("Summarize without editing.", [readonlyFile], 64), "readonly analysis ok");
  assert.equal(gitPorcelain(readonlyProject), "");
  assert.equal(
    await lite.reviewDirect({ files: [readonlyFile], focus: "Check without editing.", maxTokens: 64 }),
    '{"verdict":"approve","issues":[],"summary":"clean"}'
  );
  assert.equal(gitPorcelain(readonlyProject), "");
} finally {
  globalThis.fetch = originalFetch;
}

let attempts = 0;
globalThis.fetch = (async () => {
  attempts += 1;
  if (attempts === 1) {
    return new Response("rate limited", { status: 429, headers: { "retry-after": "0.001" } });
  }
  return new Response("ok", { status: 200 });
}) as typeof fetch;
process.env.ADAPTER_MAX_RETRIES = "1";
try {
  const response = await adapter.callOpenAIWithRetry("/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.ADAPTER_MAX_RETRIES;
}

console.log("core tests passed");
