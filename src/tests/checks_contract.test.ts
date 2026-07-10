import assert from "node:assert/strict";
import { runCheckCommands } from "../checks.js";

const passed = await runCheckCommands(process.cwd(), [
  { name: "evidence-check", command: `"${process.execPath}" -e "process.exit(0)"` }
]);

assert.equal(passed.failed, false);
assert.equal(passed.results.length, 1);
assert.deepEqual(
  {
    label: passed.results[0].label,
    command: passed.results[0].command,
    status: passed.results[0].status,
    exit_code: passed.results[0].exit_code
  },
  {
    label: "evidence-check",
    command: `"${process.execPath}" -e "process.exit(0)"`,
    status: "passed",
    exit_code: 0
  }
);
assert(passed.results[0].duration_ms >= 0);

const failed = await runCheckCommands(process.cwd(), [
  { name: "failed-evidence-check", command: `"${process.execPath}" -e "process.exit(7)"` }
]);

assert.equal(failed.failed, true);
assert.equal(failed.results[0].status, "failed");
assert.equal(failed.results[0].exit_code, 7);

console.log("check evidence contract tests passed");
