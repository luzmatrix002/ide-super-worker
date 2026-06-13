import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  ADAPTER_PREFIX_CACHE,
  LITE_CACHE_DIR,
  LITE_CACHE_TTL_MS,
  LITE_MODEL,
  SANDBOX_ROOT,
  fallbackConfigured,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getFallbackModel,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName
} from "./config.js";
import { appendMetrics, pickCacheTokens } from "./metrics.js";
import { redactSecrets } from "./redact.js";
import { isInsideDirectory } from "./security.js";

// Optimization O9: a read-only "lite" path that answers a question directly from
// the cheap gateway WITHOUT spawning Claude Code and WITHOUT the local adapter —
// cutting two hops for summarize/explain/classify tasks. It never edits files.

const FILE_MAX_BYTES = 200_000;
const ANALYZE_GLOB_MAX_FILES = 20;
const ANALYZE_GLOB_MAX_BYTES = FILE_MAX_BYTES * 2;

interface LiteTarget {
  baseUrl: string;
  apiKey?: string;
  model: string;
  label: "primary" | "fallback";
}

interface LiteRequest {
  system?: string;
  messages: Array<{ role: string; content: string }>;
}

function liteTargets(): LiteTarget[] {
  const targets: LiteTarget[] = [];
  const model = LITE_MODEL || getModelName();
  const primaryBase = getGatewayBaseUrl();
  if (primaryBase) {
    targets.push({ baseUrl: primaryBase.replace(/\/+$/, ""), apiKey: getGatewayApiKey(), model, label: "primary" });
  }
  if (fallbackConfigured()) {
    targets.push({
      baseUrl: getFallbackBaseUrl()!.replace(/\/+$/, ""),
      apiKey: getFallbackApiKey(),
      model: getFallbackModel() || "deepseek-v4-flash",
      label: "fallback"
    });
  }
  if (targets.length === 0) {
    throw new Error("analyze requires ONEAPI_BASE_URL/ANTHROPIC_BASE_URL (or a configured fallback)");
  }
  return targets;
}

function liteCacheDir(): string | undefined {
  if (!LITE_CACHE_DIR) return undefined;
  const resolved = path.resolve(LITE_CACHE_DIR);
  if (!isInsideDirectory(resolved, SANDBOX_ROOT)) {
    throw new Error("WORKER_LITE_CACHE_DIR must be inside SANDBOX_ROOT");
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Read a file only if it resolves inside SANDBOX_ROOT; truncated to a safe size. */
function readSandboxedFile(input: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(input));
  } catch {
    throw new Error(`[Security] file does not exist or cannot be accessed: ${input}`);
  }
  if (!isInsideDirectory(real, SANDBOX_ROOT)) {
    throw new Error(`[Security] file escapes SANDBOX_ROOT: ${input}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    throw new Error(`[Security] not a file: ${input}`);
  }
  const buffer = fs.readFileSync(real);
  if (buffer.length > FILE_MAX_BYTES) {
    return `${buffer.subarray(0, FILE_MAX_BYTES).toString("utf8")}\n...[file truncated at ${FILE_MAX_BYTES} bytes]`;
  }
  return buffer.toString("utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let out = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      index += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`${out}$`, "i");
}

function walkFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function expandFiles(files: string[]): string[] {
  const expanded: string[] = [];
  const allFiles: string[] = [];

  for (const item of files) {
    if (!/[*?]/.test(item)) {
      expanded.push(item);
      continue;
    }
    if (path.isAbsolute(item) && !isInsideDirectory(path.resolve(item), SANDBOX_ROOT)) {
      throw new Error(`[Security] glob escapes SANDBOX_ROOT: ${item}`);
    }
    if (allFiles.length === 0) walkFiles(SANDBOX_ROOT, allFiles);
    const absolutePattern = path.resolve(SANDBOX_ROOT, item).replace(/\\/g, "/");
    const relativePattern = item.replace(/\\/g, "/").replace(/^\.?\//, "");
    const absoluteRe = globToRegExp(absolutePattern);
    const relativeRe = globToRegExp(relativePattern);
    for (const file of allFiles) {
      const normalized = file.replace(/\\/g, "/");
      const relative = path.relative(SANDBOX_ROOT, file).replace(/\\/g, "/");
      if (absoluteRe.test(normalized) || relativeRe.test(relative)) {
        expanded.push(file);
      }
    }
  }

  const unique = [...new Set(expanded)].sort((a, b) => a.localeCompare(b));
  if (unique.length > ANALYZE_GLOB_MAX_FILES) {
    throw new Error(`analyze glob matched ${unique.length} files; narrow it to ${ANALYZE_GLOB_MAX_FILES} or fewer`);
  }
  return unique;
}

function cacheKey(tool: string, content: string): string {
  return createHash("sha256").update(`${tool}:${content}`).digest("hex").slice(0, 32);
}

function readCachedAnswer(tool: string, content: string): string | undefined {
  const dir = liteCacheDir();
  if (!dir || LITE_CACHE_TTL_MS <= 0) return undefined;
  const key = cacheKey(tool, content);
  const file = path.join(dir, `${key}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - Number(cached.ts) > LITE_CACHE_TTL_MS || typeof cached.answer !== "string") return undefined;
    appendMetrics({ route: "cache", tool, model: "(cached)", prompt_tokens: 0, completion_tokens: 0 });
    return cached.answer;
  } catch {
    return undefined;
  }
}

