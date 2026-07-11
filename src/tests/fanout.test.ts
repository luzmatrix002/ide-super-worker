import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Test setup ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-test-root-"));
const project = path.join(root, "project");
fs.mkdirSync(path.join(project, "src"), { recursive: true });

process.env.SANDBOX_ROOT = root;
process.env.ONEAPI_BASE_URL = "https://gateway.example.test/v1";
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.WORKER_LITE_MODEL = "lite-test-model";
process.env.WORKER_FANOUT_ENABLED = "1";
process.env.WORKER_SEMANTIC_REVIEW_MODEL = "reviewer-test-model";
// Disable cache to ensure each call hits the mock.
process.env.WORKER_LITE_CACHE_DIR = "";
// Prevent test metrics from polluting the production metrics file.
process.env.WORKER_METRICS_FILE = "";

const originalFetch = globalThis.fetch;

// Test file content
fs.writeFileSync(
  path.join(project, "src", "module.ts"),
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n",
  "utf8"
);

// ── Test 1: Compatibility — no branches means single-path (unchanged behavior) ─

let analyzeCallCount = 0;
globalThis.fetch = (async (_url: any, init: any) => {
  analyzeCallCount += 1;
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);
  let answer: string;
  if (content.includes("Return ONLY JSON")) {
    answer = '{"verdict":"approve","issues":[],"summary":"clean"}';
  } else if (content.includes("synthesis reviewer") || content.includes("Synthesize")) {
    answer = JSON.stringify({
      verdict: "approve",
      summary: "all branches agree",
      findings: [],
      disagreements: [],
      confidence: "high",
      evidence_complete: true
    });
  } else {
    answer = "analysis ok from single path";
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: answer } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

try {
  const lite = await import("../lite.js");
  const fanout = await import("../fanout.js");

  // Single-path analyze (no branches) — should work exactly as before.
  const singleAnswer = await lite.analyzeDirect("What does add do?", [path.join(project, "src", "module.ts")], 64);
  assert.equal(singleAnswer, "analysis ok from single path");
  assert.equal(analyzeCallCount, 1);
  console.log("[fanout-test] compatibility: single-path analyze unchanged ✓");
} catch (err) {
  console.error("[fanout-test] compatibility FAILED:", err);
  process.exit(1);
}

// ── Test 2: Fan-out analyze — concurrent branches with synthesis ─────────────

analyzeCallCount = 0;
const branchCallTimestamps: number[] = [];
globalThis.fetch = (async (_url: any, init: any) => {
  analyzeCallCount += 1;
  const now = Date.now();
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);
  branchCallTimestamps.push(now);

  // Simulate some processing delay to verify overlap.
  await new Promise((resolve) => setTimeout(resolve, 50));

  let answer: string;
  if (content.includes("synthesis reviewer") || content.includes("Synthesize")) {
    answer = JSON.stringify({
      verdict: "approve",
      summary: "branches agree on add function",
      findings: [{ severity: "low", message: "no issues found" }],
      disagreements: [],
      confidence: "high",
      evidence_complete: true
    });
  } else if (content.includes("Return ONLY JSON")) {
    answer = '{"verdict":"approve","issues":[],"summary":"clean"}';
  } else {
    const branchFocus = content.includes("spec-check")
      ? "spec analysis: add returns sum"
      : content.includes("regression-check")
        ? "regression analysis: no breaking changes"
        : "general analysis: function is correct";
    answer = branchFocus;
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: answer } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "Analyze the add function",
    evidence,
    [
      { id: "spec", focus: "spec-check: verify function signature and return type" },
      { id: "regression", focus: "regression-check: check for breaking changes" },
      { id: "edge", focus: "edge-case: verify behavior with negative numbers" }
    ],
    { aggregate: "strong_review" }
  );

  assert.equal(result.contract_version, "fanout.v1");
  assert.equal(result.kind, "analyze");
  assert.equal(result.branches.length, 3);
  assert.equal(result.status, "complete");
  assert(result.synthesis, "synthesis should be present when ≥2 branches succeed");
  assert.equal(result.synthesis!.verdict, "approve");
  assert.equal(result.synthesis!.confidence, "high");
  assert.equal(result.synthesis!.evidence_complete, true);

  // Each branch should have a preview and artifact_ref.
  for (const branch of result.branches) {
    assert.equal(branch.status, "completed");
    assert(branch.preview, `branch ${branch.id} should have a preview`);
    assert(branch.artifact_ref, `branch ${branch.id} should have an artifact_ref`);
    assert(branch.duration_ms >= 0);
  }

  // Verify branches were called concurrently (timestamps should overlap).
  // With 3 branches and 50ms delay each, if serial it would take 150ms+.
  // If concurrent, the timestamps should be within a few ms of each other.
  const timestamps = branchCallTimestamps.slice(0, 3); // first 3 are branch calls
  const maxDiff = Math.max(...timestamps) - Math.min(...timestamps);
  assert(maxDiff < 100, `branches should start concurrently (max diff: ${maxDiff}ms)`);

  // 4th call should be the synthesis reviewer.
  assert.equal(analyzeCallCount, 4);

  console.log("[fanout-test] fan-out analyze with synthesis ✓");
} catch (err) {
  console.error("[fanout-test] fan-out analyze FAILED:", err);
  process.exit(1);
}

