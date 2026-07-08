import "./env.js"; // load .env before config reads process.env
import { checkClaudeCli, resolveClaudeCommand } from "./claude.js";
import { clampMaxTokens, ensureAnthropicOpenAIAdapter, shouldUseOpenAIAdapter, thinkStripEnabled } from "./anthropic_openai_adapter.js";
import {
  allowOfficialAnthropic,
  DEFAULT_PERMISSION_MODE,
  fallbackConfigured,
  getClaudeCliModel,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getFallbackModel,
  getFallbackModels,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName,
  JOB_TTL_MS,
  LOG_BUFFER_MAX,
  RAW_STREAM_MAX,
  SERVER_VERSION,
  SANDBOX_ROOT,
  WAIT_DEFAULT_MS
} from "./config.js";

function isLocalHttp(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host);
}

// Probe a gateway's /models. A 404/405 is NOT a failure: it means the host is
// reachable but simply does not expose a model list (common for OpenAI-compatible
// gateways like OneAPI/New-API and some self-hosted servers) — chat still works.
// Only a thrown fetch (DNS/connection) or a 5xx is a real failure.
async function probeGateway(label: string, baseUrl: string | undefined, apiKey: string | undefined): Promise<void> {
  if (!baseUrl) {
    console.log(`[skip] ${label}: base url not set`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal
    });
    const body = await response.text();
    if (response.ok) {
      console.log(`[ok] ${label}: /models reachable (${body.length} bytes)`);
    } else if (response.status === 404 || response.status === 405) {
      console.log(`[warn] ${label}: /models not exposed (HTTP ${response.status}) — host reachable; gateway does not list models, chat should still work`);
    } else if (response.status === 401 || response.status === 403) {
      console.log(`[warn] ${label}: auth rejected (HTTP ${response.status}) — check the API key`);
    } else {
      console.log(`[fail] ${label}: /models returned ${response.status}: ${body.slice(0, 300)}`);
    }
  } catch (error: any) {
    console.log(`[fail] ${label}: unreachable: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkGatewayNetwork(): Promise<void> {
  await probeGateway("primary gateway", getGatewayBaseUrl(), getGatewayApiKey());
  if (fallbackConfigured()) {
    await probeGateway("fallback gateway", getFallbackBaseUrl(), getFallbackApiKey());
  } else {
    console.log("[skip] fallback gateway: not configured");
  }
}

async function checkAdapter(): Promise<void> {
  if (!shouldUseOpenAIAdapter()) {
    console.log("[skip] local Anthropic->OpenAI adapter disabled");
    return;
  }

  try {
    const adapter = await ensureAnthropicOpenAIAdapter();
    const response = await fetch(`${adapter.baseUrl}/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getModelName(),
        messages: [{ role: "user", content: "ping" }]
      })
    });
    const body = await response.text();
    if (!response.ok) {
      console.log(`[fail] local adapter count_tokens returned ${response.status}: ${body.slice(0, 500)}`);
      return;
    }
    console.log(`[ok] local adapter listening at ${adapter.baseUrl}`);
  } catch (error: any) {
    console.log(`[fail] local adapter check failed: ${error.message}`);
  }
}

async function main(): Promise<void> {
  console.log("[Doctor] MCP Codex Worker");
  console.log(`  server version: ${SERVER_VERSION}`);
  console.log(`  sandbox root: ${SANDBOX_ROOT}`);
  console.log(`  claude command: ${resolveClaudeCommand()}`);

  const cli = checkClaudeCli();
  if (cli.ok) {
    console.log(`  claude cli: ${cli.version}`);
  } else {
    console.log(`  claude cli: missing or failed (${cli.error})`);
  }

  const baseUrl = getGatewayBaseUrl();
  const apiKey = getGatewayApiKey();
  const model = getModelName();

  console.log(`  gateway base url: ${baseUrl || "(not set)"}`);
  console.log(`  api key: ${apiKey ? `set, length=${apiKey.length}` : "(not set)"}`);
  console.log(`  model: ${model}`);
  const fbKey = getFallbackApiKey();
  console.log(`  fallback gateway: ${getFallbackBaseUrl() || "(not set)"}`);
  console.log(`  fallback model: ${getFallbackModel() || "(not set)"}`);
  console.log(`  fallback model pool: ${getFallbackModels().join(", ") || "(not set)"}`);
  console.log(`  fallback api key: ${fbKey ? `set, length=${fbKey.length}` : "(not set)"}`);
  console.log(`  fallback active: ${fallbackConfigured() ? "yes (auto on primary failure)" : "no"}`);
  console.log(`  claude cli model: ${getClaudeCliModel()}`);
  console.log(`  default permission mode: ${DEFAULT_PERMISSION_MODE}`);
  console.log(`  official Anthropic fallback: ${allowOfficialAnthropic() ? "enabled" : "disabled"}`);
  console.log(`  local OpenAI adapter: ${shouldUseOpenAIAdapter() ? "enabled" : "disabled"}`);
  console.log(`  adapter qwen thinking: ${process.env.ADAPTER_ENABLE_THINKING === "1" ? "enabled" : "disabled"}`);
  console.log(`  adapter strip <think>: ${thinkStripEnabled() ? "enabled" : "disabled"}`);
  console.log(`  adapter max tokens clamp: ${process.env.ADAPTER_MAX_TOKENS ? clampMaxTokens(undefined) : "(off)"}`);
  console.log(`  adapter heartbeat ms: ${Math.max(1000, Number(process.env.ADAPTER_HEARTBEAT_MS) || 15000)}`);
  console.log(`  log buffer max: ${LOG_BUFFER_MAX}`);
  console.log(`  raw stream max bytes: ${RAW_STREAM_MAX}`);
  console.log(`  job ttl ms: ${JOB_TTL_MS}`);
  console.log(`  wait default ms: ${WAIT_DEFAULT_MS}`);

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === "http:" && !isLocalHttp(parsed)) {
        console.log("  warning: gateway uses plain HTTP. Use HTTPS unless this is a trusted private network.");
      }
    } catch {
      console.log("  warning: gateway base url is not a valid URL");
    }
  }

  if (process.argv.includes("--network")) {
    await checkGatewayNetwork();
    await checkAdapter();
  } else {
    console.log("  network check: skipped (run npm run doctor:network to call /models)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
