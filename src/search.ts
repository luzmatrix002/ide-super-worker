import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./redact.js";

export interface SearchInput {
  pattern: string;
  dirs: string[];
  glob?: string;
  max_results?: number;
  mode?: "lines" | "files" | "count";
}

export interface SearchResult {
  mode: "lines" | "files" | "count";
  results: string[];
  count: number;
  truncated: boolean;
  engine: "rg" | "node";
  degraded?: boolean;
  degradation_reason?: string;
}

const SEARCH_TIMEOUT_MS = 5_000;
const LINE_MAX = 200;

function rgMaxBuffer(): number {
  const parsed = Number(process.env.WORKER_SEARCH_RG_MAX_BUFFER);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 8 * 1024 * 1024;
}

function maxResults(value: unknown): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(500, Math.max(1, Math.trunc(parsed)));
}

function normalizeMode(value: unknown): "lines" | "files" | "count" {
  return value === "files" || value === "count" ? value : "lines";
}

function trimLine(line: string): string {
  const safe = redactSecrets(line.replace(/\r/g, ""));
  return safe.length <= LINE_MAX ? safe : `${safe.slice(0, LINE_MAX)}...`;
}

function runRg(input: SearchInput, limit: number, mode: "lines" | "files" | "count"): SearchResult | undefined {
  const args = ["--no-config", "--color", "never", "--line-number", "--max-count", String(limit)];
  if (input.glob) args.push("--glob", input.glob);
  if (mode === "files") args.push("--files-with-matches");
  if (mode === "count") args.push("--count-matches");
  args.push("-e", input.pattern, "--", ...input.dirs);

  const result = spawnSync("rg", args, {
    encoding: "utf8",
    timeout: SEARCH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: rgMaxBuffer()
  });

  const code = (result.error as NodeJS.ErrnoException)?.code;
  // ENOENT: rg not installed → fall through to git grep / node search.
  // ENOBUFS: maxBuffer exceeded → fall through (output too large for rg).
  // ETIMEDOUT: rg killed after SEARCH_TIMEOUT_MS → fall through to next engine
  //   instead of throwing, so the fallback chain in searchWorkspace can try
  //   git grep and node search.  Previously this threw, which prevented any
  //   fallback and inflated the search error rate.
  if (code === "ENOENT" || code === "ENOBUFS" || code === "ETIMEDOUT") return undefined;
  if (result.error) throw new Error(`search failed: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    const stderr = (result.stderr || "").toLowerCase();
    // rg uses Rust regex which doesn't support look-around (lookahead/lookbehind).
    // JavaScript RegExp does support these, so fall through to git grep / node
    // search instead of throwing and relying on the outer try-catch.
    if (result.status === 2 && stderr.includes("regex parse error")) return undefined;
    throw new Error(`search failed: ${(result.stderr || result.stdout || `rg exited ${result.status}`).slice(0, 500)}`);
  }

  const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean).map(trimLine);
  const sliced = lines.slice(0, limit);
  return { mode, results: sliced, count: lines.length, truncated: lines.length > sliced.length, engine: "rg" };
}

function runGitGrep(input: SearchInput, limit: number, mode: "lines" | "files" | "count"): SearchResult | undefined {
  const args = ["grep", "-n"];
  if (mode === "files") args.push("-l");
  if (mode === "count") args.push("-c");
  args.push("-e", input.pattern, "--", ...input.dirs);
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: SEARCH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  // ENOENT: git not installed → fall through to node search.
  // ETIMEDOUT: git grep killed after timeout → fall through to node search.
  // Any other spawn error also falls through rather than throwing.
  const gitCode = (result.error as NodeJS.ErrnoException)?.code;
  if (gitCode === "ENOENT" || gitCode === "ETIMEDOUT" || result.error) return undefined;
  if (result.status !== 0 && result.status !== 1) return undefined;
  const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean).map(trimLine);
  const sliced = lines.slice(0, limit);
  return { mode, results: sliced, count: lines.length, truncated: lines.length > sliced.length, engine: "git" as SearchResult["engine"] };
}

function matchesGlob(file: string, glob?: string): boolean {
  if (!glob) return true;
  const normalized = file.replace(/\\/g, "/");
  const pattern = glob.replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`(^|/)${source}$`, "i").test(normalized);
}

function collectFiles(root: string, out: string[]): void {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function relativeDisplay(file: string, roots: string[]): string {
  const directoryRoot = roots.find((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  const base = directoryRoot || path.dirname(roots[0] || file);
  const relative = path.relative(base, file).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") ? relative : file.replace(/\\/g, "/");
}

function runNodeSearch(input: SearchInput, limit: number, mode: "lines" | "files" | "count"): SearchResult {
  // Defence-in-depth: even though searchWorkspace pre-validates the regex,
  // handle invalid patterns here too in case runNodeSearch is ever called
  // directly or the pre-validation is bypassed.
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, "u");
  } catch (e) {
    return {
      mode,
      results: [],
      count: 0,
      truncated: false,
      engine: "node",
      degraded: true,
      degradation_reason: `invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`
    };
  }
  const files: string[] = [];
  const roots = input.dirs.map((dir) => path.resolve(dir));
  for (const root of roots) collectFiles(root, files);

  const results: string[] = [];
  let count = 0;
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  let timedOut = false;

  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const relative = relativeDisplay(file, roots);
    if (!matchesGlob(relative, input.glob)) continue;

    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 1024 * 1024) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    let fileMatches = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!re.test(lines[index])) continue;
      fileMatches += 1;
      count += 1;
      if (mode === "lines" && results.length < limit) {
        results.push(trimLine(`${relative}:${index + 1}:${lines[index]}`));
      }
    }
    if (fileMatches > 0 && mode === "files") {
      count += 0;
      if (results.length < limit) results.push(trimLine(relative));
    }
    if (fileMatches > 0 && mode === "count" && results.length < limit) {
      results.push(trimLine(`${relative}:${fileMatches}`));
    }
  }

  const effectiveCount = mode === "lines" ? count : results.length;
  return {
    mode,
    results,
    count: effectiveCount,
    truncated: effectiveCount > results.length,
    engine: "node",
    degraded: timedOut,
    degradation_reason: timedOut ? "search_timed_out" : undefined
  };
}

export function searchWorkspace(input: SearchInput): SearchResult {
  if (!input.pattern?.trim()) throw new Error("pattern is required");
  if (!input.dirs.length) throw new Error("dirs is required");
  const limit = maxResults(input.max_results);
  const mode = normalizeMode(input.mode);

  // Pre-validate the regex pattern with JavaScript's RegExp engine.  If the
  // pattern is invalid here, rg / git grep / node search will all fail on it
  // too, so return a degraded result early instead of wasting timeout budget
  // on three failing engines and ultimately throwing.
  try {
    new RegExp(input.pattern, "u");
  } catch (e) {
    return {
      mode,
      results: [],
      count: 0,
      truncated: false,
      engine: "node",
      degraded: true,
      degradation_reason: `invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`
    };
  }

  // P0-A: Precheck dir existence. Non-existent dirs are filtered out before
  // invoking any search engine, so we don't waste timeout budget on three
  // failing fallbacks. If ALL dirs are missing, return a degraded empty result
  // instead of throwing — the caller can distinguish "no matches" from
  // "path problem" via the degraded flag.
  const existingDirs: string[] = [];
  const missingDirs: string[] = [];
  for (const dir of input.dirs) {
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory() || stat.isFile()) {
        existingDirs.push(dir);
      } else {
        missingDirs.push(dir);
      }
    } catch {
      missingDirs.push(dir);
    }
  }
  if (existingDirs.length === 0) {
    return {
      mode,
      results: [],
      count: 0,
      truncated: false,
      engine: "node",
      degraded: true,
      degradation_reason: `all search dirs missing or inaccessible: ${missingDirs.join(", ")}`
    };
  }
  const filteredInput = existingDirs.length < input.dirs.length ? { ...input, dirs: existingDirs } : input;
  // Defence-in-depth: wrap each engine in try-catch so that ANY unexpected
  // error from one engine falls through to the next instead of aborting the
  // entire search.  The last engine (node search) may still throw — that is
  // correct because there is no further fallback.
  try {
    const rgResult = runRg(filteredInput, limit, mode);
    if (rgResult) return rgResult;
  } catch {
    // Fall through to git grep.
  }
  try {
    const gitResult = runGitGrep(filteredInput, limit, mode);
    if (gitResult) return gitResult;
  } catch {
    // Fall through to node search.
  }
  // Defence-in-depth: wrap the final engine in try-catch as the ultimate
  // safety net.  runNodeSearch already handles regex errors and timeouts
  // gracefully, but any unexpected error (e.g. permission denied on a
  // deeply nested directory, EACCES on statSync) should still produce a
  // degraded result instead of propagating to the caller as a hard error.
  try {
    return runNodeSearch(filteredInput, limit, mode);
  } catch (error) {
    return {
      mode,
      results: [],
      count: 0,
      truncated: false,
      engine: "node",
      degraded: true,
      degradation_reason: `node_search_failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
