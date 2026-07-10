import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendMetrics } from "../metrics.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-eval-metrics-"));
const file = path.join(dir, "metrics.jsonl");
const previous = {
  metrics: process.env.WORKER_METRICS_FILE,
  suite: process.env.WORKER_EVAL_SUITE_ID,
  task: process.env.WORKER_EVAL_TASK_ID,
  run: process.env.WORKER_EVAL_RUN_ID,
  arm: process.env.WORKER_EVAL_ARM
};

try {
  process.env.WORKER_METRICS_FILE = file;
  process.env.WORKER_EVAL_SUITE_ID = "suite-a";
  process.env.WORKER_EVAL_TASK_ID = "task-a";
  process.env.WORKER_EVAL_RUN_ID = "run-a";
  process.env.WORKER_EVAL_ARM = "worker";
  appendMetrics({ event: "test", prompt_tokens: 3 });

  const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(row.suite_id, "suite-a");
  assert.equal(row.task_id, "task-a");
  assert.equal(row.run_id, "run-a");
  assert.equal(row.arm, "worker");
  assert.equal(row.prompt_tokens, 3);
} finally {
  for (const [key, value] of Object.entries(previous)) {
    const envKey =
      key === "metrics"
        ? "WORKER_METRICS_FILE"
        : `WORKER_EVAL_${key.toUpperCase()}${key === "suite" || key === "task" || key === "run" ? "_ID" : ""}`;
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("metrics eval context tests passed");