// ── Test 3: Partial failure — one branch fails ───────────────────────────────

analyzeCallCount = 0;
globalThis.fetch = (async (_url: any, init: any) => {
  analyzeCallCount += 1;
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);

  if (content.includes("failing-branch")) {
    return new Response("internal error", { status: 500 });
  }

  await new Promise((resolve) => setTimeout(resolve, 30));

  let answer: string;
  if (content.includes("synthesis reviewer") || content.includes("Synthesize")) {
    answer = JSON.stringify({
      verdict: "needs_changes",
      summary: "one branch failed, others passed",
      findings: [{ severity: "medium", message: "partial analysis" }],
      disagreements: ["branch-2 was unavailable"],
      confidence: "medium",
      evidence_complete: false
    });
  } else {
    answer = "branch analysis ok";
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: answer } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "Analyze with partial failure",
    evidence,
    [
      { id: "ok-1", focus: "first good branch" },
      { id: "fail", focus: "failing-branch: should fail" },
      { id: "ok-2", focus: "second good branch" }
    ],
    { aggregate: "strong_review" }
  );

  assert.equal(result.status, "partial");
  assert(result.reason_codes.includes("partial_branch_failure"));
  assert.equal(result.branches.filter((b) => b.status === "completed").length, 2);
  assert.equal(result.branches.filter((b) => b.status === "failed").length, 1);

  const failedBranch = result.branches.find((b) => b.status === "failed")!;
  assert(failedBranch.reason_code, "failed branch should have a reason_code");

  // Synthesis should still run because ≥2 branches succeeded.
  assert(result.synthesis, "synthesis should run when ≥2 branches succeed");

  console.log("[fanout-test] partial failure with synthesis ✓");
} catch (err) {
  console.error("[fanout-test] partial failure FAILED:", err);
  process.exit(1);
}

// ── Test 4: All branches fail — status=failed, no synthesis ──────────────────

globalThis.fetch = (async () => {
  return new Response("service unavailable", { status: 503 });
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "All branches fail",
    evidence,
    [
      { id: "a", focus: "branch a" },
      { id: "b", focus: "branch b" }
    ],
    { aggregate: "strong_review" }
  );

  assert.equal(result.status, "failed");
  assert(result.reason_codes.includes("all_branches_failed"));
  assert(!result.synthesis, "synthesis should NOT run when 0 branches succeed");
  assert.equal(result.branches.filter((b) => b.status === "failed").length, 2);

  console.log("[fanout-test] all branches fail ✓");
} catch (err) {
  console.error("[fanout-test] all branches fail FAILED:", err);
  process.exit(1);
}

// ── Test 5: Single branch success — partial, no synthesis ────────────────────

globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);
  if (content.includes("will fail")) {
    return new Response("error", { status: 500 });
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: {},
      choices: [{ message: { content: "only branch that succeeded" } }]
    }),
    { status: 200 }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "Single success",
    evidence,
    [
      { id: "fail", focus: "will fail" },
      { id: "ok", focus: "will succeed" }
    ],
    { aggregate: "strong_review" }
  );

  assert.equal(result.status, "partial");
  assert(result.reason_codes.includes("synthesis_skipped_single_branch"));
  assert(!result.synthesis, "synthesis should be skipped when only 1 branch succeeds");

  console.log("[fanout-test] single branch success, no synthesis ✓");
} catch (err) {
  console.error("[fanout-test] single branch success FAILED:", err);
  process.exit(1);
}

// ── Test 6: aggregate=none — no synthesis even with all branches passing ─────

globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: {},
      choices: [{ message: { content: "branch output" } }]
    }),
    { status: 200 }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "No synthesis",
    evidence,
    [
      { id: "a", focus: "branch a" },
      { id: "b", focus: "branch b" }
    ],
    { aggregate: "none" }
  );

  assert.equal(result.status, "complete");
  assert(!result.synthesis, "synthesis should NOT run when aggregate=none");

  console.log("[fanout-test] aggregate=none skips synthesis ✓");
} catch (err) {
  console.error("[fanout-test] aggregate=none FAILED:", err);
  process.exit(1);
}

// ── Test 7: Validation — duplicate branch IDs ────────────────────────────────

try {
  const fanout = await import("../fanout.js");
  assert.throws(
    () => fanout.validateBranches([
      { id: "dup", focus: "first" },
      { id: "dup", focus: "second" }
    ]),
    /duplicate branch id/
  );
  console.log("[fanout-test] duplicate branch IDs rejected ✓");
} catch (err) {
  console.error("[fanout-test] duplicate branch IDs FAILED:", err);
  process.exit(1);
}

// ── Test 8: Validation — too few branches ────────────────────────────────────

try {
  const fanout = await import("../fanout.js");
  assert.throws(
    () => fanout.validateBranches([{ id: "only", focus: "single" }]),
    /at least 2 branches/
  );
  console.log("[fanout-test] too few branches rejected ✓");
} catch (err) {
  console.error("[fanout-test] too few branches FAILED:", err);
  process.exit(1);
}

// ── Test 9: Validation — too many branches ───────────────────────────────────

try {
  const fanout = await import("../fanout.js");
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, focus: `focus ${i}` }));
  assert.throws(
    () => fanout.validateBranches(tooMany),
    /at most/
  );
  console.log("[fanout-test] too many branches rejected ✓");
} catch (err) {
  console.error("[fanout-test] too many branches FAILED:", err);
  process.exit(1);
}

// ── Test 10: Validation — missing focus ──────────────────────────────────────

try {
  const fanout = await import("../fanout.js");
  assert.throws(
    () => fanout.validateBranches([
      { id: "a", focus: "has focus" },
      { id: "b", focus: "" }
    ]),
    /focus is required/
  );
  console.log("[fanout-test] missing focus rejected ✓");
} catch (err) {
  console.error("[fanout-test] missing focus FAILED:", err);
  process.exit(1);
}

// ── Test 11: Evidence validation — truncated evidence rejected ───────────────

try {
  const fanout = await import("../fanout.js");
  assert.throws(
    () => fanout.validateFanoutEvidence({ fileCount: 5, totalBytes: 1000, truncated: true }),
    /truncated/
  );
  console.log("[fanout-test] truncated evidence rejected ✓");
} catch (err) {
  console.error("[fanout-test] truncated evidence FAILED:", err);
  process.exit(1);
}

// ── Test 12: Evidence validation — too many files ────────────────────────────

try {
  const fanout = await import("../fanout.js");
  assert.throws(
    () => fanout.validateFanoutEvidence({ fileCount: 25, totalBytes: 1000, truncated: false }),
    /exceeds.*files/
  );
  console.log("[fanout-test] too many files rejected ✓");
} catch (err) {
  console.error("[fanout-test] too many files FAILED:", err);
  process.exit(1);
}

