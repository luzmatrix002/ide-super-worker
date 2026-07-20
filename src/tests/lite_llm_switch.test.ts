import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The server analyze/review branches are thin composition layers over the same
// deterministic evidence helpers. In-memory MCP coverage keeps those branches
// honest, including review of a completed job whose worktree no longer exists.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lite-llm-switch-test-"));
const metricsFile = path.join(root, "metrics.jsonl");

process.env.SANDBOX_ROOT = root;
process.env.ONEAPI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.WORKER_LITE_LLM = "0";
process.env.WORKER_LITE_CACHE_DIR = "";
process.env.WORKER_METRICS_FILE = metricsFile;
process.env.WORKER_FAILURE_DIGEST = "1";
process.env.CLAUDE_CODE_COMMAND = process.execPath;
process.env.WORKER_ISOLATION = "inplace";
process.env.WORKER_METRICS_SHARD_BY_PID = "0";
process.env.WORKER_TOOL_CIRCUIT_BREAKER = "1";
process.env.WORKER_TOOL_CIRCUIT_DISABLED = "0";
process.env.WORKER_TOOL_CIRCUIT_MIN_CALLS = "2";
process.env.WORKER_TOOL_CIRCUIT_MIN_ERRORS = "2";
process.env.WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS = "2";
process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES = "upstream_404,shell_mismatch";
process.env.WORKER_TOOL_CIRCUIT_EARLY_CLOSE_MS = "120000";
process.env.WORKER_TOOL_CIRCUIT_STATE_FILE = path.join(root, "circuit-state.json");

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("unexpected gateway request while WORKER_LITE_LLM=0");
}) as typeof fetch;

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function payloadFrom(response: any): any {
  const item = (response.content as Array<{ type: string; text?: string }> | undefined)?.find((candidate) => candidate.type === "text");
  assert(item?.text, "tool response must contain JSON text");
  return JSON.parse(item.text);
}

