import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SANDBOX_ROOT } from "../config.js";
import { createJobState, jobs, setTerminalStatus } from "../jobs.js";
import { buildReliabilityProfile } from "../reliability.js";
import {
  evaluateJob,
  evaluateOutcomeForJob,
  createCodexWorkerServer,
  parseVerificationPolicy,
  preflightStartRejection,
  publicJob,
  toolFailureJson,
  workerMetricStatusFromPayload,
  type JobEvaluation
} from "../server.js";
import type { SemanticReviewResult } from "../semantic_review.js";
import type { CheckCommand, JobState, StartJobInput } from "../types.js";
import { collectChangedFiles, collectWorkspaceSummary, findOutOfScopeChanges } from "../workspace.js";

const cwd = process.cwd();
const checks: CheckCommand[] = [{ name: "unit", command: "npm test" }];

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-staged-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repo, "docs", "outside.md"), "baseline\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "outcome-test@example.invalid");
    git(repo, "config", "user.name", "Outcome Test");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "baseline");
    await run(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function makeJob(overrides: Partial<StartJobInput> = {}): JobState {
  const launchInput: StartJobInput = {
    prompt: "Implement the requested change.",
    allowed_dirs: [cwd],
    verification_policy: { version: 1, task_kind: "modifying" },
    scoped_patch: { paths: ["src"] },
    checks,
    semantic_gate: "required",
    ...overrides
  };
  const job = createJobState(
    `job-${Math.random()}`,
    "claude",
    [],
    cwd,
    "executor-model",
    [cwd],
    launchInput.scoped_patch
      ? {
          relativePaths: launchInput.scoped_patch.paths,
          absolutePaths: launchInput.scoped_patch.paths.map((item) => path.resolve(cwd, item))
        }
      : undefined,
    launchInput.checks ?? [],
    [],
    {
      originalPrompt: launchInput.prompt,
      additionalDirs: [],
      launchInput,
      reasoningEnabled: false,
      autoReviseEnabled: false,
      maxRevisePasses: 0,
      reliabilityProfile: buildReliabilityProfile(launchInput)
    }
  );
  job.result.result = "Implemented the change.";
  return job;
}

function makeEvaluation(overrides: Partial<JobEvaluation> = {}): JobEvaluation {
  const checkResults = [
    {
      label: "unit",
      command: "npm test",
      status: "passed" as const,
      exit_code: 0,
      duration_ms: 25
    }
  ];
  return {
    finalStatus: "completed",
    checkLines: ["unit: passed"],
    checkResults,
    changedFiles: ["src/example.ts"],
    diff: "diff --git a/src/example.ts b/src/example.ts\n-old\n+new",
    signals: {
      task: "Implement the requested change.",
      exitCode: 0,
      signal: null,
      changedFiles: ["src/example.ts"],
      diffBytes: 60,
      isGitRepo: true,
      scopeViolations: [],
      scopedPaths: ["src"],
      checks: checkResults,
      errorLines: []
    },
    ...overrides
  };
}

function reviewed(verdict: "approve" | "needs_changes" | "risky" = "approve"): SemanticReviewResult {
  return {
    status: "reviewed",
    route: "primary",
    evidence: {
      model: "dedicated-reviewer",
      verdict,
      issues: [],
      duration_ms: 12,
      evidence_complete: true
    }
  };
}

function makeLegacyFixtureJob(id = "compat-job", episode = false): JobState {
  const compatibilityInput: StartJobInput = {
    prompt: "compat",
    allowed_dirs: ["/workspace"],
    include_diff: false,
    episode
  };
  const job = createJobState(id, "claude", [], "/workspace", "compat-model", ["/workspace"], undefined, [], [], {
    originalPrompt: "compat",
    additionalDirs: [],
    launchInput: compatibilityInput,
    reasoningEnabled: false,
    autoReviseEnabled: false,
    maxRevisePasses: 0,
    reliabilityProfile: {
      tier: "standard",
      blocking_policy: "observe",
      semantic_gate: "off",
      required_gates: [],
      satisfied_gates: [],
      missing_gates: [],
      warnings: [],
      blocking_risk: "none"
    }
  });
  job.started_at = "2026-01-01T00:00:00.000Z";
  job.status = "completed";
  job.result = {
    server_version: "2.5.0",
    job_status: "completed",
    changed_files: [],
    checks: [],
    diff: "",
    result: "done",
    revise_passes: 0
  };
  return job;
}

function legacyProjection(value: unknown): any {
  const payload = JSON.parse(JSON.stringify(value));
  delete payload.contract_version;
  delete payload.outcome;
  if (payload.receipt?.artifact_refs) {
    payload.receipt.artifact_refs = payload.receipt.artifact_refs.map(() => "artifact://<normalized>");
  }
  return payload;
}

function parsedToolPayload(response: unknown): Record<string, any> {
  const contentValue = (response as { content?: unknown } | undefined)?.content;
  const content = Array.isArray(contentValue) ? (contentValue as Array<{ text?: unknown }>) : [];
  return JSON.parse(String(content[0]?.text || "{}"));
}

{
  const previousGate = process.env.WORKER_SEMANTIC_GATE;
  try {
    process.env.WORKER_SEMANTIC_GATE = "required";
    const failedJob = makeJob({ semantic_gate: undefined });
    assert.equal(failedJob.outcome.policy.semantic_gate, "required", "running Outcome must use the effective gate");
    setTerminalStatus(failedJob.id, failedJob, "failed", { error: "executor spawn failed" });
    assert.equal(failedJob.outcome.status, "failed");
    assert.equal(failedJob.outcome.policy.task_kind, "modifying");
    assert.equal(failedJob.outcome.policy.semantic_gate, "required");
    assert.deepEqual(failedJob.outcome.reason_codes, ["executor_failed"]);
  } finally {
    if (previousGate === undefined) delete process.env.WORKER_SEMANTIC_GATE;
    else process.env.WORKER_SEMANTIC_GATE = previousGate;
  }
}

{
  const job = makeJob();
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(job, makeEvaluation(), async () => {
    calls += 1;
    return reviewed("approve");
  });
  assert.equal(calls, 1);
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.verification.semantic, "passed");
  assert.equal(outcome.evidence.checks[0].exit_code, 0);
}

