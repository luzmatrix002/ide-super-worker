import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DIFF_MAX_BYTES } from "./config.js";
import type { ResolvedScopedPatch } from "./types.js";

export interface WorkspaceSummary {
  changed_files: string[];
  diff: string;
  checks: string[];
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    windowsHide: true
  });

  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || ""
  };
}

function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[diff truncated at ${maxBytes} bytes]`;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function pathspec(scope?: ResolvedScopedPatch): string[] {
  return scope?.relativePaths?.length ? ["--", ...scope.relativePaths] : ["--"];
}

export function collectChangedFiles(cwd: string, scope?: ResolvedScopedPatch): string[] {
  const tracked = runGit(cwd, ["diff", "--name-only", ...pathspec(scope)]);
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", ...pathspec(scope)]);
  return [...new Set([...splitLines(tracked.stdout), ...splitLines(untracked.stdout)])].sort();
}

function buildUntrackedDiff(cwd: string, files: string[], remainingBytes: number): string {
  const chunks: string[] = [];
  let used = 0;

  for (const file of files) {
    const absolutePath = path.resolve(cwd, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      content = "[binary or unreadable file omitted]\n";
    }

    const escaped = file.replace(/\\/g, "/");
    const lines = content
      .split(/\r?\n/)
      .map((line) => `+${line}`)
      .join("\n");
    const diff = [
      `diff --git a/${escaped} b/${escaped}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${escaped}`,
      "@@",
      lines,
      ""
    ].join("\n");

    const size = Buffer.byteLength(diff, "utf8");
    if (used + size > remainingBytes) {
      chunks.push(`...[untracked diff truncated at ${remainingBytes} bytes]`);
      break;
    }
    chunks.push(diff);
    used += size;
  }

  return chunks.join("\n");
}

export function collectWorkspaceSummary(
  cwd: string,
  scope?: ResolvedScopedPatch,
  maxDiffBytes = scope?.maxDiffBytes || DIFF_MAX_BYTES
): WorkspaceSummary {
  const checks: string[] = [];
  const insideGit = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!insideGit.ok) {
    return {
      changed_files: [],
      diff: "",
      checks: [`git summary skipped: ${insideGit.stderr.trim() || "not a git repository"}`]
    };
  }

  const trackedDiff = runGit(cwd, ["diff", "--no-ext-diff", "--", ...(scope?.relativePaths || [])]);
  if (!trackedDiff.ok) {
    checks.push(`git diff failed: ${trackedDiff.stderr.trim()}`);
  }

  const changedFiles = collectChangedFiles(cwd, scope);
  const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", ...pathspec(scope)]);
  const untrackedFiles = splitLines(untracked.stdout);

  const trackedText = trackedDiff.stdout || "";
  const remaining = Math.max(0, maxDiffBytes - Buffer.byteLength(trackedText, "utf8"));
  const untrackedText = remaining > 0 ? buildUntrackedDiff(cwd, untrackedFiles, remaining) : "";
  const diff = truncateBytes([trackedText, untrackedText].filter(Boolean).join("\n"), maxDiffBytes);

  return { changed_files: changedFiles, diff, checks };
}

export function findOutOfScopeChanges(cwd: string, scope?: ResolvedScopedPatch): string[] {
  if (!scope?.relativePaths?.length) return [];
  const allChanges = collectChangedFiles(cwd);
  return allChanges.filter((file) => !scope.relativePaths.some((scopePath) => file === scopePath || file.startsWith(`${scopePath}/`)));
}

// --- git worktree isolation (optimization O8) ---

export interface WorktreeHandle {
  repo: string;
  path: string;
  branch: string;
}

/** Return the git top-level for `dir`, or undefined if it is not a git repo. */
export function findGitRoot(dir: string): string | undefined {
  const res = runGit(dir, ["rev-parse", "--show-toplevel"]);
  return res.ok ? res.stdout.trim() : undefined;
}

/**
 * Create an isolated detached worktree of `repoRoot`@HEAD under `baseDir`, on a
 * fresh branch. Returns undefined on failure so the caller can fall back to
 * running in place. `baseDir` must already exist and be inside SANDBOX_ROOT.
 */
export function createWorktree(repoRoot: string, baseDir: string, jobId: string): WorktreeHandle | undefined {
  const short = jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || Date.now().toString(36);
  const branch = `worker/${short}`;
  const worktreePath = path.join(baseDir, `worker-wt-${short}`);
  const res = runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (!res.ok) return undefined;
  return { repo: repoRoot, path: worktreePath, branch };
}

/** Remove a worktree and delete its branch. Safe to call with partial/empty handles. */
export function removeWorktree(handle: { repo?: string; path?: string; branch?: string } | undefined): void {
  if (!handle?.repo || !handle.path) return;
  runGit(handle.repo, ["worktree", "remove", "--force", handle.path]);
  if (handle.branch) runGit(handle.repo, ["branch", "-D", handle.branch]);
}
