import * as fs from "node:fs";
import * as path from "node:path";
import {
  SANDBOX_ROOT,
  fallbackConfigured,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getFallbackModel,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName
} from "./config.js";
import { appendMetrics } from "./metrics.js";
import { redactSecrets } from "./redact.js";
import { isInsideDirectory } from "./security.js";

// Optimization O9: a read-only "lite" path that answers a question directly from
// the cheap gateway WITHOUT spawning Claude Code and WITHOUT the local adapter —
// cutting two hops for summarize/explain/classify tasks. It never edits files.

const FILE_MAX_BYTES = 200_000;

interface LiteTarget {
  baseUrl: string;
  apiKey?: string;
  model: string;
  label: "primary" | "fallback";
}

function liteTargets(): LiteTarget[] {
  const targets: LiteTarget[] = [];
  const primaryBase = getGatewayBaseUrl();
  if (primaryBase) {
    targets.push({ baseUrl: primaryBase.replace(/\/+$/, ""), apiKey: getGatewayApiKey(), model: getModelName(), label: "primary" });
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

export async function analyzeDirect(prompt: string, files: string[] = [], maxTokens?: number): Promise<string> {
  const parts: string[] = [prompt.trim()];
  for (const file of files) {
    parts.push(`\n# FILE: ${file}\n${readSandboxedFile(file)}`);
  }
  const content = parts.join("\n");

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
          messages: [{ role: "user", content }],
          max_tokens: maxTokens && maxTokens > 0 ? Math.trunc(maxTokens) : 1024,
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
        tool: "analyze",
        model: data.model || target.model,
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        cache_hit_tokens: data.usage?.prompt_cache_hit_tokens ?? null
      });

      const answer = data.choices?.[0]?.message?.content;
      return redactSecrets(typeof answer === "string" ? answer : JSON.stringify(answer ?? ""));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("analyze failed on all upstreams");
}
