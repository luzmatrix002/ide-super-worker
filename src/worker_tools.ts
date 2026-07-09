import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachReceipt, saveArtifact } from "./artifacts.js";
import { CHECK_OUTPUT_RESPONSE_MAX, SANDBOX_ROOT } from "./config.js";
import { digestFailure, reviewDirect } from "./lite.js";
import { killProcessTree } from "./process.js";
import { redactSecrets } from "./redact.js";
import { isInsideDirectory, validatePath } from "./security.js";
import { collectWorkspaceSummary, findGitRoot } from "./workspace.js";

const PACK_FILE_MAX_BYTES = 120_000;
const PACK_TOTAL_MAX_BYTES = 500_000;
const PACK_MAX_FILES = 50;
const COMMAND_OUTPUT_MAX = 200_000;
const RECEIPT_ARTIFACT_MIN_BYTES = 32_000;

function truncateBytes(text: string, maxBytes: number, label: string): string {
  const safe = redactSecrets(text);
  const buffer = Buffer.from(safe, "utf8");
  if (buffer.length <= maxBytes) return safe;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[${label} truncated at ${maxBytes} bytes]`;
}

function existingParent(candidate: string): string {
  let current = path.dirname(candidate);
  while (!fs.existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) throw new Error(`[Security] no existing parent for path: ${candidate}`);
    current = next;
  }
  return current;
}

function resolveInsideSandbox(input: string, mustExist = true, baseDir = SANDBOX_ROOT): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("[Security] path is required");
  if (input.includes("\0")) throw new Error("[Security] NUL byte in path is rejected");
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(baseDir, input);
  const checkPath = fs.existsSync(absolute) ? absolute : existingParent(absolute);
  const real = fs.realpathSync.native(checkPath);
  if (!isInsideDirectory(real, SANDBOX_ROOT)) {
    throw new Error(`[Security] path escapes SANDBOX_ROOT: ${input}`);
  }
  if (mustExist && !fs.existsSync(absolute)) throw new Error(`[Security] path does not exist: ${input}`);
  return absolute;
}

function relativeDisplay(file: string, base = SANDBOX_ROOT): string {
  const rel = path.relative(base, file).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : file.replace(/\\/g, "/");
}

function walkFiles(root: string, out: string[]): void {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".worker-lite-cache") {
      continue;
    }
    walkFiles(path.join(root, entry.name), out);
    if (out.length >= PACK_MAX_FILES) return;
  }
}

function keywords(task: string): string[] {
  return [
    ...new Set(
      task
        .split(/[^A-Za-z0-9_$]+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 4 && !/^(this|that|with|from|where|what|when|have|into|your|file|code)$/i.test(word))
    )
  ].slice(0, 20);
}

function lineWindows(lines: string[], needles: string[], windowSize: number): Array<{ start: number; end: number; text: string }> {
  const wanted = new Set<number>();
  const needleRe = needles.length ? new RegExp(needles.map((item) => item.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join("|"), "i") : undefined;
  const structureRe = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var)\s+|^\s*(describe|it|test)\s*\(/;

  lines.forEach((line, index) => {
    if ((needleRe && needleRe.test(line)) || structureRe.test(line)) {
      for (let cursor = Math.max(0, index - windowSize); cursor <= Math.min(lines.length - 1, index + windowSize); cursor += 1) {
        wanted.add(cursor);
      }
    }
  });

  if (wanted.size === 0) {
    for (let index = 0; index < Math.min(80, lines.length); index += 1) wanted.add(index);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number; text: string }> = [];
  let start = sorted[0] ?? 0;
  let prev = start;
  for (const line of sorted.slice(1)) {
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    windows.push({ start: start + 1, end: prev + 1, text: lines.slice(start, prev + 1).join("\n") });
    start = line;
    prev = line;
  }
  if (sorted.length) windows.push({ start: start + 1, end: prev + 1, text: lines.slice(start, prev + 1).join("\n") });
  return windows;
}

export function buildContextPack(args: Record<string, unknown>): Record<string, unknown> {
  const task = typeof args.task === "string" ? args.task : typeof args.prompt === "string" ? args.prompt : "";
  const rawPaths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  if (rawPaths.length === 0) throw new Error("paths is required");
  const maxFiles = Math.min(PACK_MAX_FILES, Math.max(1, Math.trunc(Number(args.max_files ?? PACK_MAX_FILES))));
  const maxBytesPerFile = Math.min(PACK_FILE_MAX_BYTES, Math.max(2_000, Math.trunc(Number(args.max_bytes_per_file ?? 30_000))));
  const windowSize = Math.min(12, Math.max(1, Math.trunc(Number(args.window_lines ?? 4))));
  const baseDir = args.base_dir ? validatePath(String(args.base_dir)) : SANDBOX_ROOT;

  const files: string[] = [];
  for (const item of rawPaths) {
    const resolved = resolveInsideSandbox(item, true, baseDir);
    walkFiles(resolved, files);
    if (files.length >= maxFiles) break;
  }

  const needles = keywords(task);
  const packed: Array<Record<string, unknown>> = [];
  let totalBytes = 0;
  let truncated = files.length > maxFiles;
  for (const file of [...new Set(files)].slice(0, maxFiles)) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > PACK_FILE_MAX_BYTES * 4) continue;
    const raw = fs.readFileSync(file, "utf8");
    const text = truncateBytes(raw, maxBytesPerFile, "file");
    const slices = lineWindows(text.split(/\r?\n/), needles, windowSize).slice(0, 12);
    const bytes = Buffer.byteLength(slices.map((slice) => slice.text).join("\n"), "utf8");
    if (totalBytes + bytes > PACK_TOTAL_MAX_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += bytes;
    packed.push({
      file: relativeDisplay(file, baseDir),
      bytes,
      slices
    });
  }

  const result = {
    task,
    mode: "zero_llm_symbol_slices",
    files: packed,
    file_count: packed.length,
    packed_bytes: totalBytes,
    truncated
  };
  const artifact = saveArtifact("read_pack", result);
  return attachReceipt(result, {
    tool: "read_pack",
    category: "context_pack",
    input: args,
    output: result,
    artifactRefs: artifact ? [artifact.artifact_ref] : [],
    truncated
  });
}

function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    status: result.status
  };
}

function diffPathspec(files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) return ["--"];
  return [
    "--",
    ...files.map(String).map((item) => {
      if (item.includes("\0") || path.isAbsolute(item)) throw new Error("[Security] diff files must be relative paths");
      const normalized = item.replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error("[Security] diff file escapes repository");
      }
      return normalized;
    })
  ];
}

function riskForFile(file: string): "low" | "medium" | "high" {
  if (/(^|\/)(package-lock|pnpm-lock|yarn\.lock|\.env|security|auth|login|billing|payment|migration|server|config)/i.test(file)) {
    return "high";
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(docs|README|PROMO|LICENSE)/i.test(file)) return "low";
  return "medium";
}

export async function digestDiff(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cwd = validatePath(String(args.cwd || SANDBOX_ROOT));
  const pathspec = diffPathspec(args.files);
  const nameStatus = git(cwd, ["diff", "--name-status", ...pathspec]);
  const numstat = git(cwd, ["diff", "--numstat", ...pathspec]);
  const summary = collectWorkspaceSummary(cwd, undefined, Math.min(80_000, Number(args.max_diff_bytes) || 80_000));
  if (!nameStatus.ok && !summary.diff) throw new Error(`git diff failed: ${nameStatus.stderr}`);

  const stats = new Map<string, { added: number; deleted: number }>();
  for (const line of numstat.stdout.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, file] = line.split(/\t/);
    stats.set(file, {
      added: Number(added) || 0,
      deleted: Number(deleted) || 0
    });
  }

  const files = nameStatus.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split(/\t/);
      const stat = stats.get(file) || { added: 0, deleted: 0 };
      return {
        file,
        status,
        added: stat.added,
        deleted: stat.deleted,
        risk: riskForFile(file)
      };
    });

  const highRiskFiles = files.filter((file) => file.risk === "high").map((file) => file.file);
  const hunks = summary.diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .slice(0, 20)
    .map((chunk) => {
      const header = `diff --git ${chunk.split(/\r?\n/).slice(0, 8).join("\n")}`;
      const hunkHeaders = [...chunk.matchAll(/^@@.*@@.*$/gm)].slice(0, 12).map((match) => match[0]);
      return truncateBytes([header, ...hunkHeaders].join("\n"), 4_000, "hunk summary");
    });

  let review: unknown;
  if (args.red_team === true || args.lite_review === true) {
    const raw = await reviewDirect({
      diff: summary.diff,
      focus: "Red-team this diff for regression, public API, security, data-loss, and missing-test risk. Be concise.",
      maxTokens: 800
    });
    try {
      review = JSON.parse(raw);
    } catch {
      review = { verdict: "unparsed", summary: raw };
    }
  }

  const result = {
    cwd,
    changed_files: summary.changed_files,
    files,
    high_risk_files: highRiskFiles,
    risk: highRiskFiles.length ? "high" : files.some((file) => file.risk === "medium") ? "medium" : "low",
    hunk_summaries: hunks,
    red_team: review
  };
  const artifact = saveArtifact("diff_digest", summary.diff);
  return attachReceipt(result, {
    tool: "diff_digest",
    category: "diff_digest",
    input: args,
    output: summary.diff || result,
    artifactRefs: artifact ? [artifact.artifact_ref] : [],
    truncated: summary.diff.includes("[diff truncated")
  });
}

function looksDestructive(command: string): boolean {
  return /\b(rm\s+-rf|Remove-Item\b.*\b-Recurse\b|del\s+\/[fsq]|rmdir\s+\/s|git\s+reset\s+--hard|git\s+clean\s+-fd|format\s+[A-Z]:|drop\s+database)\b/i.test(command);
}

type ShellCommandStatus = "passed" | "failed" | "timeout";
type ShellFailureKind =
  | "timeout"
  | "shell_mismatch"
  | "missing_command"
  | "test_failure"
  | "typecheck_failure"
  | "dependency_missing"
  | "permission_denied"
  | "unknown_failure";

function assessShellFailure(command: string, status: ShellCommandStatus, output: string): ShellFailureKind | undefined {
  if (status === "passed") return undefined;
  const combined = `${command}\n${output}`;
  if (status === "timeout" || /timed out|timeout/i.test(output)) return "timeout";
  if (/\b(Get-Content|ForEach-Object|Write-Output|Remove-Item|Set-Location|Select-String|Get-ChildItem)\b|\$[A-Za-z_][A-Za-z0-9_]*/.test(command)) {
    return "shell_mismatch";
  }
  if (/TS\d{4}:|TypeScript|tsc\b/i.test(combined)) return "typecheck_failure";
  if (/AssertionError|ERR_ASSERTION|\bFAIL\b|tests? failed|failing tests?|failed tests?/i.test(output)) return "test_failure";
  if (/Cannot find module|MODULE_NOT_FOUND|npm ERR! missing|ENOENT/i.test(output)) return "dependency_missing";
  if (/not recognized|command not found|executable file not found|ENOENT/i.test(output)) return "missing_command";
  if (/EACCES|EPERM|permission denied|access is denied/i.test(output)) return "permission_denied";
  return "unknown_failure";
}

function shellFailureAction(kind: ShellFailureKind): string {
  switch (kind) {
    case "timeout":
      return "Split the command or increase timeout_ms only if the longer wait is intentional; inspect the artifact output before retrying.";
    case "shell_mismatch":
      return "Rewrite the command for the active shell, or wrap PowerShell syntax with powershell -NoProfile -Command before retrying.";
    case "missing_command":
      return "Verify the executable or package script exists in this workspace, then retry with the correct command.";
    case "test_failure":
      return "Fix the failing test or application code using the compact digest and artifact output, then rerun the smallest failing command.";
    case "typecheck_failure":
      return "Fix the reported TypeScript/import/schema errors, then rerun the same typecheck command.";
    case "dependency_missing":
      return "Verify dependencies and module names; run install only when dependency installation is intended for this workspace.";
    case "permission_denied":
      return "Adjust the command path or permissions inside the sandbox; do not bypass permissions unless explicitly intended.";
    default:
      return "Inspect the compact digest and artifact output, reduce to a focused repro, then retry the smallest corrective command.";
  }
}

export function shouldAutoReroutePowerShellCommand(command: string): boolean {
  if (process.platform !== "win32") return false;
  if (/^\s*(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return false;
  return /\b(Get-Content|ForEach-Object|Write-Output|Remove-Item|Set-Location|Select-String|Get-ChildItem)\b|\$[A-Za-z_][A-Za-z0-9_]*/.test(command);
}

export function powershellRerouteCommand(command: string): string {
  const escaped = command.replace(/"/g, '\\"');
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${escaped}"`;
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid).catch(() => undefined);
    }, timeoutMs);
    child.stdout?.on("data", (data) => {
      output += data.toString("utf8");
      if (output.length > COMMAND_OUTPUT_MAX * 2) output = output.slice(-COMMAND_OUTPUT_MAX);
    });
    child.stderr?.on("data", (data) => {
      output += data.toString("utf8");
      if (output.length > COMMAND_OUTPUT_MAX * 2) output = output.slice(-COMMAND_OUTPUT_MAX);
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
}

export async function runWorkerShell(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cwd = validatePath(String(args.cwd || SANDBOX_ROOT));
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) throw new Error("command is required");
  if (looksDestructive(command) && args.allow_destructive !== true) {
    throw new Error("shell refused a destructive-looking command; pass allow_destructive:true only when intentional");
  }
  const timeoutMs = Math.min(60 * 60 * 1000, Math.max(1_000, Math.trunc(Number(args.timeout_ms ?? 10 * 60 * 1000))));

  let commandResult = await runShellCommand(command, cwd, timeoutMs);
  let executedCommand = command;
  let reroutedFrom: string | undefined;
  let rerouteReason: string | undefined;
  const initialStatus: ShellCommandStatus = commandResult.timedOut ? "timeout" : commandResult.code === 0 ? "passed" : "failed";
  const initialFailureKind = assessShellFailure(command, initialStatus, commandResult.output);
  if (
    args.disable_shell_reroute !== true &&
    initialFailureKind === "shell_mismatch" &&
    shouldAutoReroutePowerShellCommand(command)
  ) {
    const reroutedCommand = powershellRerouteCommand(command);
    const originalOutput = commandResult.output;
    const reroutedResult = await runShellCommand(reroutedCommand, cwd, timeoutMs);
    reroutedFrom = "cmd";
    rerouteReason = "shell_mismatch";
    executedCommand = reroutedCommand;
    commandResult = reroutedResult;
    commandResult.output =
      reroutedResult.code === 0 && !reroutedResult.timedOut
        ? reroutedResult.output
        : [
            "[reroute] PowerShell reroute attempted after cmd shell mismatch.",
            "[reroute] Original output:",
            originalOutput,
            "[reroute] Rerouted output:",
            reroutedResult.output
          ].join("\n");
  }

  const output = truncateBytes(commandResult.output, COMMAND_OUTPUT_MAX, "command output");
  const digestRequested = args.digest === true || commandResult.timedOut || commandResult.code !== 0;
  let digest: string | undefined;
  if (digestRequested) {
    if (!commandResult.timedOut && commandResult.code === 0) {
      const lines = output.split(/\r?\n/).filter(Boolean);
      digest = `command passed; ${lines.length} output line${lines.length === 1 ? "" : "s"}`;
    } else {
      try {
        digest = await digestFailure({
          task: `shell: ${command}`,
          changedFiles: [],
          checks: [output],
          errors: output.split(/\r?\n/).filter((line) => /error|fail|exception|timeout/i.test(line)).slice(-80),
          blockers: commandResult.timedOut ? ["command timed out"] : [`exit ${commandResult.code}`]
        });
      } catch {
        const interesting = output
          .split(/\r?\n/)
          .filter((line) => /error|fail|exception|timeout|not found|cannot/i.test(line))
          .slice(-30)
          .join("\n");
        digest = truncateBytes(interesting || output, CHECK_OUTPUT_RESPONSE_MAX, "command digest");
      }
    }
  }

  const responseOutput = args.digest === true ? truncateBytes(output, CHECK_OUTPUT_RESPONSE_MAX, "command output") : output;
  const outputBytes = Buffer.byteLength(output, "utf8");
  const responseOutputBytes = Buffer.byteLength(responseOutput, "utf8");
  const artifact =
    digestRequested || outputBytes > responseOutputBytes || outputBytes > RECEIPT_ARTIFACT_MIN_BYTES
      ? saveArtifact("shell", output)
      : undefined;
  const commandStatus: ShellCommandStatus = commandResult.timedOut ? "timeout" : commandResult.code === 0 ? "passed" : "failed";
  const failureKind = assessShellFailure(command, commandStatus, output);
  const requiredAction = failureKind ? shellFailureAction(failureKind) : undefined;
  const result = {
    cwd,
    command,
    executed_command: executedCommand,
    status: commandStatus,
    exit_code: commandResult.code,
    signal: commandResult.signal,
    digest,
    output: responseOutput,
    ...(reroutedFrom ? { rerouted_from: reroutedFrom, reroute_reason: rerouteReason } : {}),
    ...(failureKind
      ? {
          failure_kind: failureKind,
          required_action: requiredAction,
          failure: {
            kind: failureKind,
            retryable: true,
            route: "worker_local",
            action: requiredAction
          },
          fallback: {
            retryable: true,
            action: requiredAction,
            alternatives: ["read_pack", "diff_digest", "shell"]
          }
        }
      : {})
  };
  return attachReceipt(result, {
    tool: "shell",
    category: "command_digest",
    input: args,
    output,
    artifactRefs: artifact ? [artifact.artifact_ref] : [],
    truncated: outputBytes > responseOutputBytes,
    status: commandStatus === "passed" ? "ok" : "error"
  });
}

