import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-codex-worker-test-root-"));
const project = path.join(root, "project");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-codex-worker-outside-"));
fs.mkdirSync(project);

process.env.SANDBOX_ROOT = root;
process.env.ONEAPI_BASE_URL = "https://gateway.example.test/v1";
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.CLAUDE_CODE_MODEL = "sonnet";

const security = await import("../security.js");
const jobsModule = await import("../jobs.js");
const claude = await import("../claude.js");
const workspace = await import("../workspace.js");
const adapter = await import("../anthropic_openai_adapter.js");
const server = await import("../server.js");

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
const publicDiffJob = server.publicJob(diffJob);
assert.equal(publicDiffJob.diff, "");
assert.equal(publicDiffJob.result.diff, "");

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

const originalFetch = globalThis.fetch;
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
