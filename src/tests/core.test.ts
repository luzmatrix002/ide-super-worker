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
delete process.env.ADAPTER_PREFIX_CACHE;
delete process.env.CLAUDE_CODE_BARE;

const security = await import("../security.js");
const jobsModule = await import("../jobs.js");
const claude = await import("../claude.js");
const config = await import("../config.js");
const workspace = await import("../workspace.js");
const adapter = await import("../anthropic_openai_adapter.js");
const server = await import("../server.js");
const lite = await import("../lite.js");
const reasoning = await import("../reasoning.js");
const search = await import("../search.js");
const metrics = await import("../metrics.js");
const workerTools = await import("../worker_tools.js");
const artifacts = await import("../artifacts.js");
const abnormalOutput = await import("../abnormal_output.js");
const reliability = await import("../reliability.js");
const toolErrorControl = await import("../tool_error_control.js");
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
assert.equal(publicDiffJob.reliability.tier, "standard");
assert(publicDiffJob.episode);
assert.equal(publicDiffJob.episode.tier, "standard");
assert.equal(publicDiffJob.episode.changed_files_count, 0);
assert.equal(publicDiffJob.receipt.tool, "get");
assert.equal(publicDiffJob.receipt.category, "job_control");
assert(publicDiffJob.receipt.artifact_refs.length > 0);
assert.equal((publicDiffJob.receipt as any).abnormal.verdict, "accept");
assert(!JSON.stringify(publicDiffJob.receipt).includes("unit-test-api-key"));
const jobArtifactSlice = artifacts.getArtifactSlice({ artifact_ref: publicDiffJob.receipt.artifact_refs[0], limit: 40 });
assert.equal((jobArtifactSlice.receipt as any).tool, "get_artifact_slice");
assert(String(jobArtifactSlice.text).includes("job-"));
assert.throws(() => artifacts.getArtifactSlice({ artifact_ref: "../not-an-artifact" }), /invalid artifact_ref/);
const missingArtifactAssessment = abnormalOutput.assessAbnormalReceipt(
  {
    route: "worker",
    tool: "read_pack",
    category: "context_pack",
    input_bytes: 10,
    output_bytes: 40_000,
    summary_bytes: 1_200,
    artifact_refs: [],
    truncated: true,
    cached: false,
    status: "ok"
  },
  { artifactMinBytes: 32_000 }
);
assert.equal(missingArtifactAssessment.verdict, "repair");
assert.equal(missingArtifactAssessment.reason_code, "missing_artifact");
assert(missingArtifactAssessment.repair_prompt?.includes("artifact_ref"));
const failedCheckAssessment = abnormalOutput.assessAbnormalReceipt({
  route: "worker",
  tool: "shell",
  category: "command_digest",
  input_bytes: 10,
  output_bytes: 100,
  summary_bytes: 100,
  artifact_refs: [],
  truncated: false,
  cached: false,
  status: "error"
});
assert.equal(failedCheckAssessment.reason_code, "failed_check");
assert.equal(failedCheckAssessment.reviewer?.tool, "review");
const acceptedAssessment = abnormalOutput.assessAbnormalReceipt({
  route: "worker",
  tool: "diff_digest",
  category: "diff_digest",
  input_bytes: 10,
  output_bytes: 40_000,
  summary_bytes: 1_200,
  artifact_refs: ["artifact://11111111-1111-4111-8111-111111111111"],
  truncated: true,
  cached: false,
  status: "ok"
});
assert.equal(acceptedAssessment.verdict, "accept");
const toolCategories: Record<string, string> = {
  start: "implementation",
  get: "job_control",
  get_artifact_slice: "artifact",
  tail: "job_control",
  wait: "job_control",
  cancel: "job_control",
  analyze: "analysis",
  review: "review",
  search: "search",
  read_pack: "context_pack",
  diff_digest: "diff_digest",
  shell: "command_digest",
  apply_edits: "mechanical_edit",
  history: "history",
  draft: "draft"
};
for (const [tool, category] of Object.entries(toolCategories)) {
  const failure = server.toolFailureJson(tool, category, { token: "unit-test-api-key" }, new Error(`${tool} failed`)) as any;
  assert.equal(failure.status, "error");
  assert.equal(failure.tool, tool);
  assert.equal(failure.category, category);
  assert.equal(failure.error.message, `${tool} failed`);
  assert.equal(failure.receipt.status, "error");
  assert.equal(failure.receipt.tool, tool);
  assert(failure.fallback.action);
  assert(Array.isArray(failure.fallback.alternatives));
  assert(!JSON.stringify(failure).includes("unit-test-api-key"));
}
const verboseDiffJob = server.publicJob(diffJob, undefined, true) as any;
assert.equal(verboseDiffJob.result.diff, "");
assert.equal(verboseDiffJob.checks[0], diffJob.result.checks[0]);
assert.equal(metrics.pickCacheTokens({ prompt_tokens_details: { cached_tokens: 12 } }), 12);
assert.equal(metrics.pickCacheTokens({ cache_read_input_tokens: 7 }), 7);