{
  const job = makeJob();
  let calls = 0;
  const failedCheck = {
    label: "unit",
    command: "npm test",
    status: "failed" as const,
    exit_code: 1,
    duration_ms: 30
  };
  const outcome = await evaluateOutcomeForJob(
    job,
    makeEvaluation({
      finalStatus: "failed",
      checkLines: ["unit: failed(1)"],
      checkResults: [failedCheck],
      signals: { ...makeEvaluation().signals, checks: [failedCheck] }
    }),
    async () => {
      calls += 1;
      return reviewed();
    }
  );
  assert.equal(calls, 0, "deterministic failure must not invoke the semantic reviewer");
  assert.equal(outcome.status, "failed");
}

{
  const rejected = await evaluateOutcomeForJob(makeJob(), makeEvaluation(), async () => reviewed("needs_changes"));
  assert.equal(rejected.status, "rejected");
  const unavailable = await evaluateOutcomeForJob(makeJob(), makeEvaluation(), async () => ({
    status: "unavailable",
    reason_code: "semantic_review_model_missing",
    retryable: false,
    duration_ms: 0
  }));
  assert.equal(unavailable.status, "needs_evidence");
}

{
  const outcome = await evaluateOutcomeForJob(makeJob(), makeEvaluation(), async () => {
    throw new Error("review transport exploded");
  });
  assert.equal(outcome.status, "needs_evidence");
  assert.equal(outcome.verification.semantic, "unavailable");
}

