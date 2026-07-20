import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

// Includes cold Node/module startup on Windows, not only the configured idle window.
const EXIT_TIMEOUT_MS = 5_000;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function spawnWorker(idleExitMs: string): ChildProcess {
  return spawn(process.execPath, [path.resolve("dist/index.js")], {
    env: {
      ...process.env,
      WORKER_IDLE_EXIT_MS: idleExitMs,
      WORKER_TOOL_REVIEW_DISABLED: "1",
      WORKER_QUALITY_TARGETS_FILE: "",
      WORKER_QUALITY_TARGETS_JSON: ""
    },
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true
  });
}

const child = spawnWorker("100");
try {
  const result = await waitForExit(child, EXIT_TIMEOUT_MS);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    child.kill();
  }
}

const disabledChild = spawnWorker("0");
try {
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(disabledChild.exitCode, null, "WORKER_IDLE_EXIT_MS=0 must keep the server available");
  disabledChild.stdin?.end();
  const result = await waitForExit(disabledChild, EXIT_TIMEOUT_MS);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
} finally {
  if (disabledChild.exitCode === null && disabledChild.signalCode === null) disabledChild.kill();
}

console.log("process lifecycle idle exit: OK");