const strictObserve = reliability.buildReliabilityProfile({ reliability_tier: "strict" });
assert.equal(strictObserve.blocking_policy, "observe");
assert.equal(strictObserve.blocking_risk, "observe_only");
assert(strictObserve.missing_gates.includes("checks"));
assert.equal(reliability.reliabilityRejectionReason(strictObserve), undefined);
const strictEnforce = reliability.buildReliabilityProfile({ reliability_tier: "strict", blocking_policy: "enforce" });
assert.equal(strictEnforce.blocking_risk, "would_block");
assert(reliability.reliabilityRejectionReason(strictEnforce)?.includes("missing gates"));
const strictReady = reliability.buildReliabilityProfile({
  reliability_tier: "strict",
  blocking_policy: "enforce",
  checks: [{ command: "npm test" }],
  scoped_patch: { paths: ["src"] }
});
assert.equal(strictReady.missing_gates.length, 0);
assert.equal(reliability.reliabilityRejectionReason(strictReady), undefined);
const criticalEpisode = reliability.buildEpisodeSummary({
  job_id: "episode-1",
  profile: reliability.buildReliabilityProfile({ reliability_tier: "critical" }),
  model: "cheap-model",
  started_at: new Date().toISOString(),
  changed_files: ["src/a.ts"],
  checks: ["unit: failed"],
  revise_passes: 1,
  stage_count: 2
});
assert.equal(criticalEpisode.failed_check_count, 1);
assert(criticalEpisode.trajectory_score < 100);
assert.equal(reliability.parseReliabilityTier("STRICT"), "strict");
assert.deepEqual(reliability.normalizeReliabilityArgs({ reliability_tier: "strict", blocking_policy: "warn", semantic_gate: "required", tool_budget: 7 }), {
  reliability_tier: "strict",
  blocking_policy: "warn",
  semantic_gate: "required",
  tool_budget: 7,
  episode: undefined
});

process.env.FALLBACK_MODELS = "fallback-a, fallback-b, fallback-a, fallback-c, fallback-d";
try {
  assert.deepEqual(config.getFallbackModels(), ["fallback-a", "fallback-b", "fallback-c"]);
  assert.equal(config.getFallbackModel(), "fallback-a");
  assert.equal(config.getFallbackEscalateModel(), "fallback-b");
} finally {
  delete process.env.FALLBACK_MODELS;
}
process.env.FALLBACK_MODEL = "legacy-fallback";
process.env.FALLBACK_ESCALATE_MODEL = "legacy-escalate";
try {
  assert.deepEqual(config.getFallbackModels(), ["legacy-fallback", "legacy-escalate"]);
  assert.equal(config.getFallbackModel(), "legacy-fallback");
  assert.equal(config.getFallbackEscalateModel(), "legacy-escalate");
} finally {
  delete process.env.FALLBACK_MODEL;
  delete process.env.FALLBACK_ESCALATE_MODEL;
}

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

const statsGatePassFile = path.join(root, "metrics-gate-pass.jsonl");
fs.writeFileSync(
  statsGatePassFile,
  [
    JSON.stringify({ event: "tool_call", route: "worker", tool: "search", category: "search", status: "ok" }),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "read_pack", category: "context_pack", status: "ok" }),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" }),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "diff_digest", category: "diff_digest", status: "ok", red_team: true }),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "start", category: "implementation", status: "ok" })
  ].join("\n"),
  "utf8"
);
const statsGatePassRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", statsGatePassFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_RATIO_REQUIRED_CATEGORIES: "search,context_pack,command_digest,diff_digest"
  }
});
assert.equal(statsGatePassRun.status, 0, statsGatePassRun.stderr);
assert(statsGatePassRun.stderr.includes("[gate] worker ratio gate passed"));

