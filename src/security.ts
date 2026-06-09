import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_ROOT } from "./config.js";
import type { ResolvedScopedPatch, ScopedPatch } from "./types.js";

function decodePathInput(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    throw new Error("[Security] Invalid percent-encoded path");
  }
}

export function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validatePath(targetPath: string): string {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new Error("[Security] allowed_dirs must contain at least one non-empty directory");
  }
  if (targetPath.includes("\0")) {
    throw new Error("[Security] NUL byte in path is rejected");
  }

  const decoded = decodePathInput(targetPath.trim());
  const absolutePath = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(SANDBOX_ROOT, decoded);

  let realPath: string;
  try {
    realPath = fs.realpathSync.native(absolutePath);
  } catch {
    throw new Error(`[Security] Directory does not exist or cannot be accessed: ${absolutePath}`);
  }

  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    throw new Error(`[Security] Path is not a directory: ${realPath}`);
  }

  if (!isInsideDirectory(realPath, SANDBOX_ROOT)) {
    throw new Error(`[Security] Directory escapes SANDBOX_ROOT: ${absolutePath} (real: ${realPath})`);
  }

  return realPath;
}

export function validateAllowedDirs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("[Security] allowed_dirs must be a non-empty array");
  }

  const validated = value.map((item) => validatePath(String(item)));
  return [...new Set(validated)];
}

function validatePathUnderBase(baseDir: string, inputPath: string): { absolutePath: string; relativePath: string } {
  if (!inputPath.trim()) {
    throw new Error("[Security] scoped_patch paths must not be empty");
  }
  if (inputPath.includes("\0")) {
    throw new Error("[Security] NUL byte in scoped_patch path is rejected");
  }

  const decoded = decodePathInput(inputPath.trim());
  if (path.isAbsolute(decoded)) {
    throw new Error("[Security] scoped_patch paths must be relative to the first allowed_dir");
  }

  const absolutePath = path.resolve(baseDir, decoded);
  if (!isInsideDirectory(absolutePath, baseDir) || !isInsideDirectory(absolutePath, SANDBOX_ROOT)) {
    throw new Error(`[Security] scoped_patch path escapes allowed directory: ${inputPath}`);
  }

  let existing = absolutePath;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`[Security] scoped_patch has no existing parent: ${inputPath}`);
    }
    existing = parent;
  }

  const realExisting = fs.realpathSync.native(existing);
  if (!isInsideDirectory(realExisting, baseDir) || !isInsideDirectory(realExisting, SANDBOX_ROOT)) {
    throw new Error(`[Security] scoped_patch follows a symlink outside the sandbox: ${inputPath}`);
  }

  return {
    absolutePath,
    relativePath: path.relative(baseDir, absolutePath).replace(/\\/g, "/")
  };
}

function parseScopedPatch(value: unknown): ScopedPatch | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (Array.isArray(value)) {
    return { paths: value.map(String) };
  }
  if (typeof value !== "object") {
    throw new Error("scoped_patch must be an object or an array of relative paths");
  }

  const record = value as Record<string, unknown>;
  const rawPaths = record.paths ?? record.include_paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error("scoped_patch.paths must be a non-empty array");
  }

  const maxDiffBytes = Number(record.max_diff_bytes);
  return {
    paths: rawPaths.map(String),
    max_diff_bytes: Number.isFinite(maxDiffBytes) && maxDiffBytes > 0 ? Math.trunc(maxDiffBytes) : undefined
  };
}

export function validateScopedPatch(value: unknown, baseDir: string): ResolvedScopedPatch | undefined {
  const scopedPatch = parseScopedPatch(value);
  if (!scopedPatch) return undefined;

  const resolved = scopedPatch.paths.map((item) => validatePathUnderBase(baseDir, item));
  const unique = new Map<string, string>();
  for (const item of resolved) {
    unique.set(item.relativePath, item.absolutePath);
  }

  return {
    relativePaths: [...unique.keys()],
    absolutePaths: [...unique.values()],
    maxDiffBytes: scopedPatch.max_diff_bytes
  };
}
