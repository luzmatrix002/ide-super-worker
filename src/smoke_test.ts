import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";

async function main(): Promise<void> {
  const cwd = path.resolve(process.cwd());
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd,
    env: {
      ...process.env,
      SANDBOX_ROOT: cwd,
      ONEAPI_BASE_URL: process.env.ONEAPI_BASE_URL || "https://gateway.example.test/v1",
      ONEAPI_API_KEY: process.env.ONEAPI_API_KEY || "unit-test-api-key"
    }
  });

  const client = new Client({ name: "codex-worker-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = ["analyze", "cancel", "get", "start", "tail", "wait"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${names.join(", ")}`);
  }

  const missing = await client.callTool({ name: "get", arguments: { job_id: "missing-job" } });
  if (!missing.isError) {
    throw new Error("Expected get(missing-job) to return isError");
  }

  await client.close();
  console.log(`smoke passed: ${names.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