const statsGateRecentFile = path.join(root, "metrics-gate-recent.jsonl");
fs.writeFileSync(
  statsGateRecentFile,
  [
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "search", category: "search", status: "error" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "read_pack", category: "context_pack", status: "ok" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" })
  ].join("\n"),
  "utf8"
);
const statsGateRecentRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", "--since-minutes=60", statsGateRecentFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_TOOL_ERROR_MIN_CALLS: "10"
  }
});
assert.equal(statsGateRecentRun.status, 0, statsGateRecentRun.stderr);
assert(statsGateRecentRun.stderr.includes("[gate] worker ratio gate passed"));

const statsOverallErrorFile = path.join(root, "metrics-overall-error-fail.jsonl");
fs.writeFileSync(
  statsOverallErrorFile,
  [
    ...Array.from({ length: 19 }, () =>
      JSON.stringify({ event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" })
    ),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "error" })
  ].join("\n"),
  "utf8"
);
const statsOverallErrorRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", statsOverallErrorFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_CATEGORY_ERROR_MAX_PCT: "100",
    WORKER_SINGLE_TOOL_ERROR_MAX_PCT: "100",
    WORKER_OVERALL_TOOL_ERROR_MAX_PCT: "5"
  }
});
assert.equal(statsOverallErrorRun.status, 2);
assert(statsOverallErrorRun.stdout.includes("overall_tool_error_rate\t5.0%"));
assert(statsOverallErrorRun.stderr.includes("overall tool error rate 5.0% must stay below 5%"));

