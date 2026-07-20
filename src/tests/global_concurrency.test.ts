import * as assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CrossProcessSemaphore, GlobalConcurrencyBusyError } from "../global_concurrency.js";

const self = fileURLToPath(import.meta.url);
const EVENT_TIMEOUT_MS = 10_000;

if (process.argv[2] === "child") {
  const [, , , root, label, holdRaw, queueRaw] = process.argv;
  const semaphore = new CrossProcessSemaphore({
    root,
    lane: "test",
    maxActive: 1,
    maxQueue: Number(queueRaw),
    acquireTimeoutMs: 5_000,
    pollMs: 10
  });
  semaphore
    .acquire()
    .then(async (ticket) => {
      process.stdout.write(`${JSON.stringify({ event: "enter", label, time: Date.now() })}\n`);
      await new Promise((resolve) => setTimeout(resolve, Number(holdRaw)));
      ticket.release();
      process.stdout.write(`${JSON.stringify({ event: "exit", label, time: Date.now() })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.name || "Error"}:${error?.message || String(error)}\n`);
      process.exitCode = error instanceof GlobalConcurrencyBusyError ? 2 : 1;
    });
} else {
  interface EventRecord {
    event: "enter" | "exit";
    label: string;
    time: number;
  }

  function startChild(root: string, label: string, holdMs: number, queueMax: number) {
    const child = spawn(process.execPath, [self, "child", root, label, String(holdMs), String(queueMax)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const events: EventRecord[] = [];
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    return { child, events, stderr: () => stderr };
  }

  function waitForExit(child: ChildProcess): Promise<number | null> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
  }

  async function waitForEnter(run: ReturnType<typeof startChild>): Promise<void> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (!run.events.some((event) => event.event === "enter")) {
      if (run.child.exitCode !== null) throw new Error(`child exited before enter: ${run.stderr()}`);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for child enter: ${run.stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForQueued(root: string, count: number): Promise<void> {
    const queueDir = path.join(root, "test", "queue");
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (true) {
      const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((name) => name.endsWith(".json")).length : 0;
      if (queued >= count) return;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} queued ticket(s)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "global-concurrency-test-"));
  try {
    const first = startChild(root, "first", 180, 8);
    await waitForEnter(first);
    const second = startChild(root, "second", 80, 8);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const third = startChild(root, "third", 20, 8);
    assert.equal(await waitForExit(first.child), 0, first.stderr());
    assert.equal(await waitForExit(second.child), 0, second.stderr());
    assert.equal(await waitForExit(third.child), 0, third.stderr());
    const ordered = [...first.events, ...second.events, ...third.events]
      .filter((event) => event.event === "enter")
      .sort((a, b) => a.time - b.time)
      .map((event) => event.label);
    assert.deepEqual(ordered, ["first", "second", "third"]);
    assert.ok(second.events[0].time >= first.events.find((event) => event.event === "exit")!.time);
    assert.ok(third.events[0].time >= second.events.find((event) => event.event === "exit")!.time);

    const overflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "global-concurrency-overflow-"));
    // Keep the lease longer than a cold Windows child startup so the queued
    // ticket is present before asserting that the queue is full.
    const active = startChild(overflowRoot, "active", 5_000, 1);
    await waitForEnter(active);
    const queued = startChild(overflowRoot, "queued", 20, 1);
    await waitForQueued(overflowRoot, 1);
    const overflowSemaphore = new CrossProcessSemaphore({
      root: overflowRoot,
      lane: "test",
      maxActive: 1,
      maxQueue: 1,
      acquireTimeoutMs: 1_000,
      pollMs: 10
    });
    await assert.rejects(overflowSemaphore.acquire(), /queue is full/);
    assert.equal(await waitForExit(active.child), 0, active.stderr());
    assert.equal(await waitForExit(queued.child), 0, queued.stderr());

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "global-concurrency-stale-"));
    const activeDir = path.join(staleRoot, "test", "active");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, "dead.json"),
      JSON.stringify({ pid: 2_147_483_647, created_at: Date.now(), id: "dead" })
    );
    const staleSemaphore = new CrossProcessSemaphore({
      root: staleRoot,
      lane: "test",
      maxActive: 1,
      maxQueue: 1,
      acquireTimeoutMs: 1_000,
      pollMs: 10
    });
    const reclaimed = await staleSemaphore.acquire();
    reclaimed.release();
    assert.ok(!fs.existsSync(path.join(activeDir, "dead.json")));

    const cancelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "global-concurrency-cancel-"));
    const cancelSemaphore = new CrossProcessSemaphore({
      root: cancelRoot,
      lane: "test",
      maxActive: 1,
      maxQueue: 1,
      acquireTimeoutMs: 1_000,
      pollMs: 10
    });
    const holder = await cancelSemaphore.acquire();
    const controller = new AbortController();
    const waiting = cancelSemaphore.acquire(controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(waiting, /acquire cancelled/);
    assert.equal(fs.readdirSync(path.join(cancelRoot, "test", "queue")).filter((name) => name.endsWith(".json")).length, 0);
    holder.release();

    console.log("global concurrency tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
