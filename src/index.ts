import "./env.js"; // must run before any module reads process.env (e.g. config.ts)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodexWorkerServer } from "./server.js";
import { startToolErrorReviewLoop } from "./tool_error_control.js";

const server = createCodexWorkerServer();
const transport = new StdioServerTransport();

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