const statsSingleToolErrorFile = path.join(root, "metrics-single-tool-error-fail.jsonl");
fs.writeFileSync(
  statsSingleToolErrorFile,
  [
    ...Array.from({ length: 97 }, () =>
      JSON.stringify({ event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" })
    ),
    ...Array.from({ length: 3 }, () =>
      JSON.stringify({ event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "error" })
    )
  ].join("\n"),
  "utf8"
);
const statsSingleToolErrorRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", statsSingleToolErrorFile], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(statsSingleToolErrorRun.status, 2);
assert(statsSingleToolErrorRun.stdout.includes("command_digest\tshell\t100\t0\t0\t100.0%\t-\tdetail\t3.0%\t0"));
assert(statsSingleToolErrorRun.stderr.includes("command_digest/shell error rate 3.0% must stay below 3%"));

const toolErrorControlFile = path.join(root, "metrics-tool-error-control.jsonl");
const now = new Date();
fs.writeFileSync(
  toolErrorControlFile,
  [
    ...Array.from({ length: 96 }, () =>
      JSON.stringify({ ts: now.toISOString(), event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" })
    ),
    ...Array.from({ length: 3 }, () =>
      JSON.stringify({ ts: now.toISOString(), event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "error" })
    ),
    JSON.stringify({
      ts: now.toISOString(),
      event: "tool_call",
      route: "worker",
      tool: "shell",
      category: "command_digest",
      status: "ok",
      command_status: "failed"
    })
  ].join("\n"),
  "utf8"
);
toolErrorControl.clearToolErrorEscalation();
const toolErrorReview = toolErrorControl.reviewToolErrorRates({ metricsFile: toolErrorControlFile, now });
assert.equal(toolErrorReview.status, "breach");
assert.equal(toolErrorReview.thresholds.overallMaxPct, 5);
assert.equal(toolErrorReview.thresholds.singleToolMaxPct, 3);
assert(toolErrorReview.breaches.some((breach) => breach.scope === "tool" && breach.tool === "shell"));
assert.equal(toolErrorReview.totalErrors, 3);
const runToolErrorReview = toolErrorControl.runToolErrorReview({ metricsFile: toolErrorControlFile, now });
assert.equal(runToolErrorReview.status, "breach");
assert.equal(toolErrorControl.getToolErrorEscalation()?.reason, "error_rate_breach");
assert.equal(toolErrorControl.getToolErrorControlStartDefaults().reliability_tier, "strict");
assert.equal(toolErrorControl.getToolErrorControlStartDefaults().semantic_gate, "warn");
toolErrorControl.clearToolErrorEscalation();

const toolErrorUnderFloorFile = path.join(root, "metrics-tool-error-under-floor.jsonl");
fs.writeFileSync(
  toolErrorUnderFloorFile,
  [
    JSON.stringify({ ts: now.toISOString(), event: "tool_call", route: "worker", tool: "search", category: "search", status: "error" }),
    JSON.stringify({ ts: now.toISOString(), event: "tool_call", route: "worker", tool: "search", category: "search", status: "ok" })
  ].join("\n"),
  "utf8"
);
const underFloorReview = toolErrorControl.reviewToolErrorRates({ metricsFile: toolErrorUnderFloorFile, now });
assert.equal(underFloorReview.status, "ok");
assert.equal(underFloorReview.breaches.length, 0);

toolErrorControl.runToolErrorReview({ metricsFile: toolErrorUnderFloorFile, now: new Date(now.getTime() + 4 * 60 * 60 * 1000), expectedAtMs: now.getTime() });
assert.equal(toolErrorControl.getToolErrorEscalation()?.reason, "review_overdue");
toolErrorControl.clearToolErrorEscalation();

toolErrorControl.resetToolControlState();
assert.equal(
  toolErrorControl.detectToolErrorClass("review", "review", {
    error_message: 'fallback upstream returned 404: {"error":{"type":"upstream_error"}}'
  }),
  "upstream_404"
);
const immediateCircuit = toolErrorControl.recordToolControlOutcome(
  "review",
  "review",
  "error",
  { error_message: "fallback upstream returned 404" },
  now.getTime()
);
assert.equal(immediateCircuit.errorClass, "upstream_404");
assert.equal(immediateCircuit.circuitOpened, true);
const reviewCircuitDecision = toolErrorControl.getToolControlDecision("review", "review", now.getTime());
assert.equal(reviewCircuitDecision?.action, "degrade");
assert(reviewCircuitDecision?.alternatives.includes("diff_digest"));
toolErrorControl.recordToolControlIntercept(reviewCircuitDecision!);
toolErrorControl.resetToolControlState();

process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS = "2";
process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS = "2";
process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS = "2";
process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES = "";
try {
  toolErrorControl.recordToolControlOutcome("shell", "command_digest", "ok", {
    command_status: "failed",
    failure_kind: "test_failure"
  });
  assert.equal(toolErrorControl.getToolControlDecision("shell", "command_digest"), undefined);
  toolErrorControl.recordToolControlOutcome("shell", "command_digest", "error", { error_message: "spawn failed once" }, now.getTime());
  assert.equal(toolErrorControl.getToolControlDecision("shell", "command_digest", now.getTime()), undefined);
  toolErrorControl.recordToolControlOutcome("shell", "command_digest", "error", { error_message: "spawn failed twice" }, now.getTime() + 1);
  const shellCircuitDecision = toolErrorControl.getToolControlDecision("shell", "command_digest", now.getTime() + 2);
  assert.equal(shellCircuitDecision?.action, "reject");
  assert(shellCircuitDecision?.requiredAction);
} finally {
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS;
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES;
  toolErrorControl.resetToolControlState();
}

const circuitStateFile = path.join(root, "tool-circuit-state.json");
process.env.WORKER_TOOL_CIRCUIT_STATE_FILE = circuitStateFile;
process.env.WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS = "0";
try {
  toolErrorControl.resetToolControlState();
  toolErrorControl.recordToolControlOutcome(
    "review",
    "review",
    "error",
    { error_message: "fallback upstream returned 404" },
    now.getTime()
  );
  assert(fs.existsSync(circuitStateFile));
  const persistedCircuitState = JSON.parse(fs.readFileSync(circuitStateFile, "utf8"));
  assert.equal(persistedCircuitState.version, 2);
  assert(String(persistedCircuitState.checksum).startsWith("sha256:"));
  assert(persistedCircuitState.events.length >= 1);
  assert.equal(fs.readdirSync(path.dirname(circuitStateFile)).filter((name) => name.includes("tool-circuit-state.json.") && name.endsWith(".tmp")).length, 0);
  assert.equal(toolErrorControl.getToolControlDecision("review", "review", now.getTime())?.action, "degrade");
  toolErrorControl.resetToolControlState({ persist: false });
  assert.equal(toolErrorControl.getToolControlDecision("review", "review", now.getTime())?.action, "degrade");

  process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS = "2";
  process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS = "2";
  process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS = "2";
  process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES = "";
  toolErrorControl.resetToolControlState();
  toolErrorControl.recordToolControlOutcome("search", "search", "error", { error_message: "search timed out once" }, now.getTime() + 10);
  assert.equal(toolErrorControl.getToolControlDecision("search", "search", now.getTime() + 11), undefined);
  toolErrorControl.resetToolControlState({ persist: false });
  assert.equal(toolErrorControl.loadToolCircuitState({ force: true, now: now.getTime() + 12 }), 0);
  toolErrorControl.recordToolControlOutcome("search", "search", "error", { error_message: "search timed out twice" }, now.getTime() + 13);
  assert.equal(toolErrorControl.getToolControlDecision("search", "search", now.getTime() + 14)?.action, "reject");
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS;
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES;

  fs.writeFileSync(
    circuitStateFile,
    JSON.stringify({
      version: 1,
      savedAt: now.toISOString(),
      circuits: [
        {
          key: "search:search_timeout",
          tool: "search",
          category: "search",
          errorClass: "search_timeout",
          openedAt: now.getTime() - 20_000,
          expiresAt: now.getTime() - 10_000,
          reason: "expired test circuit",
          requiredAction: "expired",
          alternatives: ["read_pack"]
        }
      ]
    }),
    "utf8"
  );
  toolErrorControl.resetToolControlState({ persist: false });
  assert.equal(toolErrorControl.loadToolCircuitState({ force: true, now: now.getTime() }), 0);
  assert.equal(toolErrorControl.getToolControlDecision("search", "search", now.getTime()), undefined);
  assert.equal(JSON.parse(fs.readFileSync(circuitStateFile, "utf8")).circuits.length, 0);

  fs.writeFileSync(
    circuitStateFile,
    JSON.stringify({
      version: 2,
      savedAt: now.toISOString(),
      circuits: [],
      events: [],
      checksum: "sha256:not-the-right-state"
    }),
    "utf8"
  );
  toolErrorControl.resetToolControlState({ persist: false });
  assert.equal(toolErrorControl.loadToolCircuitState({ force: true, now: now.getTime() }), 0);
  assert.equal(toolErrorControl.getToolControlDecision("review", "review", now.getTime()), undefined);

  fs.writeFileSync(circuitStateFile, "{bad json", "utf8");
  toolErrorControl.resetToolControlState({ persist: false });
  assert.equal(toolErrorControl.loadToolCircuitState({ force: true, now: now.getTime() }), 0);
  assert.equal(toolErrorControl.getToolControlDecision("review", "review", now.getTime()), undefined);
  const postCorruptionOutcome = toolErrorControl.recordToolControlOutcome(
    "review",
    "review",
    "error",
    { error_message: "fallback upstream returned 404 after corrupt state" },
    now.getTime() + 1
  );
  assert.equal(postCorruptionOutcome.circuitOpened, true);
  assert.equal(toolErrorControl.getToolControlDecision("review", "review", now.getTime() + 2)?.action, "degrade");

  const staleLockFile = `${circuitStateFile}.lock`;
  fs.writeFileSync(staleLockFile, "stale lock", "utf8");
  fs.utimesSync(staleLockFile, new Date(now.getTime() - 120_000), new Date(now.getTime() - 120_000));
  toolErrorControl.resetToolControlState({ persist: false });
  toolErrorControl.recordToolControlOutcome(
    "review",
    "review",
    "error",
    { error_message: "fallback upstream returned 404 after stale lock" },
    now.getTime() + 3
  );
  assert.equal(fs.existsSync(staleLockFile), false);
} finally {
  delete process.env.WORKER_TOOL_CIRCUIT_STATE_FILE;
  delete process.env.WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS;
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS;
  delete process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS;
  delete process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES;
  toolErrorControl.resetToolControlState();
}

const statsRejectedFile = path.join(root, "metrics-rejected.jsonl");
fs.writeFileSync(
  statsRejectedFile,
  [
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "start", category: "implementation", status: "rejected" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "read_pack", category: "context_pack", status: "ok" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "search", category: "search", status: "ok" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "shell", category: "command_digest", status: "ok" }),
    JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", route: "worker", tool: "diff_digest", category: "diff_digest", status: "ok", red_team: true })
  ].join("\n"),
  "utf8"
);
const statsRejectedRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", statsRejectedFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, WORKER_RATIO_REQUIRED_CATEGORIES: "context_pack" }
});
assert.equal(statsRejectedRun.status, 0, statsRejectedRun.stderr);
assert(statsRejectedRun.stdout.includes("rejected_calls"));
assert(statsRejectedRun.stdout.includes("implementation\t(all)\t1\t0\t0\t100.0%\tn/a\tobserve\t0.0%\t1"));
const auditRejectedRun = spawnSync(process.execPath, ["scripts/codex_audit.mjs", "--required-categories=context_pack", statsRejectedFile], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(auditRejectedRun.status, 0, auditRejectedRun.stderr);
assert(auditRejectedRun.stdout.includes("category\tworker\tmain\tother\terror\trejected"));
assert(auditRejectedRun.stdout.includes("implementation\t1\t0\t0\t0\t1"));

const statsGateFailFile = path.join(root, "metrics-gate-fail.jsonl");
fs.writeFileSync(
  statsGateFailFile,
  [
    JSON.stringify({ event: "tool_call", route: "main", tool: "read_file", category: "context_pack", status: "ok" }),
    JSON.stringify({ event: "tool_call", route: "worker", tool: "read_pack", category: "context_pack", status: "ok" })
  ].join("\n"),
  "utf8"
);
const statsGateFailRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", statsGateFailFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_RATIO_REQUIRED_CATEGORIES: "context_pack"
  }
});
assert.equal(statsGateFailRun.status, 2);
assert(statsGateFailRun.stderr.includes("[gate] context_pack worker ratio 50.0% below target 70%"));

