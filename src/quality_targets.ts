import * as fs from "node:fs";
import * as path from "node:path";

export type QualityThinkingMode = "probe" | "on" | "off";

export interface QualityTargetDescriptor {
  base_url: string;
  api_key_env: string;
  model: string;
  thinking: QualityThinkingMode;
}

export interface QualityBranchTarget extends QualityTargetDescriptor {
  id: string;
}

export type QualityReviewerTarget = QualityTargetDescriptor;

export interface QualityTargetsConfigV1 {
  version: 1;
  branches: [QualityBranchTarget, QualityBranchTarget, QualityBranchTarget];
  reviewer: QualityReviewerTarget;
}

export interface LoadQualityTargetsOptions {
  /** Explicit file path. When omitted, WORKER_QUALITY_TARGETS_FILE is read at call time. */
  filePath?: string;
  /** Injectable environment for deterministic tests and secret resolution. */
  env?: Readonly<Record<string, string | undefined>>;
}

const ROOT_FIELDS = new Set(["version", "branches", "reviewer"]);
const BRANCH_FIELDS = new Set(["id", "base_url", "api_key_env", "model", "thinking"]);
const REVIEWER_FIELDS = new Set(["base_url", "api_key_env", "model", "thinking"]);
const THINKING_MODES = new Set<QualityThinkingMode>(["probe", "on", "off"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message: string): never {
  throw new Error(`Quality targets ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${label} is missing required field ${JSON.stringify(key)}`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function branchId(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!ID_PATTERN.test(parsed)) fail(`${label} must be a token of at most 64 characters`);
  return parsed;
}

function environmentName(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!ENV_NAME_PATTERN.test(parsed)) fail(`${label} must be an environment variable name`);
  return parsed;
}

function thinkingMode(value: unknown, label: string): QualityThinkingMode {
  if (typeof value !== "string" || !THINKING_MODES.has(value as QualityThinkingMode)) {
    fail(`${label} must be one of probe, on, off`);
  }
  return value as QualityThinkingMode;
}

function baseUrl(value: unknown, label: string): string {
  const raw = nonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be an absolute HTTP(S) URL`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) {
    fail(`${label} must be an absolute HTTP(S) URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${label} must not contain credentials, query, or fragment`);
  }
  return raw;
}

function parseTarget(value: unknown, label: string, branch: true): QualityBranchTarget;
function parseTarget(value: unknown, label: string, branch: false): QualityReviewerTarget;
function parseTarget(
  value: unknown,
  label: string,
  branch: boolean
): QualityBranchTarget | QualityReviewerTarget {
  const input = record(value, label);
  exactFields(input, branch ? BRANCH_FIELDS : REVIEWER_FIELDS, label);
  const target: QualityReviewerTarget = {
    base_url: baseUrl(input.base_url, `${label}.base_url`),
    api_key_env: environmentName(input.api_key_env, `${label}.api_key_env`),
    model: nonEmptyString(input.model, `${label}.model`),
    thinking: thinkingMode(input.thinking, `${label}.thinking`)
  };
  return branch ? { id: branchId(input.id, `${label}.id`), ...target } : target;
}

function canonicalPair(target: QualityTargetDescriptor): string {
  const normalizedBase = new URL(target.base_url).toString().replace(/\/$/, "");
  return `${normalizedBase}\u0000${target.model}`;
}

/**
 * Resolve a target's secret explicitly. Config objects intentionally retain only
 * the environment variable name so logging or JSON serialization cannot expose
 * API key values accidentally.
 */
export function getQualityTargetApiKey(
  target: Pick<QualityTargetDescriptor, "api_key_env">,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const name = target.api_key_env;
  const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must contain a non-empty API key`);
  }
  return value;
}

/** Load and strictly validate the quality target manifest without import-time environment access. */
export function loadQualityTargetsConfig(options: LoadQualityTargetsOptions = {}): QualityTargetsConfigV1 {
  const env = options.env ?? process.env;
  const configuredPath = options.filePath ?? env.WORKER_QUALITY_TARGETS_FILE;
  if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
    fail("WORKER_QUALITY_TARGETS_FILE must be set");
  }

  const resolved = path.resolve(configuredPath.trim());
  if (!fs.existsSync(resolved)) fail(`file does not exist: ${resolved}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`file cannot be accessed: ${resolved}`);
  }
  if (!stat.isFile()) fail(`file must be a regular file: ${resolved}`);

  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  } catch {
    fail(`file cannot be read: ${resolved}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`file must contain valid JSON: ${resolved}`);
  }

  const root = record(value, "root");
  exactFields(root, ROOT_FIELDS, "root");
  if (root.version !== 1) fail("version must equal 1");
  if (!Array.isArray(root.branches) || root.branches.length !== 3) {
    fail("branches must contain exactly 3 targets");
  }

  const branches: [QualityBranchTarget, QualityBranchTarget, QualityBranchTarget] = [
    parseTarget(root.branches[0], "branches[0]", true),
    parseTarget(root.branches[1], "branches[1]", true),
    parseTarget(root.branches[2], "branches[2]", true)
  ];
  const reviewer = parseTarget(root.reviewer, "reviewer", false);

  if (new Set(branches.map((target) => target.id)).size !== branches.length) {
    fail("branch ids must be unique");
  }
  const branchPairs = new Set(branches.map(canonicalPair));
  if (branchPairs.size < 2) fail("branches must contain at least 2 distinct base_url + model pairs");
  if (branchPairs.has(canonicalPair(reviewer))) {
    fail("reviewer base_url + model pair must differ from every branch");
  }

  for (const target of [...branches, reviewer]) getQualityTargetApiKey(target, env);

  return { version: 1, branches, reviewer };
}