{
  const warnJob = makeJob({ semantic_gate: "warn" });
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(warnJob, makeEvaluation(), async () => {
    calls += 1;
    return reviewed("needs_changes");
  });
  assert.equal(calls, 1, "warn must make exactly one best-effort reviewer invocation");
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.verification.semantic, "failed");
}

{
  const offJob = makeJob({ semantic_gate: "off" });
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(offJob, makeEvaluation(), async () => {
    calls += 1;
    return reviewed();
  });
  assert.equal(calls, 0, "off must never invoke the reviewer");
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.verification.semantic, "not_required");
}

{
  const legacyJob = makeJob({ verification_policy: undefined, semantic_gate: "off" });
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(legacyJob, makeEvaluation(), async () => {
    calls += 1;
    return reviewed();
  });
  assert.equal(calls, 0);
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("verification_policy_missing"));
}

{
  const readOnlyJob = makeJob({
    verification_policy: { version: 1, task_kind: "read_only" },
    scoped_patch: undefined,
    checks: [],
    semantic_gate: "off"
  });
  readOnlyJob.result.result = "";
  const readOnlyEvaluation = makeEvaluation({
    changedFiles: [],
    diff: "",
    checkLines: [],
    checkResults: [],
    signals: { ...makeEvaluation().signals, changedFiles: [], diffBytes: 0, scopedPaths: [], checks: [] }
  });
  const outcome = await evaluateOutcomeForJob(readOnlyJob, readOnlyEvaluation, async () => reviewed());
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("evidence_incomplete"));
}

{
  const dirtyJob = makeJob();
  dirtyJob.preexistingChangedFiles = ["src/example.ts"];
  dirtyJob.outcomeBaselineChangedFiles = ["src/example.ts"];
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(dirtyJob, makeEvaluation(), async () => {
    calls += 1;
    return reviewed();
  });
  assert.equal(calls, 0);
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("preexisting_changes_unattributed"));
  assert.deepEqual(outcome.evidence.changed_files, []);

  const dirtyReadOnly = makeJob({
    verification_policy: { version: 1, task_kind: "read_only" },
    scoped_patch: undefined,
    checks: [],
    semantic_gate: "off"
  });
  dirtyReadOnly.preexistingChangedFiles = ["src/example.ts"];
  dirtyReadOnly.outcomeBaselineChangedFiles = ["src/example.ts"];
  const readOnlyOutcome = await evaluateOutcomeForJob(dirtyReadOnly, makeEvaluation(), async () => reviewed());
  assert.equal(readOnlyOutcome.status, "needs_evidence");
  assert(!readOnlyOutcome.reason_codes.includes("read_only_modified"));
}

await withTempRepo(async (repo) => {
  fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 2;\n");
  git(repo, "add", "src/in-scope.ts");
  const summary = collectWorkspaceSummary(repo);
  assert.deepEqual(summary.changed_files, ["src/in-scope.ts"]);
  assert.match(summary.diff, /\+export const value = 2;/);

  const readOnlyJob = makeJob({
    verification_policy: { version: 1, task_kind: "read_only" },
    scoped_patch: undefined,
    checks: [],
    semantic_gate: "off"
  });
  readOnlyJob.cwd = repo;
  const base = makeEvaluation();
  const evaluation = makeEvaluation({
    changedFiles: summary.changed_files,
    diff: summary.diff,
    checkLines: summary.checks,
    checkResults: [],
    signals: {
      ...base.signals,
      changedFiles: summary.changed_files,
      diffBytes: Buffer.byteLength(summary.diff, "utf8"),
      scopeViolations: [],
      scopedPaths: [],
      checks: []
    }
  });
  const outcome = await evaluateOutcomeForJob(readOnlyJob, evaluation, async () => reviewed());
  assert.equal(outcome.status, "rejected", "a staged-only write must reject a read-only task");
  assert(outcome.reason_codes.includes("read_only_modified"));

  fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 3;\n");
  const combined = collectWorkspaceSummary(repo);
  assert.deepEqual(combined.changed_files, ["src/in-scope.ts"]);
  assert.equal(combined.diff.match(/^diff --git /gm)?.length, 1, "staged and unstaged edits must produce one final patch");
});

