import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-guard-cli-"));
const statusFile = path.join(temp, "status.json");
const metricsFile = path.join(temp, "metrics.jsonl");
fs.writeFileSync(
  metricsFile,
  Array.from({ length: 20 }, (_, index) => JSON.stringify({
    ts: new Date(Date.now() - index * 1_000).toISOString(),
    event: "tool_call",
    route: index < 10 ? "fallback" : "worker",
    category: "analysis",
    tool: "analyze",
    status: "ok"
  })).join("\n"),
  "utf8"
);
const result = spawnSync(process.execPath, [path.join(root, "scripts", "codex_guard.mjs"), "--watch", "--dry-run"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
  env: {
    ...process.env,
    WORKER_METRICS_FILE: metricsFile,
    WORKER_ROUTING_EVENTS_FILE: path.join(temp, "routing.jsonl"),
    WORKER_GUARD_STATUS_FILE: statusFile
  }
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
assert.equal(status.schema_version, 1);
assert.equal(status.state, "QUIET");
assert.equal(status.canary.ok, true);
assert.equal(status.coverage.scope, "hook_observable");
fs.rmSync(temp, { recursive: true, force: true });

console.log("guard cli tests passed");