try {
  const workerTools = await import("../worker_tools.js");
  const artifacts = await import("../artifacts.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createCodexWorkerServer } = await import("../server.js");
  const { createJobState, jobs } = await import("../jobs.js");
  const toolErrorControl = await import("../tool_error_control.js");

  const shellStartedAt = Date.now();
  const shellResult = (await workerTools.runWorkerShell({
    cwd: root,
    command: `"${process.execPath}" -e "console.error('error: boom'); process.exit(1)"`,
    digest: true,
    timeout_ms: 10_000
  })) as any;
  assert.equal(shellResult.status, "failed");
  assert.match(String(shellResult.digest), /boom/i);
  assert(Date.now() - shellStartedAt < 10_000, "disabled shell digest must not wait on the gateway");

  const gitProject = path.join(root, "git-project");
  const sourceDir = path.join(gitProject, "src");
  const sourceFile = path.join(sourceDir, "a.txt");
  fs.mkdirSync(sourceDir, { recursive: true });
  runGit(gitProject, ["init"]);
  runGit(gitProject, ["config", "user.email", "test@example.invalid"]);
  runGit(gitProject, ["config", "user.name", "Test"]);
  fs.writeFileSync(sourceFile, "old\n", "utf8");
  runGit(gitProject, ["add", "."]);
  runGit(gitProject, ["commit", "-m", "init"]);
  fs.writeFileSync(sourceFile, "new\n", "utf8");

  const diffDigest = (await workerTools.digestDiff({ cwd: gitProject, red_team: true })) as any;
  assert.equal(diffDigest.red_team?.verdict, "disabled");

  const draft = (await workerTools.draftFromChanges({ cwd: gitProject })) as any;
  assert.equal(draft.status, "rejected");
  assert.equal(typeof draft.required_action, "string");

  const removedWorktree = path.join(root, "removed-worktree");
  const job = createJobState("lite-review-job", "claude", [], removedWorktree, "test-model");
  job.status = "completed";
  job.result.job_status = "completed";
  job.result.changed_files = ["src/a.txt"];
  job.result.checks = ["build: passed"];
  job.result.diff = [
    "diff --git a/src/a.txt b/src/a.txt",
    "index 3367afd..3e75765 100644",
    "--- a/src/a.txt",
    "+++ b/src/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "...[diff truncated at 80 bytes]",
    ""
  ].join("\n");
  jobs.set(job.id, job);

  const server = createCodexWorkerServer();
  const client = new Client({ name: "lite-llm-switch-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    assert.match(listed.tools.find((tool) => tool.name === "analyze")?.description || "", /WORKER_LITE_LLM=0/);
    assert.match(listed.tools.find((tool) => tool.name === "review")?.description || "", /WORKER_LITE_LLM=0/);
    assert.match(listed.tools.find((tool) => tool.name === "draft")?.description || "", /WORKER_LITE_LLM=0/);

    const analyze = payloadFrom(
      await client.callTool({ name: "analyze", arguments: { prompt: "Read the changed source", files: [sourceFile] } })
    );
    assert.equal(analyze.status, "ok");
    assert.equal(analyze.llm, "disabled");
    assert.equal(analyze.evidence_only, true);
    assert.equal(analyze.fallback_used, "read_pack");
    assert.equal(typeof analyze.context_pack?.receipt, "object");

    const fileReview = payloadFrom(await client.callTool({ name: "review", arguments: { files: [sourceFile] } }));
    assert.equal(fileReview.status, "ok");
    assert.equal(fileReview.llm, "disabled");
    assert.equal(fileReview.fallback_used, "local_diff_summary");
    assert(Array.isArray(fileReview.hunk_headers));

    const jobReview = payloadFrom(await client.callTool({ name: "review", arguments: { job_id: job.id } }));
    assert.equal(jobReview.status, "ok");
    assert.equal(jobReview.fallback_used, "diff_digest");
    assert.deepEqual(jobReview.changed_files, ["src/a.txt"]);
    assert.deepEqual(jobReview.checks, ["build: passed"]);
    assert.deepEqual(jobReview.diff_digest?.changed_files, ["src/a.txt"]);
    assert.equal(jobReview.diff_digest?.truncated, true);
    assert.equal(jobReview.receipt.truncated, true);
    assert(jobReview.receipt.artifact_refs.length > 0, "stored job diff must remain available as an artifact");
    const diffSlice = artifacts.getArtifactSlice({ artifact_ref: jobReview.receipt.artifact_refs[0], limit: 2_000 }) as any;
    assert.match(String(diffSlice.text), /\+new/);

    toolErrorControl.resetToolControlState();
    toolErrorControl.recordToolControlOutcome("review", "review", "error", { error_message: "upstream returned 404 (first)" });
    toolErrorControl.recordToolControlOutcome("review", "review", "error", { error_message: "upstream returned 404 (second)" });
    assert.equal(toolErrorControl.getToolControlDecision("review", "review")?.action, "degrade");
    const degradedJobReview = payloadFrom(await client.callTool({ name: "review", arguments: { job_id: job.id } }));
    assert.equal(degradedJobReview.status, "degraded");
    assert.equal(degradedJobReview.fallback_used, "diff_digest");
    assert.deepEqual(degradedJobReview.diff_digest?.changed_files, ["src/a.txt"]);
    assert.equal(degradedJobReview.diff_digest?.truncated, true);
    assert.equal(degradedJobReview.receipt.truncated, true);
    assert(degradedJobReview.receipt.artifact_refs.length > 0, "degraded review must preserve the stored job diff artifact");
    toolErrorControl.resetToolControlState();

    const failedStart = payloadFrom(
      await client.callTool({
        name: "start",
        arguments: {
          prompt: "expected synthetic failure",
          allowed_dirs: [gitProject],
          reasoning: false,
          auto_revise: false,
          bare: true,
          include_diff: false,
          verification_policy: { version: 1, task_kind: "modifying" }
        }
      })
    );
    assert.equal(typeof failedStart.job_id, "string", JSON.stringify(failedStart));
    assert.equal(failedStart.status, "running");
    const failedJob = payloadFrom(
      await client.callTool({ name: "wait", arguments: { job_id: failedStart.job_id, timeout_ms: 30_000 } })
    );
    assert.equal(failedJob.job_status, "failed");
    assert.equal(failedJob.failure_digest, undefined, "WORKER_FAILURE_DIGEST=1 must still skip job digests when lite LLM is disabled");
    jobs.delete(failedStart.job_id);
  } finally {
    jobs.delete(job.id);
    await client.close();
    await server.close();
  }

  assert.equal(fetchCalls, 0, "disabled standard lanes must make no gateway requests");

  const metricRows = fs
    .readFileSync(metricsFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const evidenceCalls = metricRows.filter((row) => row.event === "tool_call" && ["analyze", "review"].includes(row.tool));
  assert(evidenceCalls.length >= 3);
  assert(evidenceCalls.every((row) => row.lite_llm === "disabled"));
  assert.equal(metricRows.some((row) => row.route !== "worker" && (row.prompt_tokens > 0 || row.completion_tokens > 0)), false);

  const gateMetrics = path.join(root, "stats-gate.jsonl");
  fs.writeFileSync(
    gateMetrics,
    JSON.stringify({ event: "tool_call", route: "worker", tool: "diff_digest", category: "diff_digest", status: "ok", red_team: false }),
    "utf8"
  );
  const gateEnv = { ...process.env, WORKER_RATIO_REQUIRED_CATEGORIES: "diff_digest" };
  const disabledGate = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", gateMetrics], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...gateEnv, WORKER_LITE_LLM: "0" }
  });
  assert.equal(disabledGate.status, 0, disabledGate.stderr || disabledGate.stdout);
  assert.match(disabledGate.stdout, /lite_llm_disabled\ttrue/);
  assert.match(disabledGate.stdout, /diff_digest_red_team_ratio\t0\.0%/);

  const enabledGate = spawnSync(process.execPath, ["scripts/stats.mjs", "--gate", gateMetrics], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...gateEnv, WORKER_LITE_LLM: "1" }
  });
  assert.equal(enabledGate.status, 2, enabledGate.stderr || enabledGate.stdout);
  assert.match(enabledGate.stderr, /diff_digest red-team ratio 0\.0% below target/);

  console.log("lite LLM switch tests passed");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
