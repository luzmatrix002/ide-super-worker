import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_MODEL = "Qwen3.6-35B-A3B-APEX-I-Compact.gguf";
export const DEFAULT_CLAUDE_CLI_MODEL = "sonnet";
export const SERVER_VERSION = "2.6.0";

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return fallback;
}

function readIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function realDirectory(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  let realPath: string;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist or cannot be accessed: ${resolved}`);
  }

  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${realPath}`);
  }
  return realPath;
}

export const SANDBOX_ROOT = realDirectory(process.env.SANDBOX_ROOT || process.cwd(), "SANDBOX_ROOT");

function readLiteCacheDir(): string | undefined {
  const raw = process.env.WORKER_LITE_CACHE_DIR?.trim();
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  if (!isInsideDirectory(resolved, SANDBOX_ROOT)) {
    throw new Error("WORKER_LITE_CACHE_DIR must be inside SANDBOX_ROOT");
  }
  return resolved;
}

export const LOG_BUFFER_MAX = readIntegerEnv("LOG_BUFFER_MAX", 2000, 100, 100000);
export const LOG_LINE_MAX = readIntegerEnv("LOG_LINE_MAX", 20000, 1000, 200000);
export const RAW_STREAM_MAX = readIntegerEnv("RAW_STREAM_MAX_BYTES", 5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024);
export const DIFF_MAX_BYTES = readIntegerEnv("DIFF_MAX_BYTES", 200_000, 10_000, 5 * 1024 * 1024);
export const CHECK_OUTPUT_MAX = readIntegerEnv("CHECK_OUTPUT_MAX", 20_000, 1_000, 200_000);
export const CHECK_OUTPUT_RESPONSE_MAX = readIntegerEnv("CHECK_OUTPUT_RESPONSE_MAX", 2_000, 200, 200_000);
export const FAILURE_DIGEST_ENABLED = readBooleanEnv("WORKER_FAILURE_DIGEST", false);
export const DIGEST_BEFORE_REVISE = readBooleanEnv("WORKER_DIGEST_BEFORE_REVISE", true);
export const ADAPTER_PREFIX_CACHE = readBooleanEnv("ADAPTER_PREFIX_CACHE", false);
export const LITE_MODEL = (process.env.WORKER_LITE_MODEL || "").trim();
export const LITE_CACHE_DIR = readLiteCacheDir();
export const LITE_CACHE_TTL_MS = readIntegerEnv("WORKER_LITE_CACHE_TTL_MS", 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
export const CHECK_TIMEOUT_MS = readIntegerEnv("CHECK_TIMEOUT_MS", 10 * 60 * 1000, 1_000, 60 * 60 * 1000);
export const JOB_TTL_MS = readIntegerEnv("JOB_TTL_MS", 10 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000);
export const WAIT_DEFAULT_MS = readIntegerEnv("WAIT_DEFAULT_MS", 30 * 60 * 1000, 1_000, 6 * 60 * 60 * 1000);
export const WAIT_MAX_MS = readIntegerEnv("WAIT_MAX_MS", 6 * 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000);
export const MAX_RUNNING_JOBS = readIntegerEnv("MAX_RUNNING_JOBS", 4, 1, 100);
export const MAX_STORED_JOBS = readIntegerEnv("MAX_STORED_JOBS", 100, 10, 10000);
export const DEFAULT_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";
export const INCLUDE_DIFF_DEFAULT = readBooleanEnv("INCLUDE_DIFF_DEFAULT", true);

// --- Mythos-style deterministic reasoning layer ---
// MYTHOS_REASONING: attach the deterministic reasoning report to every job.
// MYTHOS_AUTO_REVISE: auto-retry Claude Code on concrete, fixable failures.
// MYTHOS_MAX_REVISE_PASSES: upper bound on automatic revise passes (0-4).
export const REASONING_ENABLED = readBooleanEnv("MYTHOS_REASONING", true);
export const AUTO_REVISE_ENABLED = readBooleanEnv("MYTHOS_AUTO_REVISE", true);
export const MAX_REVISE_PASSES = readIntegerEnv("MYTHOS_MAX_REVISE_PASSES", 2, 0, 4);

export function getModelName(explicit?: unknown): string {
  const candidate =
    typeof explicit === "string" && explicit.trim()
      ? explicit.trim()
      : process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  return candidate.trim();
}

export function getClaudeCliModel(): string {
  return (process.env.CLAUDE_CODE_MODEL || process.env.CLAUDE_CLI_MODEL || DEFAULT_CLAUDE_CLI_MODEL).trim();
}

export function getGatewayBaseUrl(): string | undefined {
  return process.env.ONEAPI_BASE_URL || process.env.ANTHROPIC_BASE_URL;
}

export function getGatewayApiKey(): string | undefined {
  return process.env.ONEAPI_API_KEY || process.env.ANTHROPIC_API_KEY;
}

// --- Fallback gateway (used when the primary upstream is unreachable/erroring) ---
// Keys live in env / .env only, never in source or tracked config.
export function getFallbackBaseUrl(): string | undefined {
  const raw = process.env.FALLBACK_BASE_URL;
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function getFallbackApiKey(): string | undefined {
  const raw = process.env.FALLBACK_API_KEY;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function readModelListEnv(name: string, max: number): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of raw.split(",")) {
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length >= max) break;
  }
  return models;
}

export function getFallbackModel(): string | undefined {
  const poolModel = readModelListEnv("FALLBACK_MODELS", 3)[0];
  if (poolModel) return poolModel;
  const raw = process.env.FALLBACK_MODEL;
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function getFallbackEscalateModel(): string | undefined {
  const poolModel = readModelListEnv("FALLBACK_MODELS", 3)[1];
  if (poolModel) return poolModel;
  const raw = process.env.FALLBACK_ESCALATE_MODEL;
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function getFallbackModels(): string[] {
  const explicitPool = readModelListEnv("FALLBACK_MODELS", 3);
  if (explicitPool.length > 0) return explicitPool;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const model of [process.env.FALLBACK_MODEL, process.env.FALLBACK_ESCALATE_MODEL]) {
    const trimmed = model?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}

export function fallbackConfigured(): boolean {
  return Boolean(getFallbackBaseUrl() && getFallbackApiKey());
}

export function allowOfficialAnthropic(): boolean {
  return process.env.ALLOW_OFFICIAL_ANTHROPIC === "1";
}

export function allowBypassPermissions(): boolean {
  return process.env.ALLOW_BYPASS_PERMISSIONS === "1";
}