await withTempRepo(async (repo) => {
  fs.writeFileSync(path.join(repo, "docs", "outside.md"), "staged outside scope\n");
  git(repo, "add", "docs/outside.md");
  const scope = {
    relativePaths: ["src"],
    absolutePaths: [path.join(repo, "src")]
  };
  const summary = collectWorkspaceSummary(repo, scope);
  const violations = findOutOfScopeChanges(repo, scope);
  assert.deepEqual(violations, ["docs/outside.md"]);

  const job = makeJob({ semantic_gate: "off" });
  job.cwd = repo;
  const base = makeEvaluation();
  const evaluation = makeEvaluation({
    changedFiles: summary.changed_files,
    diff: summary.diff,
    checkLines: summary.checks,
    signals: {
      ...base.signals,
      changedFiles: summary.changed_files,
      diffBytes: Buffer.byteLength(summary.diff, "utf8"),
      scopeViolations: violations
    }
  });
  const outcome = await evaluateOutcomeForJob(job, evaluation, async () => reviewed());
  assert.equal(outcome.status, "rejected", "a staged-only out-of-scope write must be rejected");
  assert(outcome.reason_codes.includes("scope_violation"));
});

await withTempRepo(async (repo) => {
  fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 2;\n");
  git(repo, "add", "src/in-scope.ts");
  const baseline = collectChangedFiles(repo);
  assert.deepEqual(baseline, ["src/in-scope.ts"]);

  const job = makeJob({ semantic_gate: "off" });
  job.cwd = repo;
  job.preexistingChangedFiles = baseline;
  job.outcomeBaselineChangedFiles = baseline;
  const summary = collectWorkspaceSummary(repo, job.scopedPatch);
  const base = makeEvaluation();
  const evaluation = makeEvaluation({
    changedFiles: summary.changed_files,
    diff: summary.diff,
    checkLines: summary.checks,
    signals: {
      ...base.signals,
      changedFiles: summary.changed_files,
      diffBytes: Buffer.byteLength(summary.diff, "utf8")
    }
  });
  const outcome = await evaluateOutcomeForJob(job, evaluation, async () => reviewed());
  assert.equal(outcome.status, "needs_evidence", "a staged dirty baseline must not be attributed to the worker");
  assert(outcome.reason_codes.includes("preexisting_changes_unattributed"));
  assert.deepEqual(outcome.evidence.changed_files, []);
});

await withTempRepo(async (repo) => {
  fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 2;\n");
  const mutatingCheck: CheckCommand = {
    name: "mutate outside scope",
    command: `node -e "require('fs').writeFileSync('docs/outside.md','changed by check\\n')"`
  };
  const job = makeJob({
    allowed_dirs: [repo],
    checks: [mutatingCheck],
    semantic_gate: "off"
  });
  job.cwd = repo;
  job.allowedDirs = [repo];
  job.scopedPatch = {
    relativePaths: ["src"],
    absolutePaths: [path.join(repo, "src")]
  };
  job.checks = [mutatingCheck];

  const evaluation = await evaluateJob(job, 0, null);
  assert.equal(evaluation.checkResults[0].status, "passed", "the mutating check itself must pass");
  assert.equal(evaluation.finalStatus, "failed", "post-check scope violation must fail legacy lifecycle");
  assert.deepEqual(evaluation.signals.scopeViolations, ["docs/outside.md"]);
  assert(evaluation.checkLines.some((line) => line.includes("scoped_patch violation")));

  const outcome = await evaluateOutcomeForJob(job, evaluation, async () => reviewed());
  assert.equal(outcome.status, "rejected");
  assert(outcome.reason_codes.includes("scope_violation"));
});

