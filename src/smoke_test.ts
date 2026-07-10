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
  const expected = [
    "analyze",
    "apply_edits",
    "cancel",
    "diff_digest",
    "draft",
    "get",
    "get_artifact_slice",
    "history",
    "read_pack",
    "review",
    "search",
    "shell",
    "start",
    "tail",
    "wait"
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${names.join(", ")}`);
  }
  const startSchema = tools.tools.find((tool) => tool.name === "start")?.inputSchema as any;
  if (
    startSchema?.properties?.verification_policy?.properties?.task_kind?.enum?.join(",") !==
      "read_only,modifying" ||
    !String(startSchema?.properties?.semantic_gate?.description || "").includes("independent semantic reviewer")
  ) {
    throw new Error("Expected start schema to expose verification_policy and the real semantic reviewer contract");
  }

  const missing = await client.callTool({ name: "get", arguments: { job_id: "missing-job" } });
  if (missing.isError) {
    throw new Error("Expected get(missing-job) to return a structured error payload, not MCP isError");
  }
  const missingContent = Array.isArray(missing.content) ? (missing.content as Array<{ text?: unknown }>) : [];
  const missingPayload = JSON.parse(String(missingContent[0]?.text || "{}"));
  if (
    missingPayload.contract_version !== "outcome.v1" ||
    missingPayload.outcome?.status !== "rejected" ||
    missingPayload.status !== "rejected" ||
    !missingPayload.fallback?.action ||
    missingPayload.receipt?.status !== "ok"
  ) {
    throw new Error("Expected get(missing-job) to include Outcome v1 plus the frozen legacy rejection payload");
  }

  const badSearch = await client.callTool({ name: "search", arguments: { pattern: "never-matches", dirs: [path.join(cwd, "__missing__")] } });
  if (badSearch.isError) {
    throw new Error("Expected search(bad-dir) to return a structured rejection payload, not MCP isError");
  }
  const badSearchContent = Array.isArray(badSearch.content) ? (badSearch.content as Array<{ text?: unknown }>) : [];
  const badSearchPayload = JSON.parse(String(badSearchContent[0]?.text || "{}"));
  if (
    badSearchPayload.contract_version !== "outcome.v1" ||
    badSearchPayload.outcome?.status !== "rejected" ||
    badSearchPayload.status !== "rejected" ||
    !badSearchPayload.fallback?.action ||
    badSearchPayload.receipt?.status !== "ok"
  ) {
    throw new Error("Expected search(bad-dir) to include Outcome v1 plus the frozen legacy rejection payload");
  }

  await client.close();
  console.log(`smoke passed: ${names.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