const statsSinceFile = path.join(root, "metrics-since-last-wins.jsonl");
fs.writeFileSync(
  statsSinceFile,
  [
    JSON.stringify({ ts: new Date(Date.now() - 90 * 60_000).toISOString(), route: "primary", tool: "analyze", model: "test-model", prompt_tokens: 100, completion_tokens: 1 }),
    JSON.stringify({ ts: new Date().toISOString(), route: "primary", tool: "analyze", model: "test-model", prompt_tokens: 7, completion_tokens: 1 })
  ].join("\n"),
  "utf8"
);
const statsSinceRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--since-minutes=120", "--since-minutes=10", statsSinceFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    WORKER_PRICE_INPUT: "1",
    WORKER_PRICE_OUTPUT: "1"
  }
});
assert.equal(statsSinceRun.status, 0, statsSinceRun.stderr);
assert(statsSinceRun.stdout.includes("TOTAL\t-\t-\t1\t7\t1"));

const receiptStatsFile = path.join(root, "metrics-receipt-pass.jsonl");
fs.writeFileSync(
  receiptStatsFile,
  [
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "tool_call",
      route: "worker",
      tool: "read_pack",
      category: "context_pack",
      status: "ok",
      receipt: {
        route: "worker",
        tool: "read_pack",
        category: "context_pack",
        input_bytes: 10,
        output_bytes: 40000,
        summary_bytes: 1200,
        artifact_refs: ["artifact://11111111-1111-4111-8111-111111111111"],
        truncated: true,
        cached: false,
        status: "ok",
        abnormal: { verdict: "accept", confidence: 0.97, issues: [] }
      }
    })
  ].join("\n"),
  "utf8"
);
const receiptStatsRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", receiptStatsFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, WORKER_RATIO_REQUIRED_CATEGORIES: "context_pack" }
});
assert.equal(receiptStatsRun.status, 0, receiptStatsRun.stderr);
assert(receiptStatsRun.stdout.includes("Receipt Audit"));
assert(receiptStatsRun.stdout.includes("artifact_usage_rate"));
assert(receiptStatsRun.stdout.includes("abnormal_accept_rows"));