await withTempRepo(async (repo) => {
  fs.writeFileSync(path.join(repo, "src", "in-scope.ts"), "export const value = 2;\n");
  const generatingCheck: CheckCommand = {
    name: "generate in scope",
    command: `node -e "require('fs').writeFileSync('src/generated.ts','export const generated = true;\\n')"`
  };
  const job = makeJob({
    allowed_dirs: [repo],
    checks: [generatingCheck],
    semantic_gate: "off"
  });
  job.cwd = repo;
  job.allowedDirs = [repo];
  job.scopedPatch = {
    relativePaths: ["src"],
    absolutePaths: [path.join(repo, "src")]
  };
  job.checks = [generatingCheck];

  const evaluation = await evaluateJob(job, 0, null);
  assert.equal(evaluation.finalStatus, "completed");
  assert.deepEqual(evaluation.changedFiles, ["src/generated.ts", "src/in-scope.ts"]);
  assert.match(evaluation.diff, /generated\.ts/);
  assert.match(evaluation.diff, /export const generated = true/);

  const outcome = await evaluateOutcomeForJob(job, evaluation, async () => reviewed());
  assert.equal(outcome.status, "accepted");
  assert.deepEqual(outcome.evidence.changed_files, ["src/generated.ts", "src/in-scope.ts"]);
});

{
  const stagedJob = makeJob();
  stagedJob.stages = [{ prompt: "stage one" }, { prompt: "stage two" }];
  let calls = 0;
  const outcome = await evaluateOutcomeForJob(stagedJob, makeEvaluation(), async () => {
    calls += 1;
    return reviewed();
  });
  assert.equal(calls, 0);
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("multi_stage_evidence_incomplete"));
}

{
  const nonGitJob = makeJob({
    verification_policy: { version: 1, task_kind: "read_only" },
    scoped_patch: undefined,
    checks: [],
    semantic_gate: "off"
  });
  const base = makeEvaluation();
  const outcome = await evaluateOutcomeForJob(
    nonGitJob,
    makeEvaluation({
      changedFiles: [],
      diff: "",
      checkLines: ["git summary skipped: not a git repository"],
      checkResults: [],
      signals: { ...base.signals, isGitRepo: false, changedFiles: [], diffBytes: 0, checks: [] }
    }),
    async () => reviewed()
  );
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("workspace_evidence_incomplete"));
  assert.equal(outcome.verification.scope, "not_required");
}

{
  const multiRootJob = makeJob({ semantic_gate: "off" });
  multiRootJob.additionalDirs = [path.join(multiRootJob.cwd, "unobserved-additional-root")];
  const outcome = await evaluateOutcomeForJob(multiRootJob, makeEvaluation(), async () => reviewed());
  assert.equal(outcome.status, "needs_evidence");
  assert(outcome.reason_codes.includes("workspace_evidence_incomplete"));
}

{
  const job = makeJob({ semantic_gate: "off" });
  job.status = "completed";
  job.outcome = await evaluateOutcomeForJob(job, makeEvaluation(), async () => reviewed());
  const compact = publicJob(job) as Record<string, any>;
  const verbose = publicJob(job, undefined, true) as Record<string, any>;
  assert.equal(compact.contract_version, "outcome.v1");
  assert.equal(compact.outcome.status, "accepted");
  assert.deepEqual(compact.outcome, verbose.outcome);
  assert.equal(compact.job_status, "completed", "legacy executor lifecycle must remain unchanged");
  assert.equal("outcome" in verbose.result, false);
  assert.equal("contract_version" in verbose.result, false);

  const { contract_version: _contract, outcome: _outcome, ...legacyCompact } = compact;
  assert.deepEqual(Object.keys(legacyCompact).sort(), [
    "changed_files",
    "checks",
    "diff",
    "duration_ms",
    "episode",
    "error",
    "failure_digest",
    "id",
    "job_status",
    "preexisting_changed_files",
    "reasoning",
    "receipt",
    "reliability",
    "revise_passes",
    "server_version",
    "session_id",
    "summary",
    "total_cost_usd"
  ]);
}

