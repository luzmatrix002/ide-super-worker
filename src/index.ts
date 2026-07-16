import "./env.js"; // must run before any module reads process.env (e.g. config.ts)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runningJobCount } from "./jobs.js";
import { createCodexWorkerServer, shutdownRunningJobs } from "./server.js";
import { startToolErrorReviewLoop, stopToolErrorReviewLoop } from "./tool_error_control.js";
import { warmQualityTargetProbes } from "./quality_mode.js";

const DEFAULT_IDLE_EXIT_MS = 5 * 60 * 1000;
const server = createCodexWorkerServer();
const transport = new StdioServerTransport();
const configuredIdleExitMs = Number(process.env.WORKER_IDLE_EXIT_MS ?? DEFAULT_IDLE_EXIT_MS);
const idleExitMs = Number.isInteger(configuredIdleExitMs) && configuredIdleExitMs >= 0
  ? configuredIdleExitMs
  : DEFAULT_IDLE_EXIT_MS;
let idleTimer: NodeJS.Timeout | undefined;
let terminationPromise: Promise<void> | undefined;

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

function terminate(exitCode = 0): Promise<void> {
  terminationPromise ??= (async () => {
    clearIdleTimer();
    process.stdin.off("data", scheduleIdleExit);
    stopToolErrorReviewLoop();
    await shutdownRunningJobs();
    try {
      await server.close();
    } catch {
      // The transport may already be closed by the client.
    }
    process.exit(exitCode);
  })();
  return terminationPromise;
}

function scheduleIdleExit(): void {
  clearIdleTimer();
  if (idleExitMs === 0 || terminationPromise) return;
  idleTimer = setTimeout(() => {
    if (runningJobCount() > 0) {
      scheduleIdleExit();
      return;
    }
    void terminate();
  }, idleExitMs);
  idleTimer.unref?.();
}

process.stdin.on("data", scheduleIdleExit);
transport.onclose = () => void terminate();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void terminate();
  });
}

server
  .connect(transport)
  .then(() => {
    scheduleIdleExit();
    void warmQualityTargetProbes().then((probe) => {
      if (probe.configured && !probe.ready) {
        console.error("[warn][quality] configured targets did not pass the startup thinking capability probe; quality_mode=high will fail closed.");
      }
    }).catch((error) => {
      console.error(`[warn][quality] startup target probe failed closed: ${error instanceof Error ? error.message : String(error)}`);
    });
    try {
      startToolErrorReviewLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
      console.error(`[warn][tool-error-control] review loop not started: ${message}${stack}`);
    }
  })
  .catch((error) => {
    console.error(error);
    void terminate(1);
  });
