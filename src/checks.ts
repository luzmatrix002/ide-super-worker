import { spawn } from "node:child_process";
import { CHECK_OUTPUT_MAX, CHECK_TIMEOUT_MS } from "./config.js";
import { killProcessTree } from "./process.js";
import { redactSecrets } from "./redact.js";
import type { CheckStatus } from "./reasoning.js";
import type { CheckCommand } from "./types.js";

export interface CheckResult {
  label: string;
  status: CheckStatus;
}

function truncate(text: string): string {
  const buffer = Buffer.from(redactSecrets(text), "utf8");
  if (buffer.length <= CHECK_OUTPUT_MAX) return buffer.toString("utf8");
  return `${buffer.subarray(0, CHECK_OUTPUT_MAX).toString("utf8")}\n...[check output truncated at ${CHECK_OUTPUT_MAX} bytes]`;
}

function normalizeCheck(item: unknown): CheckCommand {
  if (typeof item === "string") {
    return { command: item };
  }
  if (!item || typeof item !== "object") {
    throw new Error("checks entries must be strings or objects");
  }

  const record = item as Record<string, unknown>;
  if (typeof record.command !== "string" || !record.command.trim()) {
    throw new Error("checks[].command is required");
  }

  return {
    name: typeof record.name === "string" ? record.name : undefined,
    command: record.command,
    timeout_ms: typeof record.timeout_ms === "number" ? record.timeout_ms : undefined
  };
}

export function parseCheckCommands(value: unknown): CheckCommand[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("checks must be an array");
  }
  return value.map(normalizeCheck);
}

export async function runCheckCommands(
  cwd: string,
  checks: CheckCommand[]
): Promise<{ lines: string[]; failed: boolean; results: CheckResult[] }> {
  const lines: string[] = [];
  const results: CheckResult[] = [];
  let failed = false;

  for (const check of checks) {
    const timeoutMs = Math.min(Math.max(check.timeout_ms || CHECK_TIMEOUT_MS, 1_000), CHECK_TIMEOUT_MS);
    const label = check.name || check.command;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean }>((resolve) => {
      const child = spawn(check.command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let output = "";
      let timedOut = false;
      const timer = setTimeout(async () => {
        timedOut = true;
        await killProcessTree(child.pid);
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (data) => {
        output += data.toString("utf8");
      });
      child.stderr?.on("data", (data) => {
        output += data.toString("utf8");
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 1, signal: null, output: error.message, timedOut });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, output, timedOut });
      });
    });

    if (result.timedOut || result.code !== 0) {
      failed = true;
    }

    const structuredStatus: CheckStatus = result.timedOut ? "timeout" : result.code === 0 ? "passed" : "failed";
    results.push({ label, status: structuredStatus });

    const status = result.timedOut ? "timeout" : result.code === 0 ? "passed" : `failed(${result.code ?? result.signal ?? "unknown"})`;
    const detail = truncate(result.output).trim();
    lines.push(detail ? `${label}: ${status}\n${detail}` : `${label}: ${status}`);
  }

  return { lines, failed, results };
}