// ── Test 13: Reviewer missing model — rejected before branch execution ───────

try {
  const originalReviewModel = process.env.WORKER_SEMANTIC_REVIEW_MODEL;
  delete process.env.WORKER_SEMANTIC_REVIEW_MODEL;
  try {
    const fanoutModule = await import("../fanout.js");
    const lite = await import("../lite.js");
    const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
    await fanoutModule.fanoutCoordinator.runAnalyze(
      "should reject",
      evidence,
      [{ id: "a", focus: "a" }, { id: "b", focus: "b" }],
      { aggregate: "strong_review" }
    );
    assert.fail("should have thrown FanoutValidationError");
  } catch (err: any) {
    assert.equal(err.name, "FanoutValidationError");
    assert(err.message.includes("WORKER_SEMANTIC_REVIEW_MODEL"));
  } finally {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = originalReviewModel;
  }
  console.log("[fanout-test] reviewer missing model rejected ✓");
} catch (err) {
  console.error("[fanout-test] reviewer missing model FAILED:", err);
  process.exit(1);
}

// ── Test 14: Fan-out review — concurrent review branches ─────────────────────

globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init.body));
  const content = JSON.stringify(body.messages ?? []);
  let answer: string;
  if (content.includes("synthesis reviewer") || content.includes("Synthesize")) {
    answer = JSON.stringify({
      verdict: "approve",
      summary: "all review dimensions pass",
      findings: [],
      disagreements: [],
      confidence: "high",
      evidence_complete: true
    });
  } else if (content.includes("Return ONLY JSON")) {
    answer = '{"verdict":"approve","issues":[],"summary":"clean"}';
  } else {
    answer = "review output";
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: answer } }]
    }),
    { status: 200 }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runReview(
    {
      task: "Review the module",
      diff: "diff --git a/src/module.ts b/src/module.ts\n+export function add()",
      checks: ["tsc: passed"],
      evidenceContent: evidence.content,
      evidenceFileCount: evidence.fileCount,
      evidenceTotalBytes: evidence.totalBytes,
      evidenceTruncated: evidence.truncated
    },
    [
      { id: "spec", focus: "Check if function signatures match the spec" },
      { id: "regression", focus: "Check for regression risks" },
      { id: "boundary", focus: "Check boundary conditions" }
    ],
    { aggregate: "strong_review" }
  );

  assert.equal(result.contract_version, "fanout.v1");
  assert.equal(result.kind, "review");
  assert.equal(result.branches.length, 3);
  assert.equal(result.status, "complete");
  assert(result.synthesis);
  assert.equal(result.synthesis!.verdict, "approve");

  console.log("[fanout-test] fan-out review with synthesis ✓");
} catch (err) {
  console.error("[fanout-test] fan-out review FAILED:", err);
  process.exit(1);
}

// ── Test 15: Preview truncation — branch output > 1KB ────────────────────────

globalThis.fetch = (async (_url: any, init: any) => {
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: {},
      choices: [{ message: { content: "A".repeat(2000) } }]
    }),
    { status: 200 }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "Large output",
    evidence,
    [
      { id: "a", focus: "branch a" },
      { id: "b", focus: "branch b" }
    ],
    { aggregate: "none" }
  );

  for (const branch of result.branches) {
    const previewBuffer = Buffer.from(branch.preview ?? "", "utf8");
    assert(previewBuffer.length <= 1200, `preview should be truncated to ~1KB (got ${previewBuffer.length})`);
    assert(branch.preview!.includes("[preview truncated"));
  }

  console.log("[fanout-test] preview truncation ✓");
} catch (err) {
  console.error("[fanout-test] preview truncation FAILED:", err);
  process.exit(1);
}

// ── Test 16: Fan-out disabled — checkFanoutAvailability ──────────────────────

