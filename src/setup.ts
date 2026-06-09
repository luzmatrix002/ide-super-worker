import "./env.js"; // load .env so setup reflects local config
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function slashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

const projectRoot = path.resolve(process.cwd());
const distIndex = path.join(projectRoot, "dist", "index.js");
const exampleSandbox = slashPath(process.env.SANDBOX_ROOT || "D:/your/workspaces");
const model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "Qwen3.6-35B-A3B-APEX-I-Compact.gguf";
const claudeCodeModel = process.env.CLAUDE_CODE_MODEL || process.env.CLAUDE_CLI_MODEL || "sonnet";
const useCurrentEnv = process.argv.includes("--use-current-env");
const baseUrl = useCurrentEnv
  ? process.env.ONEAPI_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://your-gateway.example.com/v1"
  : "https://your-gateway.example.com/v1";

const toml = `[mcp_servers.codex_async_worker]
command = "node"
args = ["${slashPath(distIndex)}"]
cwd = "${slashPath(projectRoot)}"
startup_timeout_sec = 10
tool_timeout_sec = 3600
env = { SANDBOX_ROOT = "${exampleSandbox}", ONEAPI_BASE_URL = "${baseUrl}", CLAUDE_MODEL = "${model}", CLAUDE_CODE_MODEL = "${claudeCodeModel}", CLAUDE_PERMISSION_MODE = "acceptEdits", USE_OPENAI_ADAPTER = "1", ADAPTER_ENABLE_THINKING = "0", WAIT_DEFAULT_MS = "1800000" }
env_vars = ["ONEAPI_API_KEY"]
`;

const target = path.join(projectRoot, "codex-mcp.example.toml");
fs.writeFileSync(target, toml, "utf8");

console.log("[setup] Wrote Codex MCP example config:");
console.log(`  ${target}`);
console.log("");
console.log(toml);
console.log("Next steps:");
console.log("  1. Copy the block into your Codex config.toml.");
console.log("  2. Set ONEAPI_API_KEY as a user/system environment variable.");
console.log("  3. Replace the gateway URL and SANDBOX_ROOT placeholders.");
console.log("  4. Restart Codex Desktop.");
console.log(`  5. Keep this folder built: ${pathToFileURL(projectRoot).href}`);
