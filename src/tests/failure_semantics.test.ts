import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "failure-semantics-test-"));
const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });

process.env.SANDBOX_ROOT = root;
process.env.WORKER_LITE_CACHE_DIR = "";
process.env.WORKER_METRICS_FILE = "";
process.env.ONEAPI_BASE_URL = "https://gateway.example.test/v1";
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.WORKER_LITE_MODEL = "lite-test-model";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      model: "lite-test-model",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ message: { content: "compact failure digest" } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as typeof fetch;

const failureSemantics = await import("../failure_semantics.js");
const workerTools = await import("../worker_tools.js");
const server = await import("../server.js");
const toolErrorControl = await import("../tool_error_control.js");

assert.equal(
  failureSemantics.assessShellFailure(
    "npm test",
    "failed",
    "> npm run build\n> tsc\nAssertionError [ERR_ASSERTION]: expected true"
  ),
  "test_failure",
  "assertion evidence must outrank incidental tsc output"
);
assert.equal(
  failureSemantics.assessShellFailure("npm run build", "failed", "error TS2322: Type 'x' is invalid"),
  "typecheck_failure"
);
assert.equal(
  failureSemantics.assessShellFailure("missing-tool", "failed", "'missing-tool' is not recognized as a command"),
  "missing_command"
);
assert.equal(failureSemantics.assessShellFailure("tool", "timeout", ""), "timeout");
assert.equal(failureSemantics.assessShellFailure("tool", "failed", "EACCES permission denied"), "permission_denied");
assert.equal(failureSemantics.assessShellFailure("tool", "failed", "unexpected process crash"), "unknown_failure");

const testProjection = failureSemantics.buildShellFailureProjection("test_failure");
assert.equal(testProjection.failure_kind, testProjection.failure.kind);
assert.equal(testProjection.required_action, testProjection.failure.action);
assert.equal(testProjection.fallback.action, testProjection.failure.action);
assert.equal(failureSemantics.shellToolDisposition("failed", "test_failure"), "ok");
assert.equal(failureSemantics.shellToolDisposition("failed", "typecheck_failure"), "ok");
assert.equal(failureSemantics.shellToolDisposition("timeout", "timeout"), "error");
assert.equal(failureSemantics.shellToolDisposition("failed", "missing_command"), "error");

const testResult = (await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "console.error('error TS2322: TypeScript'); console.error('AssertionError: failing test'); process.exit(1)"`,
  digest: true,
  timeout_ms: 30_000
})) as any;
assert.equal(testResult.status, "failed");
assert.equal(testResult.failure.kind, "test_failure");
assert.equal(testResult.failure_kind, testResult.failure.kind);
assert.equal(testResult.required_action, testResult.failure.action);
assert.equal(testResult.fallback.action, testResult.failure.action);
assert.equal(testResult.receipt.status, "ok");
const testMetric = server.workerMetricStatusFromPayload(testResult);
assert.equal(testMetric.status, "ok");
assert.equal(testMetric.extra.command_status, "failed");
assert.equal(testMetric.extra.failure_kind, "test_failure");

const typecheckResult = (await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "console.error('error TS2322: TypeScript failure'); process.exit(1)"`,
  digest: true,
  timeout_ms: 30_000
})) as any;
assert.equal(typecheckResult.failure.kind, "typecheck_failure");
assert.equal(typecheckResult.receipt.status, "ok");
assert.equal(server.workerMetricStatusFromPayload(typecheckResult).status, "ok");

const missingResult = (await workerTools.runWorkerShell({
  cwd: project,
  command: "__ide_super_worker_missing_command__",
  digest: true,
  timeout_ms: 30_000
})) as any;
assert.equal(missingResult.failure.kind, "missing_command");
assert.equal(missingResult.receipt.status, "error");
assert.equal(server.workerMetricStatusFromPayload(missingResult).status, "error");

const timeoutResult = (await workerTools.runWorkerShell({
  cwd: project,
  command: `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`,
  digest: true,
  timeout_ms: 1_000
})) as any;
assert.equal(timeoutResult.status, "timeout");
assert.equal(timeoutResult.failure.kind, "timeout");
assert.equal(timeoutResult.receipt.status, "error");
assert.equal(server.workerMetricStatusFromPayload(timeoutResult).status, "error");

const rejectedMetric = server.workerMetricStatusFromPayload({
  status: "rejected",
  receipt: {
    route: "worker",
    tool: "search",
    category: "search",
    input_bytes: 1,
    output_bytes: 1,
    summary_bytes: 1,
    artifact_refs: [],
    truncated: false,
    cached: false,
    status: "error"
  }
});
assert.equal(rejectedMetric.status, "rejected");

assert.equal(
  toolErrorControl.detectToolErrorClass("review", "review", { error_message: "upstream returned 404" }),
  "upstream_404"
);
assert.equal(
  toolErrorControl.detectToolErrorClass("review", "review", { error_message: "upstream returned 503" }),
  "upstream_error"
);
assert.equal(
  toolErrorControl.detectToolErrorClass("shell", "command_digest", { failure_kind: "permission_denied" }),
  "permission_denied"
);
assert.equal(
  toolErrorControl.detectToolErrorClass("shell", "command_digest", { error_message: "unclassified crash" }),
  "unknown_failure"
);

toolErrorControl.resetToolControlState();
toolErrorControl.recordToolControlOutcome("shell", "command_digest", "ok", {
  command_status: "failed",
  failure_kind: "test_failure"
});
assert.equal(toolErrorControl.getToolControlDecision("shell", "command_digest"), undefined);
toolErrorControl.resetToolControlState();

globalThis.fetch = originalFetch;
console.log("failure semantics tests passed");