{
  const compatibilityJob = makeLegacyFixtureJob();
  const payload = legacyProjection(publicJob(compatibilityJob));
  const fixtureText = fs.readFileSync("src/tests/fixtures/job_payload_2_5.json", "utf8");
  assert.equal(
    createHash("sha256").update(fixtureText).digest("hex"),
    "21c9b9038585b5abf3d32fe765060cd7202b2d11b9a780786359ad757d8c8559",
    "the frozen 2.5 fixture hash changed"
  );
  const fixture = JSON.parse(fixtureText);
  const wirePayload = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(wirePayload, fixture, "removing the Outcome envelope must reproduce the frozen 2.5 payload");

  compatibilityJob.preexistingChangedFiles = ["src/in-scope.ts"];
  compatibilityJob.outcomeBaselineChangedFiles = ["src/in-scope.ts", "docs/user-dirty.md"];
  const scopedProjection = publicJob(compatibilityJob) as Record<string, any>;
  assert.deepEqual(
    scopedProjection.preexisting_changed_files,
    ["src/in-scope.ts"],
    "full Outcome attribution baseline must not leak into the frozen legacy field"
  );
}

assert.deepEqual(parseVerificationPolicy({ version: 1, task_kind: "read_only" }), {
  version: 1,
  task_kind: "read_only"
});
assert.throws(() => parseVerificationPolicy({ version: 2, task_kind: "read_only" }), /version must be 1/);
assert.throws(() => parseVerificationPolicy({ version: 1, task_kind: "write" }), /task_kind/);

const failure = toolFailureJson("get", "job_control", {}, new Error("boom")) as any;
assert.equal(failure.contract_version, "outcome.v1");
assert.equal(failure.outcome.status, "failed");
const rejection = preflightStartRejection({ permission_mode: "bypassPermissions" }) as any;
assert.equal(rejection.contract_version, "outcome.v1");
assert.equal(rejection.outcome.status, "rejected");

const verboseCompatibilityJob = makeLegacyFixtureJob("verbose-job", true);
verboseCompatibilityJob.launchInput.include_diff = true;
verboseCompatibilityJob.pid = 4242;
verboseCompatibilityJob.ended_at = "2026-01-01T00:00:01.000Z";
verboseCompatibilityJob.exit_code = 0;
verboseCompatibilityJob.signal = null;
verboseCompatibilityJob.revisePass = 1;
verboseCompatibilityJob.result = {
  server_version: "2.5.0",
  job_status: "completed",
  changed_files: ["src/example.ts"],
  checks: ["unit: passed"],
  diff: "diff --git a/src/example.ts b/src/example.ts\n-old\n+new",
  result: "implemented",
  revise_passes: 1,
  session_id: "session-legacy",
  duration_ms: 1000,
  total_cost_usd: 0.01
};

const legacyPayloadMatrix: Record<string, any> = {
  verbose_job: legacyProjection(publicJob(verboseCompatibilityJob, true, true)),
  tool_failure: legacyProjection(toolFailureJson("get", "job_control", { job_id: "missing-job" }, new Error("boom")))
};

