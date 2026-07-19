import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendRoutingObservation,
  describeHookOperation,
  operationId,
  routingCoverage,
  routingObservationFromHook,
  type RoutingObservationV1
} from "../routing_observation.js";

const worker = routingObservationFromHook({
  hook_event_name: "PostToolUse",
  session_id: "session-secret",
  turn_id: "turn-secret",
  tool_use_id: "tool-secret",
  tool_name: "mcp__codex_async_worker__shell",
  tool_input: { command: "npm test -- --token super-secret", cwd: "D:/private" },
  tool_response: { status: "passed", output: "private output" }
});
assert.equal(worker.eligibility, "eligible");
assert.equal(worker.selected_route, "worker");
assert.equal(worker.worker_acceptance, "accepted");
assert.equal(worker.category, "command_digest");
assert.ok(!JSON.stringify(worker).includes("super-secret"));
assert.ok(!JSON.stringify(worker).includes("private output"));
assert.ok(!operationId({ session_id: "s", turn_id: "t", tool_use_id: "u" }, "key").includes("s"));

const main = routingObservationFromHook({
  hook_event_name: "PostToolUse",
  tool_name: "exec_command",
  tool_use_id: "main-1",
  tool_input: { cmd: "npm run build" },
  tool_response: { exit_code: 0 }
});
assert.equal(main.eligibility, "eligible");
assert.equal(main.selected_route, "main");

assert.equal(describeHookOperation({ tool_name: "apply_patch" }).eligibility, "unknown");
assert.equal(describeHookOperation({ tool_name: "weather" }).eligibility, "ineligible");

const rejected: RoutingObservationV1 = { ...worker, operation_id: "op-2", worker_acceptance: "rejected" };
const unknown: RoutingObservationV1 = { ...worker, operation_id: "op-3", worker_acceptance: undefined };
const coverage = routingCoverage([worker, main, rejected, unknown]);
assert.equal(coverage.scope, "hook_observable");
assert.equal(coverage.eligible_total, 4);
assert.equal(coverage.worker_selected, 3);
assert.equal(coverage.worker_accepted, 1);
assert.equal(coverage.worker_rejected, 1);
assert.equal(coverage.main_direct, 1);
assert.equal(coverage.unknown, 1);
assert.equal(coverage.effective_worker_coverage, 0.25);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-observation-"));
const file = path.join(dir, "routing.jsonl");
assert.equal(appendRoutingObservation(worker, { WORKER_ROUTING_EVENTS_FILE: file }), true);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").trim()), worker);
fs.rmSync(dir, { recursive: true, force: true });

console.log("routing observation tests passed");
