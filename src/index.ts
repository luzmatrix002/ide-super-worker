import "./env.js"; // must run before any module reads process.env (e.g. config.ts)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodexWorkerServer, shutdownRunningJobs } from "./server.js";
import { startToolErrorReviewLoop } from "./tool_error_control.js";

const server = createCodexWorkerServer();
const transport = new StdioServerTransport();
let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= shutdownRunningJobs();
  return shutdownPromise;
}

transport.onclose = () => {
  void shutdown();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

server
  .connect(transport)
  .then(() => {
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
    process.exit(1);
  });