{
  const previous = {
    isolation: process.env.WORKER_ISOLATION,
    escalate: process.env.WORKER_ESCALATE_MODEL,
    reviewer: process.env.WORKER_SEMANTIC_REVIEW_MODEL
  };
  try {
    process.env.WORKER_ISOLATION = "worktree";
    process.env.WORKER_ESCALATE_MODEL = "strong-model";
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "reviewer-model";
    const input: Partial<StartJobInput> = {
      reliability_tier: "critical",
      blocking_policy: "enforce",
      semantic_gate: "required",
      checks,
      scoped_patch: { paths: ["src"] }
    };
    assert.equal(preflightStartRejection(input as Record<string, unknown>), undefined);
    const finalProfile = buildReliabilityProfile(input, { worktree: true });
    assert(finalProfile.missing_gates.includes("semantic_gate"));
    assert(!finalProfile.satisfied_gates.includes("semantic_gate"));
  } finally {
    if (previous.isolation === undefined) delete process.env.WORKER_ISOLATION;
    else process.env.WORKER_ISOLATION = previous.isolation;
    if (previous.escalate === undefined) delete process.env.WORKER_ESCALATE_MODEL;
    else process.env.WORKER_ESCALATE_MODEL = previous.escalate;
    if (previous.reviewer === undefined) delete process.env.WORKER_SEMANTIC_REVIEW_MODEL;
    else process.env.WORKER_SEMANTIC_REVIEW_MODEL = previous.reviewer;
  }
}

