import { spawnSync } from "node:child_process";
import * as process from "node:process";
import {
  allowBypassPermissions,
  allowOfficialAnthropic,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_MODEL,
  getClaudeCliModel,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName
} from "./config.js";
import type { StartJobInput } from "./types.js";

export interface ClaudeLaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  model: string;
  cliModel: string;
}

export function resolveClaudeCommand(): string {
  if (process.env.CLAUDE_CODE_COMMAND?.trim()) {
    return process.env.CLAUDE_CODE_COMMAND.trim();
  }
  return process.platform === "win32" ? "claude.exe" : "claude";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function requireGatewayConfig(): { baseUrl?: string; apiKey?: string } {
  const baseUrl = getGatewayBaseUrl();
  const apiKey = getGatewayApiKey();

  if (!allowOfficialAnthropic()) {
    if (!baseUrl) {
      throw new Error("ONEAPI_BASE_URL or ANTHROPIC_BASE_URL is required for third-party gateway mode");
    }
    if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("ONEAPI_API_KEY or ANTHROPIC_API_KEY is required for third-party gateway mode");
    }
  }

  return { baseUrl, apiKey };
}

export function buildClaudeLaunchPlan(input: StartJobInput, additionalDirs: string[]): ClaudeLaunchPlan {
  const model = getModelName(input.model);
  const cliModel = getClaudeCliModel();
  const command = resolveClaudeCommand();
  const { baseUrl, apiKey } = requireGatewayConfig();
  const args: string[] = [];

  const bareDefault = process.env.CLAUDE_CODE_BARE === "1";
  if (parseBoolean(input.bare, bareDefault)) {
    args.push("--bare");
  }

  args.push(
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    cliModel,
    "--no-session-persistence"
  );

  const permissionMode = input.permission_mode || DEFAULT_PERMISSION_MODE;
  if (permissionMode === "bypassPermissions" && !allowBypassPermissions()) {
    throw new Error("permission_mode=bypassPermissions is disabled. Set ALLOW_BYPASS_PERMISSIONS=1 to opt in explicitly.");
  }
  args.push("--permission-mode", permissionMode);

  const effort = input.effort || process.env.CLAUDE_EFFORT;
  if (typeof effort === "string" && effort.trim()) {
    args.push("--effort", effort.trim());
  }

  if (Number.isFinite(input.max_turns) && input.max_turns && input.max_turns > 0) {
    args.push("--max-turns", String(Math.trunc(input.max_turns)));
  }

  if (input.include_partial_messages) {
    args.push("--include-partial-messages");
  }

  if (additionalDirs.length > 0) {
    args.push("--add-dir", ...additionalDirs);
  }

  if (input.scoped_patch?.paths?.length) {
    args.push(
      "--append-system-prompt",
      [
        "You are running as a scoped code worker.",
        "Only edit files under these relative paths unless the user explicitly asks otherwise:",
        input.scoped_patch.paths.map((item) => `- ${item}`).join("\n"),
        "Keep the final answer compact; the MCP wrapper will collect git diff and changed files."
      ].join("\n")
    );
  }

  const allowedTools = asStringArray(input.allowed_tools);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", ...allowedTools);
  }

  const disallowedTools = asStringArray(input.disallowed_tools);
  if (disallowedTools.length > 0) {
    args.push("--disallowedTools", ...disallowedTools);
  }

  args.push(input.prompt);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_MODEL: cliModel || DEFAULT_MODEL,
    CLAUDE_MODEL: model || DEFAULT_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1",
    DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER || "1",
    DISABLE_BUG_COMMAND: process.env.DISABLE_BUG_COMMAND || "1",
    DISABLE_ERROR_REPORTING: process.env.DISABLE_ERROR_REPORTING || "1",
    DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY || "1"
  };

  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  delete env.ONEAPI_API_KEY;

  return { command, args, env, model, cliModel };
}

export function checkClaudeCli(): { ok: boolean; version?: string; error?: string } {
  const command = resolveClaudeCommand();
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  return { ok: true, version: (result.stdout || result.stderr).trim() };
}
