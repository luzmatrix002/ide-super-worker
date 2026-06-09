import "./env.js"; // must run before any module reads process.env (e.g. config.ts)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodexWorkerServer } from "./server.js";

const server = createCodexWorkerServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error(error);
  process.exit(1);
});