{
  const previousCircuit = process.env.WORKER_TOOL_CIRCUIT_BREAKER;
  const previousBypass = process.env.ALLOW_BYPASS_PERMISSIONS;
  process.env.WORKER_TOOL_CIRCUIT_BREAKER = "0";
  process.env.ALLOW_BYPASS_PERMISSIONS = "0";
  const runningJob = makeJob();
  runningJob.id = "poll-timeout-job";
  const getJob = makeLegacyFixtureJob();
  const terminalJob = makeLegacyFixtureJob("terminal-job");
  jobs.set(runningJob.id, runningJob);
  jobs.set(getJob.id, getJob);
  jobs.set(terminalJob.id, terminalJob);
  const server = createCodexWorkerServer();
  const client = new Client({ name: "outcome-contract-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const expiredGetResponse = await client.callTool({ name: "get", arguments: { job_id: "expired-job-id" } });
    assert.notEqual((expiredGetResponse as { isError?: boolean }).isError, true);
    const expiredGetPayload = parsedToolPayload(expiredGetResponse);
    assert.equal(expiredGetPayload.status, "ok");
    assert.equal(expiredGetPayload.degraded, true);
    assert.equal(expiredGetPayload.degradation_reason, "job_not_found_or_expired");
    assert.equal(workerMetricStatusFromPayload(expiredGetPayload).status, "ok");

    const missingSearchPath = path.join(SANDBOX_ROOT, "__missing-search-path__");
    const allMissingSearchResponse = await client.callTool({
      name: "search",
      arguments: { pattern: "needle", dirs: [missingSearchPath] }
    });
    const allMissingSearchPayload = parsedToolPayload(allMissingSearchResponse);
    assert.equal(allMissingSearchPayload.status, undefined);
    assert.equal(allMissingSearchPayload.degraded, true);
    assert.match(allMissingSearchPayload.degradation_reason, /all search dirs missing or inaccessible/);

    const partialMissingSearchResponse = await client.callTool({
      name: "search",
      arguments: { pattern: "ide-super-worker", dirs: [missingSearchPath, path.join(cwd, "package.json")] }
    });
    const partialMissingSearchPayload = parsedToolPayload(partialMissingSearchResponse);
    assert(partialMissingSearchPayload.results.some((line: string) => line.includes("ide-super-worker")));
    assert.equal(partialMissingSearchPayload.degraded, true);
    assert.match(partialMissingSearchPayload.degradation_reason, /some search dirs missing or inaccessible/);

    const noMatchesSearchResponse = await client.callTool({
      name: "search",
      arguments: { pattern: "__codex_no_match_regression__", dirs: [path.join(cwd, "package.json")] }
    });
    const noMatchesSearchPayload = parsedToolPayload(noMatchesSearchResponse);
    assert.equal(noMatchesSearchPayload.count, 0);
    assert.equal(noMatchesSearchPayload.degraded, true);
    assert.equal(noMatchesSearchPayload.degradation_reason, "no_matches");

    const missingPathStartResponse = await client.callTool({
      name: "start",
      arguments: { prompt: "missing path preflight", allowed_dirs: [missingSearchPath] }
    });
    const missingPathStartPayload = parsedToolPayload(missingPathStartResponse);
    assert.equal(missingPathStartPayload.status, "rejected");
    assert.deepEqual(missingPathStartPayload.outcome.reason_codes, ["missing_path"]);
    assert.equal(missingPathStartPayload.failure_class, "missing_path");

    const missingModelStartResponse = await client.callTool({
      name: "start",
      arguments: { prompt: "missing model preflight", allowed_dirs: [cwd], model: "   " }
    });
    const missingModelStartPayload = parsedToolPayload(missingModelStartResponse);
    assert.equal(missingModelStartPayload.status, "rejected");
    assert.deepEqual(missingModelStartPayload.outcome.reason_codes, ["missing_command"]);
    assert.equal(missingModelStartPayload.failure_class, "missing_command");

    const getResponse = await client.callTool({ name: "get", arguments: { job_id: getJob.id } });
    assert.notEqual((getResponse as { isError?: boolean }).isError, true);
    const getPayload = parsedToolPayload(getResponse);
    assert.deepEqual(
      legacyProjection(getPayload),
      JSON.parse(fs.readFileSync("src/tests/fixtures/job_payload_2_5.json", "utf8")),
      "get over MCP must retain the frozen compact 2.5 projection"
    );

    const startResponse = await client.callTool({
      name: "start",
      arguments: { prompt: "legacy start rejection", permission_mode: "bypassPermissions" }
    });
    assert.notEqual((startResponse as { isError?: boolean }).isError, true);
    legacyPayloadMatrix.start_rejection = legacyProjection(parsedToolPayload(startResponse));

    const response = await client.callTool({
      name: "wait",
      arguments: { job_id: runningJob.id, timeout_ms: 1 }
    });
    assert.notEqual((response as { isError?: boolean }).isError, true);
    const payload = parsedToolPayload(response);
    assert.equal(payload.status, "rejected", "legacy wait timeout projection stays rejected");
    assert.equal(payload.contract_version, "outcome.v1");
    assert.equal(payload.outcome.status, "running", "poll timeout must not become task timed_out");
    assert.deepEqual(payload.outcome.reason_codes, ["poll_timeout"]);
    legacyPayloadMatrix.wait_poll_timeout = legacyProjection(payload);

    const cancelResponse = await client.callTool({ name: "cancel", arguments: { job_id: terminalJob.id } });
    assert.notEqual((cancelResponse as { isError?: boolean }).isError, true);
    legacyPayloadMatrix.cancel_existing_terminal = legacyProjection(parsedToolPayload(cancelResponse));
  } finally {
    jobs.delete(runningJob.id);
    jobs.delete(getJob.id);
    jobs.delete(terminalJob.id);
    await client.close();
    await server.close();
    if (previousCircuit === undefined) delete process.env.WORKER_TOOL_CIRCUIT_BREAKER;
    else process.env.WORKER_TOOL_CIRCUIT_BREAKER = previousCircuit;
    if (previousBypass === undefined) delete process.env.ALLOW_BYPASS_PERMISSIONS;
    else process.env.ALLOW_BYPASS_PERMISSIONS = previousBypass;
  }
}

{
  const fixtureText = fs.readFileSync("src/tests/fixtures/legacy_payload_matrix_2_5.json", "utf8");
  assert.equal(
    createHash("sha256").update(fixtureText).digest("hex"),
    "2c55bc1602ca4b3d2c0f5f2f85afd2443d36e6e4480975021a47842e97421737",
    "the frozen 2.5 legacy payload matrix hash changed"
  );
  assert.deepEqual(
    legacyPayloadMatrix,
    JSON.parse(fixtureText),
    "removing the Outcome envelope must reproduce every frozen 2.5 legacy projection"
  );
}

console.log("outcome integration tests passed");