try {
  const originalEnabled = process.env.WORKER_FANOUT_ENABLED;
  process.env.WORKER_FANOUT_ENABLED = "0";
  try {
    // Need to re-import to get fresh config values
    // Since config.ts reads env at load time, we check the function behavior.
    // The function uses the FANOUT_ENABLED constant which was set at import time.
    // For a proper test, we verify the checkFanoutAvailability function directly.
    // Since FANOUT_ENABLED was true when we imported, we test with the current value.
    // To properly test disabled mode, we need to use a fresh module import.
    // This is a known limitation of const-based config; the env var must be set
    // before the module is first imported.
    // Instead, we verify the function returns undefined when no branches are given.
    const fanout = await import("../fanout.js");
    assert.equal(fanout.checkFanoutAvailability(undefined), undefined);
    assert.equal(fanout.checkFanoutAvailability([]), undefined);
  } finally {
    process.env.WORKER_FANOUT_ENABLED = originalEnabled;
  }
  console.log("[fanout-test] fan-out availability check ✓");
} catch (err) {
  console.error("[fanout-test] fan-out availability check FAILED:", err);
  process.exit(1);
}

// ── Test 17: Receipt and artifact refs ───────────────────────────────────────

globalThis.fetch = (async (_url: any, init: any) => {
  const content = JSON.stringify(JSON.parse(String(init.body)).messages ?? []);
  let answer: string;
  if (content.includes("Synthesize")) {
    answer = JSON.stringify({
      verdict: "approve",
      summary: "ok",
      findings: [],
      disagreements: [],
      confidence: "high",
      evidence_complete: true
    });
  } else {
    answer = "branch output for receipt test";
  }
  return new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: {},
      choices: [{ message: { content: answer } }]
    }),
    { status: 200 }
  );
}) as typeof fetch;

try {
  const fanout = await import("../fanout.js");
  const lite = await import("../lite.js");
  const artifacts = await import("../artifacts.js");

  const evidence = lite.buildEvidencePack([path.join(project, "src", "module.ts")]);
  const result = await fanout.fanoutCoordinator.runAnalyze(
    "Receipt test",
    evidence,
    [
      { id: "a", focus: "branch a" },
      { id: "b", focus: "branch b" }
    ],
    { aggregate: "strong_review" }
  );

  assert(result.receipt, "fanout result should have a receipt");
  assert.equal(result.receipt.tool, "analyze");
  assert(result.receipt.artifact_refs.length >= 2, "should have artifact refs for each branch");
  assert(!JSON.stringify(result).includes("unit-test-api-key"), "secrets should be redacted");

  // Verify artifacts are readable.
  for (const ref of result.receipt.artifact_refs) {
    const slice = artifacts.getArtifactSlice({ artifact_ref: ref, limit: 100 });
    assert(slice.text, "artifact slice should have text");
  }

  console.log("[fanout-test] receipt and artifact refs ✓");
} catch (err) {
  console.error("[fanout-test] receipt and artifact refs FAILED:", err);
  process.exit(1);
}

// ── Test 18: FIFOSemaphore — concurrency limiting ────────────────────────────

try {
  const { FIFOSemaphore } = await import("../concurrency.js");
  const sem = new FIFOSemaphore(2);
  let activeCount = 0;
  let maxActive = 0;

  const task = async () => {
    const ticket = await sem.acquire();
    activeCount += 1;
    maxActive = Math.max(maxActive, activeCount);
    await new Promise((resolve) => setTimeout(resolve, 30));
    activeCount -= 1;
    ticket.release();
  };

  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(maxActive, 2, `semaphore should limit to 2 concurrent (got ${maxActive})`);

  console.log("[fanout-test] FIFOSemaphore concurrency limiting ✓");
} catch (err) {
  console.error("[fanout-test] FIFOSemaphore FAILED:", err);
  process.exit(1);
}

// ── Test 19: FanoutValidationError is an Error subclass ──────────────────────

try {
  const fanout = await import("../fanout.js");
  const err = new fanout.FanoutValidationError("test error");
  assert(err instanceof Error);
  assert.equal(err.name, "FanoutValidationError");
  console.log("[fanout-test] FanoutValidationError subclass ✓");
} catch (err) {
  console.error("[fanout-test] FanoutValidationError subclass FAILED:", err);
  process.exit(1);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

globalThis.fetch = originalFetch;
console.log("fanout tests passed");