const receiptStatsFailFile = path.join(root, "metrics-receipt-fail.jsonl");
fs.writeFileSync(
  receiptStatsFailFile,
  [
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "tool_call",
      route: "worker",
      tool: "read_pack",
      category: "context_pack",
      status: "ok",
      receipt: {
        route: "worker",
        tool: "read_pack",
        category: "context_pack",
        input_bytes: 10,
        output_bytes: 40000,
        summary_bytes: 1200,
        artifact_refs: [],
        truncated: true,
        cached: false,
        status: "ok",
        abnormal: {
          verdict: "repair",
          reason_code: "missing_artifact",
          confidence: 0.96,
          issues: [{ reason_code: "missing_artifact", severity: "high", note: "missing artifact" }]
        }
      }
    })
  ].join("\n"),
  "utf8"
);
const receiptStatsFailRun = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", receiptStatsFailFile], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, WORKER_RATIO_REQUIRED_CATEGORIES: "context_pack" }
});
assert.equal(receiptStatsFailRun.status, 2);
assert(receiptStatsFailRun.stderr.includes("without artifact_ref"));

const receiptAuditRun = spawnSync(process.execPath, ["scripts/codex_audit.mjs", "--required-categories=context_pack", receiptStatsFile], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(receiptAuditRun.status, 0, receiptAuditRun.stderr);
assert(receiptAuditRun.stdout.includes("receipt_artifact_usage: 100.0%"));
assert(receiptAuditRun.stdout.includes("abnormal_accept_rows: 1"));
const receiptAuditFailRun = spawnSync(process.execPath, ["scripts/codex_audit.mjs", "--required-categories=context_pack", receiptStatsFailFile], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(receiptAuditFailRun.status, 2);
assert(receiptAuditFailRun.stderr.includes("without artifact_ref"));
assert(receiptAuditFailRun.stdout.includes("abnormal_repair_rows: 1"));

const searchResult = search.searchWorkspace({ pattern: "needle", dirs: [project], glob: "*.txt" });
assert.equal(searchResult.mode, "lines");
assert(searchResult.results.some((line) => line.includes("needle.txt")));
const dashSearchResult = search.searchWorkspace({ pattern: "-needle", dirs: [project], glob: "*.txt" });
assert.equal(dashSearchResult.mode, "lines");
const fileSearchResult = search.searchWorkspace({ pattern: "needle", dirs: [path.join(project, "src", "needle.txt")] });
assert.equal(fileSearchResult.mode, "lines");
assert(fileSearchResult.results.some((line) => line.includes("needle here")));
const noisySearchDir = path.join(project, "noisy-search");
fs.mkdirSync(noisySearchDir);
for (let i = 0; i < 80; i += 1) {
  fs.writeFileSync(path.join(noisySearchDir, `match-${i}.txt`), `needle ${"x".repeat(80)}\n`, "utf8");
}
process.env.WORKER_SEARCH_RG_MAX_BUFFER = "64";
try {
  const overflowSearchResult = search.searchWorkspace({ pattern: "needle", dirs: [noisySearchDir], max_results: 5 });
  assert.equal(overflowSearchResult.engine, "node");
  assert.equal(overflowSearchResult.results.length, 5);
} finally {
  delete process.env.WORKER_SEARCH_RG_MAX_BUFFER;
}

const bypassRejection = server.preflightStartRejection({
  prompt: "hello",
  allowed_dirs: [project],
  permission_mode: "bypassPermissions"
}) as any;
assert.equal(bypassRejection.status, "rejected");
assert.equal(bypassRejection.receipt.tool, "start");
assert.equal(bypassRejection.receipt.category, "implementation");
assert.equal(
  server.preflightStartRejection({
    prompt: "hello",
    allowed_dirs: [project],
    reliability_tier: "strict"
  }),
  undefined
);
const reliabilityRejection = server.preflightStartRejection({
  prompt: "hello",
  allowed_dirs: [project],
  reliability_tier: "strict",
  blocking_policy: "enforce"
}) as any;
assert.equal(reliabilityRejection.status, "rejected");
assert(reliabilityRejection.reason.includes("reliability_policy blocked strict job"));
process.env.ALLOW_BYPASS_PERMISSIONS = "1";
try {
  assert.equal(
    server.preflightStartRejection({
      prompt: "hello",
      allowed_dirs: [project],
      permission_mode: "bypassPermissions"
    }),
    undefined
  );
} finally {
  delete process.env.ALLOW_BYPASS_PERMISSIONS;
}

const pack = workerTools.buildContextPack({ task: "find needle", paths: ["src/needle.txt"], base_dir: project });
assert.equal(pack.file_count, 1);
assert(JSON.stringify(pack).includes("needle here"));
const packReceipt = pack.receipt as any;
assert(Array.isArray(packReceipt.artifact_refs));
assert(packReceipt.artifact_refs.length > 0);
const packSlice = artifacts.getArtifactSlice({ artifact_ref: packReceipt.artifact_refs[0], offset: 0, limit: 80 });
assert(String(packSlice.text).includes("needle"));
const tinyPackSlice = artifacts.getArtifactSlice({ artifact_ref: packReceipt.artifact_refs[0], offset: 0, limit: 8 });
assert.equal(tinyPackSlice.limit, 8);

const editFile = path.join(project, "src", "mechanical.txt");
fs.writeFileSync(editFile, "alpha beta alpha\n", "utf8");
const edits = workerTools.applyMechanicalEdits({
  cwd: project,
  edits: [{ file: "src/mechanical.txt", search: "alpha", replace: "omega", expected_replacements: 2 }]
});
assert.deepEqual(edits.changed_files, ["src/mechanical.txt"]);
assert.equal(fs.readFileSync(editFile, "utf8"), "omega beta omega\n");

const shellResult = await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "console.log('worker-shell-ok')"`,
  timeout_ms: 30_000
});
assert.equal(shellResult.status, "passed");
assert(String(shellResult.output).includes("worker-shell-ok"));
const shellDigestResult = await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "console.log('worker-shell-ok')"`,
  digest: true,
  timeout_ms: 30_000
});
assert.equal(shellDigestResult.status, "passed");
assert(String(shellDigestResult.digest).startsWith("command passed"));
const shellReceipt = shellDigestResult.receipt as any;
assert(shellReceipt.artifact_refs.length > 0);
const shellSlice = artifacts.getArtifactSlice({ artifact_ref: shellReceipt.artifact_refs[0], limit: 80 });
assert(String(shellSlice.text).includes("worker-shell-ok"));
assert.equal(workerTools.shouldAutoReroutePowerShellCommand("Get-Content package.json"), process.platform === "win32");
assert(workerTools.powershellRerouteCommand("Write-Output worker-powershell-reroute").includes("powershell -NoProfile"));
if (process.platform === "win32") {
  const shellRerouteResult = await workerTools.runWorkerShell({
    cwd: project,
    command: "Write-Output worker-powershell-reroute",
    digest: true,
    timeout_ms: 30_000
  });
  assert.equal(shellRerouteResult.status, "passed");
  assert.equal((shellRerouteResult as any).rerouted_from, "cmd");
  assert.equal((shellRerouteResult as any).reroute_reason, "shell_mismatch");
  assert(String(shellRerouteResult.output).includes("worker-powershell-reroute"));
}
const shellFailResult = await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "console.error('AssertionError: worker-shell-fail'); process.exit(1)"`,
  digest: true,
  timeout_ms: 30_000
});
assert.equal(shellFailResult.status, "failed");
assert.equal((shellFailResult as any).failure_kind, "test_failure");
assert(String((shellFailResult as any).required_action).includes("Fix the failing test"));
assert.equal((shellFailResult.receipt as any).status, "error");
const shellBusinessFailureMetric = server.workerMetricStatusFromPayload(shellFailResult) as any;
assert.equal(shellBusinessFailureMetric.status, "ok");
assert.equal(shellBusinessFailureMetric.extra.command_status, "failed");
assert.equal(shellBusinessFailureMetric.extra.failure_kind, "test_failure");
const staleJobMetric = server.workerMetricStatusFromPayload({
  status: "rejected",
  receipt: {
    route: "worker",
    tool: "get",
    category: "job_control",
    input_bytes: 1,
    output_bytes: 1,
    summary_bytes: 1,
    artifact_refs: [],
    truncated: false,
    cached: false,
    status: "ok"
  }
}) as any;
assert.equal(staleJobMetric.status, "rejected");

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
const diffDigest = await workerTools.digestDiff({ cwd: gitProject });
assert((diffDigest.changed_files as string[]).includes("src/a.txt"));
assert(Array.isArray(diffDigest.files));
const diffReceipt = diffDigest.receipt as any;
assert(diffReceipt.artifact_refs.length > 0);
const diffSlice = artifacts.getArtifactSlice({ artifact_ref: diffReceipt.artifact_refs[0], limit: 2000 });
assert(String(diffSlice.text).includes("new"));
const history = workerTools.gitHistory({ cwd: gitProject, file: "src/a.txt", line: 1 });
assert.equal(history.file, "src/a.txt");
assert(Array.isArray(history.commits));

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