function writeCachedAnswer(tool: string, content: string, answer: string): void {
  const dir = liteCacheDir();
  if (!dir || LITE_CACHE_TTL_MS <= 0) return;
  const file = path.join(dir, `${cacheKey(tool, content)}.json`);
  fs.promises.writeFile(file, JSON.stringify({ ts: Date.now(), answer }), "utf8").catch(() => undefined);
}

async function callLiteCompletion(request: string | LiteRequest, maxTokens: number, tool: string): Promise<string> {
  const liteRequest = typeof request === "string" ? { messages: [{ role: "user", content: request }] } : request;
  const cacheContent = JSON.stringify(liteRequest);
  const cached = readCachedAnswer(tool, cacheContent);
  if (cached !== undefined) return cached;
  let lastError: unknown;
  for (const target of liteTargets()) {
    try {
      const response = await fetch(`${target.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: target.model,
          ...(liteRequest.system ? { system: liteRequest.system } : {}),
          messages: liteRequest.messages,
          max_tokens: maxTokens,
          stream: false
        })
      });

      if (!response.ok) {
        lastError = new Error(`${target.label} upstream returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
        continue;
      }

      const data = await response.json();
      appendMetrics({
        route: target.label,
        tool,
        model: data.model || target.model,
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        cache_hit_tokens: pickCacheTokens(data.usage),
        cache_miss_tokens: data.usage?.prompt_cache_miss_tokens ?? null
      });

      const answer = data.choices?.[0]?.message?.content;
      const redacted = redactSecrets(typeof answer === "string" ? answer : JSON.stringify(answer ?? ""));
      writeCachedAnswer(tool, cacheContent, redacted);
      return redacted;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${tool} failed on all upstreams`);
}

export async function analyzeDirect(prompt: string, files: string[] = [], maxTokens?: number): Promise<string> {
  const expandedFiles = expandFiles(files);
  const fileParts: string[] = [];
  let totalBytes = 0;
  for (const file of expandedFiles) {
    const content = readSandboxedFile(file);
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > ANALYZE_GLOB_MAX_BYTES) {
      throw new Error(`analyze files exceed ${ANALYZE_GLOB_MAX_BYTES} bytes after expansion; narrow the file list`);
    }
    fileParts.push(`\n# FILE: ${file}\n${content}`);
  }
  if (ADAPTER_PREFIX_CACHE) {
    const request: LiteRequest = {
      system: "You are a read-only code analyst. Answer concisely based only on the files below.",
      messages: [
        { role: "user", content: fileParts.join("\n") || "(no files provided)" },
        { role: "assistant", content: "Understood. Ready to answer questions about these files." },
        { role: "user", content: `# QUESTION\n${prompt.trim()}` }
      ]
    };
    return callLiteCompletion(request, maxTokens && maxTokens > 0 ? Math.trunc(maxTokens) : 1024, "analyze");
  }
  const content = [
    "You are a read-only code analyst. Answer concisely based only on the files below.",
    ...fileParts,
    `\n# QUESTION\n${prompt.trim()}`
  ].join("\n");

  return callLiteCompletion(content, maxTokens && maxTokens > 0 ? Math.trunc(maxTokens) : 1024, "analyze");
}

export async function digestFailure(input: {
  task: string;
  changedFiles: string[];
  checks: string[];
  errors: string[];
  blockers: string[];
}): Promise<string> {
  const content = [
    "Summarize this failed worker job for Codex. Return at most 5 concise lines: likely root cause, key evidence, and next action.",
    `\n# TASK\n${input.task}`,
    `\n# CHANGED FILES\n${input.changedFiles.join("\n") || "(none)"}`,
    `\n# BLOCKERS\n${input.blockers.join("\n") || "(none)"}`,
    `\n# CHECK OUTPUT\n${input.checks.join("\n\n").slice(0, 20_000) || "(none)"}`,
    `\n# ERROR LINES\n${input.errors.slice(-80).join("\n") || "(none)"}`
  ].join("\n");
  return callLiteCompletion(content, 700, "failure_digest");
}

export async function reviewDirect(input: {
  diff?: string;
  checks?: string[];
  files?: string[];
  focus?: string;
  maxTokens?: number;
}): Promise<string> {
  const fileParts: string[] = [];
  for (const file of expandFiles(input.files || [])) {
    fileParts.push(`\n# FILE: ${file}\n${readSandboxedFile(file)}`);
  }
  const content = [
    "Review the provided diff or files. Return ONLY JSON with this shape:",
    '{"verdict":"approve|needs_changes|risky","issues":[{"file":"path","line":1,"severity":"low|medium|high","note":"short"}],"summary":"short"}',
    input.focus ? `\n# FOCUS\n${input.focus}` : "",
    input.diff ? `\n# DIFF\n${input.diff}` : "",
    input.checks?.length ? `\n# CHECKS\n${input.checks.join("\n\n")}` : "",
    ...fileParts
  ].join("\n");
  return callLiteCompletion(content, input.maxTokens && input.maxTokens > 0 ? Math.trunc(input.maxTokens) : 800, "review");
}