export function applyMechanicalEdits(args: Record<string, unknown>): Record<string, unknown> {
  const cwd = validatePath(String(args.cwd || SANDBOX_ROOT));
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) throw new Error("edits is required");
  if (edits.length > 100) throw new Error("too many edits; limit to 100");

  const changed = new Map<string, number>();
  for (const raw of edits) {
    if (!raw || typeof raw !== "object") throw new Error("each edit must be an object");
    const edit = raw as Record<string, unknown>;
    const file = resolveInsideSandbox(path.resolve(cwd, String(edit.file || "")));
    if (!isInsideDirectory(file, cwd)) throw new Error(`[Security] edit file escapes cwd: ${edit.file}`);
    const search = typeof edit.search === "string" ? edit.search : "";
    const replace = typeof edit.replace === "string" ? edit.replace : "";
    if (!search) throw new Error("edit.search is required");
    const before = fs.readFileSync(file, "utf8");
    let after: string;
    let count = 0;
    if (edit.regex === true) {
      const flags = typeof edit.flags === "string" ? edit.flags.replace(/[^gimsuy]/g, "") : "g";
      const re = new RegExp(search, flags.includes("g") ? flags : `${flags}g`);
      after = before.replace(re, () => {
        count += 1;
        return replace;
      });
    } else {
      count = before.split(search).length - 1;
      after = before.split(search).join(replace);
    }
    const expected = Number(edit.expected_replacements);
    if (Number.isFinite(expected) && expected !== count) {
      throw new Error(`replacement count mismatch for ${edit.file}: expected ${expected}, got ${count}`);
    }
    if (count > 0 && after !== before) {
      fs.writeFileSync(file, after, "utf8");
      changed.set(relativeDisplay(file, cwd), (changed.get(relativeDisplay(file, cwd)) || 0) + count);
    }
  }

  const result = {
    cwd,
    changed_files: [...changed.keys()].sort(),
    replacements: Object.fromEntries([...changed.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
  return attachReceipt(result, {
    tool: "apply_edits",
    category: "mechanical_edit",
    input: args,
    output: result
  });
}

export function gitHistory(args: Record<string, unknown>): Record<string, unknown> {
  const cwd = validatePath(String(args.cwd || SANDBOX_ROOT));
  const repo = findGitRoot(cwd);
  if (!repo) throw new Error("history requires a git repository");
  const file = String(args.file || "");
  if (!file) throw new Error("file is required");
  const absolute = resolveInsideSandbox(path.resolve(cwd, file));
  if (!isInsideDirectory(absolute, repo)) throw new Error("[Security] file is outside git repository");
  const relative = path.relative(repo, absolute).replace(/\\/g, "/");
  const maxCommits = Math.min(30, Math.max(1, Math.trunc(Number(args.max_commits ?? 12))));
  const log = git(repo, ["log", `-${maxCommits}`, "--date=short", "--pretty=format:%h%x09%ad%x09%an%x09%s", "--", relative]);
  const line = Number(args.line);
  let blame = "";
  if (Number.isFinite(line) && line > 0) {
    blame = git(repo, ["blame", "-L", `${Math.trunc(line)},${Math.trunc(line)}`, "--line-porcelain", "--", relative]).stdout;
  }
  const result = {
    repo,
    file: relative,
    line: Number.isFinite(line) && line > 0 ? Math.trunc(line) : undefined,
    commits: log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((row) => {
        const [hash, date, author, subject] = row.split(/\t/);
        return { hash, date, author, subject };
      }),
    blame: blame ? truncateBytes(blame, 4_000, "blame") : undefined
  };
  return attachReceipt(result, {
    tool: "history",
    category: "history",
    input: args,
    output: result,
    truncated: blame ? Buffer.byteLength(blame, "utf8") > 4_000 : false
  });
}

export async function draftFromChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cwd = validatePath(String(args.cwd || SANDBOX_ROOT));
  const kind = typeof args.kind === "string" ? args.kind : "commit";
  const maxDiffBytes = Math.min(80_000, Math.max(5_000, Math.trunc(Number(args.max_diff_bytes ?? 40_000))));
  const summary = collectWorkspaceSummary(cwd, undefined, maxDiffBytes);
  const raw = await reviewDirect({
    diff: summary.diff,
    focus: `Draft a ${kind} from this diff. Return concise markdown/text only; do not invent changes.`,
    maxTokens: Math.min(1200, Math.max(200, Math.trunc(Number(args.max_tokens ?? 600))))
  });
  const result = {
    kind,
    changed_files: summary.changed_files,
    draft: raw
  };
  const artifact = saveArtifact("draft_diff", summary.diff);
  return attachReceipt(result, {
    tool: "draft",
    category: "draft",
    input: args,
    output: raw,
    artifactRefs: artifact ? [artifact.artifact_ref] : [],
    truncated: summary.diff.includes("[diff truncated")
  });
}
