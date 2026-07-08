import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachReceipt, createReceipt, getArtifactSlice, receiptMetricExtra, saveArtifact } from "./artifacts.js";
import { ensureAnthropicOpenAIAdapter, shouldUseOpenAIAdapter } from "./anthropic_openai_adapter.js";
import { analyzeDirect, digestFailure, reviewDirect } from "./lite.js";
import {
  AUTO_REVISE_ENABLED,
  CHECK_OUTPUT_RESPONSE_MAX,
  DIGEST_BEFORE_REVISE,
  FAILURE_DIGEST_ENABLED,
  INCLUDE_DIFF_DEFAULT,
  MAX_REVISE_PASSES,
  MAX_RUNNING_JOBS,
  REASONING_ENABLED,
  SANDBOX_ROOT,
  SERVER_VERSION,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  allowBypassPermissions
} from "./config.js";
import { buildClaudeLaunchPlan, type ClaudeLaunchPlan } from "./claude.js";
import { parseCheckCommands, runCheckCommands, type CheckResult } from "./checks.js";
import {
  appendLog,
  appendStderrChunk,
  createJobState,
  flushPartialStreams,
  isTerminalStatus,
  jobs,
  parseStreamJSON,
  runningJobCount,
  setTerminalStatus
} from "./jobs.js";
import { appendToolMetric, type WorkerCategory } from "./metrics.js";
import { killProcessTree } from "./process.js";
import { assess, buildRevisePrompt, isStalled, type JobSignals, type ReasoningReport } from "./reasoning.js";
import {
  buildEpisodeSummary,
  buildReliabilityProfile,
  normalizeReliabilityArgs,
  reliabilityMetricExtra,
  reliabilityRejectionReason
} from "./reliability.js";
import { redactSecrets } from "./redact.js";
import { searchWorkspace } from "./search.js";
import { validateAllowedDirs, validateScopedPatch } from "./security.js";
import {
  getToolControlDecision,
  getToolErrorControlStartDefaults,
  recordToolControlIntercept,
  recordToolControlOutcome,
  type ToolControlDecision
} from "./tool_error_control.js";
import {
  collectChangedFiles,
  collectWorkspaceSummary,
  createWorktree,
  findGitRoot,
  findOutOfScopeChanges,
  type WorktreeHandle
} from "./workspace.js";
import {
  applyMechanicalEdits,
  buildContextPack,
  digestDiff,
  draftFromChanges,
  gitHistory,
  runWorkerShell
} from "./worker_tools.js";
import type { CheckCommand, JobState, StageInput, StageResult, StartJobInput } from "./types.js";

function okJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function textResponse(text: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text: redactSecrets(text) }] };
}

function fallbackForTool(tool: string, message: string): Record<string, unknown> {
  const lower = message.toLowerCase();
  const securityAction = "Correct the path or argument so it stays inside SANDBOX_ROOT, then retry the same tool.";
  if (lower.includes("[security]") || lower.includes("escapes sandbox") || lower.includes("nul byte")) {
    return { retryable: true, action: securityAction, alternatives: ["search", "read_pack"] };
  }

  const fallbackByTool: Record<string, Record<string, unknown>> = {
    start: {
      retryable: true,
      action: "Fix start inputs, lower concurrency, or use permission_mode=acceptEdits/auto/default instead of bypassPermissions.",
      alternatives: ["read_pack", "diff_digest", "shell"]
    },
    get: {
      retryable: true,
      action: "Verify the job_id from start, or start a new job if the old one expired.",
      alternatives: ["start", "wait", "tail"]
    },
    wait: {
      retryable: true,
      action: "Verify the job_id and retry with a larger timeout_ms, or use get for a non-blocking status check.",
      alternatives: ["get", "tail"]
    },
    tail: {
      retryable: true,
      action: "Verify the job_id from start, or use get to inspect the job status.",
      alternatives: ["get", "wait"]
    },
    cancel: {
      retryable: true,
      action: "Verify the job_id and use get to confirm whether the job already reached a terminal state.",
      alternatives: ["get"]
    },
    get_artifact_slice: {
      retryable: true,
      action: "Use an artifact_ref from receipt.artifact_refs and retry with a bounded offset and limit.",
      alternatives: ["get", "wait", "read_pack"]
    },
    analyze: {
      retryable: true,
      action: "Provide a non-empty prompt, narrow files, or fall back to read_pack when the cheap analysis lane is unavailable.",
      alternatives: ["read_pack", "search"]
    },
    review: {
      retryable: true,
      action: "Pass either a valid job_id or files. If diff review is unavailable, use diff_digest first and retry review with focused files.",
      alternatives: ["diff_digest", "read_pack"]
    },
    search: {
      retryable: true,
      action: "Narrow dirs/glob/max_results. If search still fails, use read_pack on known paths.",
      alternatives: ["read_pack"]
    },
    read_pack: {
      retryable: true,
      action: "Narrow paths/max_files/max_bytes_per_file, or use search first to find the exact files.",
      alternatives: ["search"]
    },
    diff_digest: {
      retryable: true,
      action: "Ensure cwd is a git repository and narrow files/max_diff_bytes, then retry.",
      alternatives: ["review", "shell"]
    },
    shell: {
      retryable: true,
      action: "Use digest:true, shorten the command/timeout, and only pass allow_destructive:true when the destructive action is intentional.",
      alternatives: ["read_pack", "diff_digest"]
    },
    apply_edits: {
      retryable: true,
      action: "Check each edit file, search text, regex, and expected_replacements before retrying.",
      alternatives: ["read_pack", "search"]
    },
    history: {
      retryable: true,
      action: "Ensure cwd is inside a git repository and file points to a tracked path.",
      alternatives: ["search", "read_pack"]
    },
    draft: {
      retryable: true,
      action: "Ensure cwd has a git diff or reduce max_diff_bytes, then retry draft.",
      alternatives: ["diff_digest"]
    }
  };

  return (
    fallbackByTool[tool] || {
      retryable: false,
      action: "Use list_tools to choose a supported tool, then retry with that tool's documented input schema.",
      alternatives: Object.keys(TOOL_CATEGORIES)
    }
  );
}

export function toolFailureJson(tool: string, category: string, input: Record<string, unknown>, error: unknown) {
  const compact = compactMetricError(error);
  const fallback = fallbackForTool(tool, compact.error_message);
  const payload = {
    status: "error",
    tool,
    category,
    error: {
      class: compact.error_class,
      message: compact.error_message
    },
    fallback,
    required_action: fallback.action
  };
  return attachReceipt(payload, {
    tool,
    category,
    input,
    output: payload,
    summary: {
      status: payload.status,
      tool,
      category,
      error: payload.error,
      fallback
    },
    status: "error"
  });
}

function rejectedJson(
  tool: string,
  category: WorkerCategory,
  input: Record<string, unknown>,
  reason: string,
  requiredAction: string,
  alternatives: string[] = ["start"]
) {
  return attachReceipt(
    {
      status: "rejected",
      reason,
      required_action: requiredAction,
      fallback: {
        retryable: true,
        action: requiredAction,
        alternatives
      }
    },
    {
      tool,
      category,
      input,
      output: { status: "rejected", reason, required_action: requiredAction }
    }
  );
}

type ToolMetricStatus = "ok" | "error" | "rejected";

function payloadObjectFromValue(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("receipt" in value) return value as Record<string, any>;
  const content = "content" in value ? (value as { content?: unknown }).content : undefined;
  const text = Array.isArray(content) && typeof content[0]?.text === "string" ? content[0].text : undefined;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

export function workerMetricStatusFromPayload(value: unknown): { status: ToolMetricStatus; extra: Record<string, unknown> } {
  const payload = payloadObjectFromValue(value);
  const receipt = payload?.receipt;
  if (!receipt) return { status: "ok", extra: {} };

  const extra = receiptMetricExtra(receipt);
  const payloadStatus = typeof payload.status === "string" ? payload.status : undefined;
  const jobStatus = typeof payload.job_status === "string" ? payload.job_status : payloadStatus;
  if (payloadStatus === "rejected") return { status: "rejected", extra };

  if (receipt.status === "error") {
    if (
      receipt.tool === "shell" &&
      receipt.category === "command_digest" &&
      (payloadStatus === "failed" || payloadStatus === "timeout")
    ) {
      return {
        status: "ok",
        extra: {
          ...extra,
          command_status: payloadStatus,
          exit_code: payload.exit_code,
          failure_kind: payload.failure_kind,
          required_action: payload.required_action,
          repair_route: "worker_local"
        }
      };
    }
    if (receipt.category === "job_control" && ["running", "completed", "failed", "cancelled"].includes(String(jobStatus))) {
      return {
        status: "ok",
        extra: {
          ...extra,
          job_status: jobStatus,
          repair_route: jobStatus === "failed" ? "worker_local" : undefined
        }
      };
    }
    return { status: "error", extra };
  }

  return { status: "ok", extra };
}

const TOOL_CATEGORIES: Record<string, WorkerCategory> = {
  start: "implementation",
  get: "job_control",
  get_artifact_slice: "artifact",
  tail: "job_control",
  wait: "job_control",
  cancel: "job_control",
  analyze: "analysis",
  review: "review",
  search: "search",
  read_pack: "context_pack",
  diff_digest: "diff_digest",
  shell: "command_digest",
  apply_edits: "mechanical_edit",
  history: "history",
  draft: "draft"
};

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return undefined;
}

function toScopedPatchInput(scopedPatch: ReturnType<typeof validateScopedPatch>): StartJobInput["scoped_patch"] {
  return scopedPatch ? { paths: scopedPatch.relativePaths, max_diff_bytes: scopedPatch.maxDiffBytes } : undefined;
}

function parseStages(value: unknown, baseDir: string): StageInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("stages must be a non-empty array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`stages[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) throw new Error(`stages[${index}].prompt is required`);
    const scopedPatch = toScopedPatchInput(validateScopedPatch(record.scoped_patch, baseDir));
    return {
      prompt,
      checks: record.checks === undefined ? undefined : parseCheckCommands(record.checks),
      scoped_patch: scopedPatch
    };
  });
}

function toStartInput(args: Record<string, unknown>): StartJobInput {
  const allowedDirs = validateAllowedDirs(args.allowed_dirs);
  const stages = parseStages(args.stages, allowedDirs[0]);
  const prompt = stages?.[0]?.prompt ?? (typeof args.prompt === "string" ? args.prompt : "");
  if (!prompt.trim()) {
    throw new Error("prompt is required");
  }

  const firstStage = stages?.[0];
  const scopedPatch = validateScopedPatch(firstStage?.scoped_patch ?? args.scoped_patch, allowedDirs[0]);
  const defaultChecks = parseCheckCommands(args.checks);

  const reliabilityArgs = normalizeReliabilityArgs(args);
  const toolErrorDefaults = getToolErrorControlStartDefaults();

  return {
    prompt,
    allowed_dirs: allowedDirs,
    model: typeof args.model === "string" ? args.model : undefined,
    permission_mode: typeof args.permission_mode === "string" ? (args.permission_mode as StartJobInput["permission_mode"]) : undefined,
    allowed_tools: Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : undefined,
    disallowed_tools: Array.isArray(args.disallowed_tools) ? args.disallowed_tools.map(String) : undefined,
    scoped_patch: toScopedPatchInput(scopedPatch),
    checks: firstStage?.checks ?? defaultChecks,
    effort: typeof args.effort === "string" ? (args.effort as StartJobInput["effort"]) : undefined,
    max_turns: typeof args.max_turns === "number" ? args.max_turns : undefined,
    include_partial_messages: args.include_partial_messages === true,
    include_diff: parseOptionalBoolean(args.include_diff) ?? INCLUDE_DIFF_DEFAULT,
    bare: typeof args.bare === "boolean" ? args.bare : undefined,
    reasoning: parseOptionalBoolean(args.reasoning),
    auto_revise: parseOptionalBoolean(args.auto_revise) ?? toolErrorDefaults.auto_revise,
    max_revise_passes:
      typeof args.max_revise_passes === "number" ? args.max_revise_passes : toolErrorDefaults.max_revise_passes,
    reliability_tier: reliabilityArgs.reliability_tier ?? toolErrorDefaults.reliability_tier,
    blocking_policy: reliabilityArgs.blocking_policy ?? toolErrorDefaults.blocking_policy,
    semantic_gate: reliabilityArgs.semantic_gate ?? toolErrorDefaults.semantic_gate,
    tool_budget: reliabilityArgs.tool_budget,
    episode: reliabilityArgs.episode,
    stages: stages?.map((stage) => ({
      prompt: stage.prompt,
      checks: stage.checks ?? defaultChecks,
      scoped_patch: stage.scoped_patch ?? toScopedPatchInput(validateScopedPatch(args.scoped_patch, allowedDirs[0]))
    }))
  };
}

function truncateResponseText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(redactSecrets(text), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[response output truncated at ${maxBytes} bytes]`;
}

function compactReasoning(report: ReasoningReport | undefined) {
  if (!report) return undefined;
  return {
    decision: report.decision,
    belief: report.belief,
    difficulty: report.difficulty,
    blockers: report.blockers,
    required_changes: report.required_changes
  };
}

export function publicJob(job: JobState, includeDiff = job.launchInput.include_diff ?? INCLUDE_DIFF_DEFAULT, verbose = false, tool = "get") {
  const checks = verbose
    ? job.result.checks || []
    : (job.result.checks || []).map((line) => truncateResponseText(line, CHECK_OUTPUT_RESPONSE_MAX));
  const diff = includeDiff ? job.result.diff || "" : "";
  const reliability =
    job.reliabilityProfile ||
    buildReliabilityProfile(job.launchInput, { worktree: Boolean(job.worktreePath || job.worktreeBranch) });
  const episode =
    job.launchInput.episode === false
      ? undefined
      : buildEpisodeSummary({
          job_id: job.id,
          profile: reliability,
          model: job.model,
          started_at: job.started_at,
          ended_at: job.ended_at,
          changed_files: job.result.changed_files || [],
          checks: job.result.checks || [],
          revise_passes: job.result.revise_passes ?? job.revisePass,
          stage_count: job.stages?.length || 0
        });
  const baseCompact = {
    id: job.id,
    server_version: job.result.server_version || SERVER_VERSION,
    job_status: job.status,
    changed_files: job.result.changed_files || [],
    preexisting_changed_files: job.preexistingChangedFiles || [],
    checks,
    diff,
    reasoning: verbose ? job.result.reasoning : compactReasoning(job.result.reasoning),
    revise_passes: job.result.revise_passes ?? job.revisePass,
    reliability,
    episode,
    failure_digest: job.result.failure_digest,
    error: job.result.error,
    summary: job.result.result,
    session_id: job.result.session_id,
    duration_ms: job.result.duration_ms,
    total_cost_usd: job.result.total_cost_usd
  };
  const artifactPayload = {
    job_id: job.id,
    status: job.status,
    checks: job.result.checks || [],
    diff: job.result.diff || "",
    log: job.logBuffer,
    summary: job.result.result,
    failure_digest: job.result.failure_digest,
    reliability,
    episode
  };
  const artifact = saveArtifact("job_result", artifactPayload);
  const receipt = createReceipt({
    tool,
    category: "job_control",
    input: { job_id: job.id, verbose, include_diff: includeDiff },
    output: artifactPayload,
    summary: baseCompact,
    artifactRefs: artifact ? [artifact.artifact_ref] : [],
    truncated: !verbose || !includeDiff,
    status: job.status === "failed" ? "error" : "ok"
  });
  const compact = { ...baseCompact, receipt };
  if (job.stages?.length) {
    (compact as Record<string, unknown>).stage_index = job.stageIndex;
    (compact as Record<string, unknown>).stage_results = job.stageResults;
  }

  if (!verbose) return compact;

  const result = {
    ...job.result,
    diff
  };

  return {
    ...compact,
    id: job.id,
    pid: job.pid,
    server_version: job.result.server_version || SERVER_VERSION,
    job_status: job.status,
    changed_files: compact.changed_files,
    checks,
    diff,
    reasoning: job.result.reasoning,
    revise_passes: compact.revise_passes,
    status: job.status,
    cwd: job.cwd,
    model: job.model,
    allowed_dirs: job.allowedDirs,
    scoped_patch: job.scopedPatch?.relativePaths || [],
    started_at: job.started_at,
    ended_at: job.ended_at,
    exit_code: job.exit_code,
    signal: job.signal,
    result
  };
}

export function preflightStartRejection(args: Record<string, unknown>) {
  if (args.permission_mode === "bypassPermissions" && !allowBypassPermissions()) {
    return rejectedJson(
      "start",
      "implementation",
      args,
      "permission_mode=bypassPermissions is disabled",
      "Use permission_mode=acceptEdits, auto, default, dontAsk, or plan; set ALLOW_BYPASS_PERMISSIONS=1 only when this workspace intentionally permits bypass."
    );
  }
  const reliability = buildReliabilityProfile({ ...args, ...normalizeReliabilityArgs(args) } as Partial<StartJobInput>);
  const reliabilityReason = reliabilityRejectionReason(reliability);
  if (reliabilityReason) {
    return rejectedJson(
      "start",
      "implementation",
      args,
      reliabilityReason,
      "Lower blocking_policy to observe/warn, or provide the missing reliability gates before retrying."
    );
  }
  return undefined;
}

function parseLines(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(2000, Math.max(1, Math.trunc(parsed)));
}

function parseWaitTimeout(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? WAIT_DEFAULT_MS);
  if (!Number.isFinite(parsed)) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_MAX_MS, Math.max(1_000, Math.trunc(parsed)));
}

function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function compactMetricError(error: unknown): Record<string, string> {
  const errorObject = error instanceof Error ? error : undefined;
  const message = redactSecrets(errorObject?.message || String(error || "unknown error")).replace(/\s+/g, " ").trim();
  return {
    error_class: redactSecrets(errorObject?.name || "Error").slice(0, 80),
    error_message: message.length <= 300 ? message : `${message.slice(0, 300)}...`
  };
}

function isRejectableInputError(message: string): boolean {
  return /(\[Security\]| is required|requires |must be|invalid |path does not exist|path escapes|too many |refused a destructive-looking command|replacement count mismatch)/i.test(
    message
  );
}

function validateSearchPaths(value: unknown): string[] {
  const rawPaths = Array.isArray(value) && value.length ? value.map(String) : [SANDBOX_ROOT];
  const validated = rawPaths.map((item) => {
    if (!item.trim()) throw new Error("[Security] search dirs must contain non-empty paths");
    if (item.includes("\0")) throw new Error("[Security] NUL byte in search path is rejected");
    const absolute = path.isAbsolute(item) ? path.resolve(item) : path.resolve(SANDBOX_ROOT, item);
    let real: string;
    try {
      real = fs.realpathSync.native(absolute);
    } catch {
      throw new Error(`[Security] search path does not exist or cannot be accessed: ${absolute}`);
    }
    const stat = fs.statSync(real);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`[Security] search path is not a file or directory: ${real}`);
    }
    if (!isInsideDirectory(real, SANDBOX_ROOT)) {
      throw new Error(`[Security] search path escapes SANDBOX_ROOT: ${absolute} (real: ${real})`);
    }
    return real;
  });
  return [...new Set(validated)];
}

function validateReviewFiles(files: string[]): string[] {
  return files.map((file) => {
    if (file.includes("\0")) throw new Error("[Security] NUL byte in review file is rejected");
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(SANDBOX_ROOT, file);
    let real = absolute;
    if (fs.existsSync(absolute)) {
      real = fs.realpathSync.native(absolute);
    } else {
      let parent = path.dirname(absolute);
      while (!fs.existsSync(parent)) {
        const next = path.dirname(parent);
        if (next === parent) throw new Error(`[Security] review file has no existing parent: ${file}`);
        parent = next;
      }
      const realParent = fs.realpathSync.native(parent);
      if (!isInsideDirectory(realParent, SANDBOX_ROOT)) {
        throw new Error(`[Security] review file escapes SANDBOX_ROOT: ${file}`);
      }
    }
    if (!isInsideDirectory(real, SANDBOX_ROOT)) {
      throw new Error(`[Security] review file escapes SANDBOX_ROOT: ${file}`);
    }
    return absolute;
  });
}

function reviewDiffForFiles(files: string[]): { diff?: string; files: string[] } {
  const validated = validateReviewFiles(files);
  if (validated.length === 0) return { files: [] };
  const gitRoot = findGitRoot(path.dirname(validated[0]));
  if (!gitRoot) return { files: validated };
  for (const file of validated) {
    if (!isInsideDirectory(file, gitRoot)) {
      throw new Error("review files must belong to the same git repository");
    }
  }
  const relativeFiles = validated.map((file) => path.relative(gitRoot, file).replace(/\\/g, "/"));
  const diff = spawnSync("git", ["-C", gitRoot, "diff", "HEAD", "--", ...relativeFiles], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  if (diff.error) throw new Error(`review diff failed: ${diff.error.message}`);
  if (diff.status !== 0) {
    throw new Error(`review diff failed: ${(diff.stderr || diff.stdout || `git exited ${diff.status}`).slice(0, 500)}`);
  }
  return { diff: diff.stdout || "", files: diff.stdout ? [] : validated };
}

async function degradedByToolControl(
  tool: string,
  category: WorkerCategory,
  args: Record<string, unknown>,
  decision: ToolControlDecision
) {
  const base = {
    status: "degraded",
    verdict: "degraded",
    reason: decision.reason,
    required_action: decision.requiredAction,
    fallback: { retryable: true, action: decision.requiredAction, alternatives: decision.alternatives },
    tool_control: {
      action: decision.action,
      circuit_key: decision.circuitKey,
      error_class: decision.errorClass,
      expires_at: decision.expiresAt
    }
  };

  if (tool === "review") {
    const jobId = typeof args.job_id === "string" ? args.job_id : "";
    const job = jobId ? jobs.get(jobId) : undefined;
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    if (job) {
      const diffDigest = await digestDiff({ cwd: job.cwd, max_diff_bytes: typeof args.max_diff_bytes === "number" ? args.max_diff_bytes : 40_000 });
      const payload = {
        ...base,
        fallback_used: "diff_digest",
        source: "job",
        job_id: job.id,
        job_status: job.status,
        changed_files: job.result.changed_files || [],
        checks: job.result.checks || [],
        diff_digest: {
          changed_files: diffDigest.changed_files,
          files: diffDigest.files,
          high_risk_files: diffDigest.high_risk_files,
          risk: diffDigest.risk,
          hunk_summaries: diffDigest.hunk_summaries
        }
      };
      return attachReceipt(payload, { tool, category, input: args, output: payload });
    }
    if (files.length > 0) {
      const fileReview = reviewDiffForFiles(files);
      const hunkHeaders = (fileReview.diff || "").match(/^@@.*@@.*$/gm)?.slice(0, 12) || [];
      const payload = {
        ...base,
        fallback_used: "local_diff_summary",
        source: "files",
        files: fileReview.files.length > 0 ? fileReview.files : files,
        diff_bytes: Buffer.byteLength(fileReview.diff || "", "utf8"),
        hunk_headers: hunkHeaders
      };
      return attachReceipt(payload, { tool, category, input: args, output: payload });
    }
  }

  if (tool === "analyze") {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    if (files.length > 0) {
      const pack = buildContextPack({
        paths: files,
        task: "analyze degraded route; LLM analysis circuit is open",
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        max_files: Math.min(files.length, 20),
        max_bytes_per_file: 8_000
      });
      const payload = {
        ...base,
        fallback_used: "read_pack",
        source: "files",
        context_pack: {
          file_count: pack.file_count,
          packed_bytes: pack.packed_bytes,
          truncated: pack.truncated,
          receipt: pack.receipt
        }
      };
      return attachReceipt(payload, { tool, category, input: args, output: payload });
    }
  }

  return attachReceipt(
    {
      status: "rejected",
      reason: decision.reason,
      required_action: decision.requiredAction,
      fallback: { retryable: true, action: decision.requiredAction, alternatives: decision.alternatives },
      tool_control: base.tool_control
    },
    { tool, category, input: args, output: base }
  );
}

function failureEvidence(evaluation: JobEvaluation): string {
  const chunks = [
    ...evaluation.checkLines.filter((line) => /failed|timeout|violation/i.test(line)).map((line) => truncateResponseText(line, 4_000)),
    ...evaluation.signals.errorLines.slice(-50)
  ];
  return chunks.join("\n\n").slice(0, 12_000);
}

function currentStageResult(job: JobState, evaluation: JobEvaluation): StageResult {
  return {
    index: job.stageIndex,
    status: evaluation.finalStatus,
    changed_files: evaluation.changedFiles,
    checks: evaluation.checkLines,
    error: evaluation.finalStatus === "failed" ? evaluation.signals.scopeViolations[0] : undefined,
    failure_digest: job.result.failure_digest
  };
}

/** Build the Claude Code launch plan and wire the local Anthropic->OpenAI adapter. */
async function buildLaunchPlan(input: StartJobInput, additionalDirs: string[]): Promise<ClaudeLaunchPlan> {
  const launch = buildClaudeLaunchPlan(input, additionalDirs);
  if (shouldUseOpenAIAdapter()) {
    const adapter = await ensureAnthropicOpenAIAdapter(launch.model);
    launch.env.ANTHROPIC_BASE_URL = adapter.baseUrl;
    launch.env.ANTHROPIC_MODEL = launch.cliModel;
    launch.env.CLAUDE_MODEL = launch.model;
    launch.args.splice(
      Math.max(0, launch.args.length - 1),
      0,
      "--settings",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: adapter.baseUrl,
          ANTHROPIC_MODEL: launch.cliModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: launch.cliModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: launch.cliModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: launch.cliModel
        }
      })
    );
  }
  return launch;
}

/** Spawn Claude Code and wire process handlers. Returns false if the spawn failed terminally. */
function spawnClaude(jobId: string, job: JobState, launch: ClaudeLaunchPlan): boolean {
  job.stdoutRemainder = "";
  job.stderrRemainder = "";

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: job.cwd,
      detached: process.platform !== "win32",
      env: launch.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error: any) {
    setTerminalStatus(jobId, job, "failed", { error: error.message });
    return false;
  }

  job.pid = child.pid;
  registerProcessHandlers(jobId, job, child);

  if (!child.pid) {
    setTerminalStatus(jobId, job, "failed", { error: "Claude Code process did not provide a PID" });
    return false;
  }
  return true;
}

interface JobEvaluation {
  finalStatus: "completed" | "failed";
  checkLines: string[];
  changedFiles: string[];
  diff: string;
  signals: JobSignals;
}

/** Collect the workspace summary, run checks, and assemble the auditable execution signals. */
async function evaluateJob(job: JobState, code: number | null, signal: NodeJS.Signals | null): Promise<JobEvaluation> {
  const scopedSummary = collectWorkspaceSummary(job.cwd, job.scopedPatch);
  const outOfScopeChanges = findOutOfScopeChanges(job.cwd, job.scopedPatch);
  const checkLines = [...scopedSummary.checks];
  const isGitRepo = !scopedSummary.checks.some((line) => line.startsWith("git summary skipped"));
  let finalStatus: "completed" | "failed" = code === 0 ? "completed" : "failed";

  if (job.preexistingChangedFiles.length > 0) {
    checkLines.push(`preexisting changes before worker: ${job.preexistingChangedFiles.join(", ")}`);
  }

  if (outOfScopeChanges.length > 0) {
    finalStatus = "failed";
    checkLines.push(`scoped_patch violation: changed outside scope: ${outOfScopeChanges.join(", ")}`);
  } else if (job.scopedPatch?.relativePaths.length) {
    checkLines.push(`scoped_patch: passed (${job.scopedPatch.relativePaths.join(", ")})`);
  }

  let checkResults: CheckResult[] = [];
  if (job.checks.length > 0) {
    const results = await runCheckCommands(job.cwd, job.checks);
    checkLines.push(...results.lines);
    checkResults = results.results;
    if (results.failed) {
      finalStatus = "failed";
    }
  }

  const signals: JobSignals = {
    task: job.originalPrompt,
    exitCode: code,
    signal,
    changedFiles: scopedSummary.changed_files,
    diffBytes: Buffer.byteLength(scopedSummary.diff, "utf8"),
    isGitRepo,
    scopeViolations: outOfScopeChanges,
    scopedPaths: job.scopedPatch?.relativePaths ?? [],
    checks: checkResults,
    errorLines: job.logBuffer.filter((line) => line.startsWith("[stderr]") || line.startsWith("[error]"))
  };

  return { finalStatus, checkLines, changedFiles: scopedSummary.changed_files, diff: scopedSummary.diff, signals };
}

function finalizeResult(
  jobId: string,
  job: JobState,
  evaluation: JobEvaluation,
  report: ReasoningReport | undefined,
  code: number | null,
  signal: NodeJS.Signals | null
): void {
  const reliability =
    job.reliabilityProfile ||
    buildReliabilityProfile(job.launchInput, { worktree: Boolean(job.worktreePath || job.worktreeBranch) });
  const episode =
    job.launchInput.episode === false
      ? undefined
      : buildEpisodeSummary({
          job_id: job.id,
          profile: reliability,
          model: job.model,
          started_at: job.started_at,
          ended_at: job.ended_at,
          changed_files: evaluation.changedFiles,
          checks: evaluation.checkLines,
          revise_passes: job.revisePass,
          stage_count: job.stages?.length || 0
        });
  job.result = {
    ...job.result,
    server_version: SERVER_VERSION,
    job_status: evaluation.finalStatus,
    changed_files: evaluation.changedFiles,
    checks: evaluation.checkLines,
    diff: evaluation.diff,
    preexisting_changed_files: job.preexistingChangedFiles,
    reasoning: report,
    revise_passes: job.revisePass,
    failure_digest: job.result.failure_digest,
    stage_index: job.stages?.length ? job.stageIndex : undefined,
    stage_results: job.stages?.length ? job.stageResults : undefined,
    reliability,
    episode
  };

  const scopeError =
    evaluation.signals.scopeViolations.length > 0
      ? `scoped_patch violation: ${evaluation.signals.scopeViolations.join(", ")}`
      : undefined;

  setTerminalStatus(jobId, job, evaluation.finalStatus, { exitCode: code, signal, error: scopeError });
}

async function maybeDigestFailure(job: JobState, evaluation: JobEvaluation, report: ReasoningReport | undefined): Promise<void> {
  if (!FAILURE_DIGEST_ENABLED || evaluation.finalStatus !== "failed") return;
  try {
    job.result.failure_digest = await digestFailure({
      task: job.originalPrompt,
      changedFiles: evaluation.changedFiles,
      checks: evaluation.checkLines,
      errors: evaluation.signals.errorLines,
      blockers: report?.blockers || []
    });
  } catch (error: any) {
    appendLog(job, `[failure_digest] skipped: ${error?.message || String(error)}`);
  }
}

async function maybeAdvanceStage(jobId: string, job: JobState, evaluation: JobEvaluation): Promise<boolean> {
  if (!job.stages?.length || evaluation.finalStatus !== "completed") return false;
  const nextIndex = job.stageIndex + 1;
  if (nextIndex >= job.stages.length) return false;

  job.stageResults.push(currentStageResult(job, evaluation));
  job.stageIndex = nextIndex;
  job.lastReport = undefined;

  const stage = job.stages[nextIndex];
  const nextInput: StartJobInput = {
    ...job.launchInput,
    prompt: stage.prompt,
    checks: stage.checks || [],
    scoped_patch: stage.scoped_patch
  };
  job.originalPrompt = stage.prompt;
  job.launchInput = nextInput;
  job.checks = nextInput.checks || [];
  job.scopedPatch = validateScopedPatch(nextInput.scoped_patch, job.cwd);
  appendLog(job, `[stage] launching ${nextIndex + 1}/${job.stages.length}`);

  const launch = await buildLaunchPlan(nextInput, job.additionalDirs);
  return spawnClaude(jobId, job, launch);
}

/** Decide whether to finalize the job or run another bounded revise pass (recurrent depth). */
async function onClaudeClose(jobId: string, job: JobState, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  flushPartialStreams(job);

  const evaluation = await evaluateJob(job, code, signal);

  let report: ReasoningReport | undefined;
  if (job.reasoningEnabled) {
    const prevReport = job.lastReport;
    report = assess(evaluation.signals);
    job.lastReport = report;

    appendLog(
      job,
      `[reasoning] gate=${report.decision} belief=${report.belief} difficulty=${report.difficulty} ` +
        `halted=${report.halted_reason} blockers=[${report.blockers.join("; ")}]`
    );

    if (DIGEST_BEFORE_REVISE) {
      await maybeDigestFailure(job, evaluation, report);
    }

    const canRevise =
      !job.seenBlockerSigs.has([...report.blockers].sort().join("|")) &&
      job.autoReviseEnabled &&
      report.should_revise &&
      job.revisePass < job.maxRevisePasses &&
      !isStalled(prevReport, report);
    job.seenBlockerSigs.add([...report.blockers].sort().join("|"));

    if (canRevise) {
      job.revisePass += 1;
      const reviseEvidence = job.result.failure_digest ?? failureEvidence(evaluation);
      const revisePrompt = buildRevisePrompt(job.originalPrompt, report, job.revisePass, reviseEvidence);
      // Optimization O6: on a revise pass, if the deterministic difficulty is
      // high and an escalate model is configured, switch this pass to the
      // stronger (pricier) model. First passes always run on the cheap default,
      // so we only pay for the strong model when a task actually proves hard.
      const escalateModel = process.env.WORKER_ESCALATE_MODEL?.trim();
      const escalateThreshold = Number(process.env.WORKER_ESCALATE_DIFFICULTY) || 0.6;
      const reviseModel =
        escalateModel && report.difficulty >= escalateThreshold ? escalateModel : job.launchInput.model;
      if (reviseModel !== job.launchInput.model) {
        appendLog(job, `[revise] escalating model to ${reviseModel} (difficulty=${report.difficulty.toFixed(2)})`);
      }
      const reviseInput: StartJobInput = { ...job.launchInput, prompt: revisePrompt, model: reviseModel };
      appendLog(job, `[revise] launching pass ${job.revisePass}/${job.maxRevisePasses} to fix: ${report.required_changes.join(" | ")}`);
      try {
        const launch = await buildLaunchPlan(reviseInput, job.additionalDirs);
        if (spawnClaude(jobId, job, launch)) {
          return; // stay running; the next close re-enters this handler
        }
      } catch (error: any) {
        appendLog(job, `[revise] relaunch failed, finalizing: ${error?.message || String(error)}`);
      }
    } else if (job.autoReviseEnabled && report.should_revise && isStalled(prevReport, report)) {
      appendLog(job, "[revise] stalled: blocker count did not improve, stopping (needs new evidence, not more passes)");
    }
  }

  if (!DIGEST_BEFORE_REVISE) {
    await maybeDigestFailure(job, evaluation, report);
  }

  if (evaluation.finalStatus === "failed") {
    job.stageResults.push(currentStageResult(job, evaluation));
  }

  if (await maybeAdvanceStage(jobId, job, evaluation)) {
    return;
  }

  if (job.stages?.length && !job.stageResults.some((item) => item.index === job.stageIndex)) {
    job.stageResults.push(currentStageResult(job, evaluation));
  }

  finalizeResult(jobId, job, evaluation, report, code, signal);
}

function registerProcessHandlers(jobId: string, job: JobState, child: ReturnType<typeof spawn>): void {
  child.stdout?.on("data", (data) => {
    parseStreamJSON(job, data.toString("utf8"));
  });

  child.stderr?.on("data", (data) => {
    appendStderrChunk(job, data.toString("utf8"));
  });

  child.once("error", (error) => {
    setTerminalStatus(jobId, job, "failed", { error: error.message });
  });

  child.once("close", (code, signal) => {
    if (job.status === "cancelled") return;
    onClaudeClose(jobId, job, code, signal).catch((error: any) => {
      setTerminalStatus(jobId, job, "failed", {
        exitCode: code,
        signal,
        error: error.message || String(error)
      });
    });
  });
}

async function startJob(args: Record<string, unknown>) {
  if (runningJobCount() >= MAX_RUNNING_JOBS) {
    return okJson(toolFailureJson("start", "implementation", args, `Too many running jobs. Limit is ${MAX_RUNNING_JOBS}.`));
  }

  const input = toStartInput(args);
  const [targetDir, ...additionalDirs] = input.allowed_dirs;
  const scopedPatch = validateScopedPatch(input.scoped_patch, targetDir);
  if (scopedPatch) {
    input.scoped_patch = { paths: scopedPatch.relativePaths, max_diff_bytes: scopedPatch.maxDiffBytes };
  }

  const launch = await buildLaunchPlan(input, additionalDirs);

  const reasoningEnabled = input.reasoning ?? REASONING_ENABLED;
  const autoReviseEnabled = (input.auto_revise ?? AUTO_REVISE_ENABLED) && reasoningEnabled;
  const maxRevisePasses = Math.max(0, Math.min(4, input.max_revise_passes ?? MAX_REVISE_PASSES));

  const jobId = crypto.randomUUID();

  // Optimization O8: optional git worktree isolation. With WORKER_ISOLATION=worktree,
  // each job runs in its own detached checkout of the repo so multiple jobs can edit
  // the same repository in parallel without their git diffs colliding. Any problem
  // (not a git repo, worktree creation fails) falls back to running in place.
  let effectiveCwd = targetDir;
  let worktree: WorktreeHandle | undefined;
  if ((process.env.WORKER_ISOLATION || "inplace").toLowerCase() === "worktree") {
    const repoRoot = findGitRoot(targetDir);
    if (repoRoot) {
      const base = process.env.WORKER_WORKTREE_DIR?.trim() || path.join(SANDBOX_ROOT, ".worker-worktrees");
      try {
        fs.mkdirSync(base, { recursive: true });
        worktree = createWorktree(repoRoot, base, jobId);
      } catch {
        worktree = undefined;
      }
      if (worktree) effectiveCwd = worktree.path;
    }
  }

  const preexistingChangedFiles = collectChangedFiles(effectiveCwd, scopedPatch);
  const reliabilityProfile = buildReliabilityProfile(input, { worktree: Boolean(worktree) });
  const job = createJobState(
    jobId,
    launch.command,
    launch.args,
    effectiveCwd,
    launch.model,
    input.allowed_dirs,
    scopedPatch,
    input.checks || [],
    preexistingChangedFiles,
    {
      originalPrompt: input.prompt,
      additionalDirs,
      launchInput: input,
      reasoningEnabled,
      autoReviseEnabled,
      maxRevisePasses,
      reliabilityProfile,
      stages: input.stages
    }
  );
  if (worktree) {
    job.worktreeRepo = worktree.repo;
    job.worktreePath = worktree.path;
    job.worktreeBranch = worktree.branch;
  }
  jobs.set(jobId, job);
  if (worktree) {
    appendLog(job, `[start] worktree isolation: ${worktree.path} (branch ${worktree.branch})`);
  }

  appendLog(job, `[start] launching Claude Code in ${targetDir}`);
  appendLog(job, `[start] model=${launch.model}, claude_cli_model=${launch.cliModel}, permission_mode=${input.permission_mode || "acceptEdits"}, additional_dirs=${additionalDirs.length}`);
  appendLog(job, `[start] reasoning=${reasoningEnabled}, auto_revise=${autoReviseEnabled}, max_revise_passes=${maxRevisePasses}`);
  appendLog(
    job,
    `[reliability] tier=${reliabilityProfile.tier}, policy=${reliabilityProfile.blocking_policy}, ` +
      `semantic_gate=${reliabilityProfile.semantic_gate}, missing=[${reliabilityProfile.missing_gates.join(", ")}], ` +
      `blocking_risk=${reliabilityProfile.blocking_risk}`
  );
  for (const warning of reliabilityProfile.warnings) appendLog(job, `[reliability][warn] ${warning}`);
  if (input.stages?.length) {
    appendLog(job, `[start] stages=${input.stages.length}, current=1/${input.stages.length}`);
  }
  if (shouldUseOpenAIAdapter()) {
    appendLog(job, `[start] using local Anthropic->OpenAI adapter at ${launch.env.ANTHROPIC_BASE_URL}`);
  }
  if (scopedPatch?.relativePaths.length) {
    appendLog(job, `[start] scoped_patch=${scopedPatch.relativePaths.join(", ")}`);
  }

  if (!spawnClaude(jobId, job, launch)) {
    const payload = { job_id: jobId, status: job.status, error: job.result.error };
    return okJson(
      attachReceipt(payload, {
        tool: "start",
        category: "implementation",
        input: args,
        output: payload,
        status: "error"
      })
    );
  }

  const payload = {
    job_id: jobId,
    pid: job.pid,
    status: job.status,
    cwd: job.cwd,
    model: job.model,
    server_version: SERVER_VERSION,
    reliability: reliabilityProfile
  };
  return okJson(
    attachReceipt(payload, {
      tool: "start",
      category: "implementation",
      input: args,
      output: payload
    })
  );
}

async function waitJob(args: Record<string, unknown>) {
  const jobId = String(args.job_id || "");
  const job = jobs.get(jobId);
  if (!job) return { error: "Job not found" };

  const timeoutMs = parseWaitTimeout(args.timeout_ms);
  const deadline = Date.now() + timeoutMs;

  while (job.status === "running") {
    if (Date.now() >= deadline) {
      return { error: `wait timeout after ${timeoutMs}ms; job is still running` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return publicJob(job, undefined, parseOptionalBoolean(args.verbose) ?? false, "wait");
}

export function createCodexWorkerServer(): Server {
  const server = new Server(
    { name: "codex-async-worker", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "start",
        description:
          "Start an asynchronous Claude Code job inside SANDBOX_ROOT. A deterministic Mythos-style reasoning layer verifies the result (checks, scope, exit, calibration) and can auto-revise on concrete failures.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            allowed_dirs: { type: "array", items: { type: "string" } },
            model: { type: "string" },
            permission_mode: { type: "string", enum: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"] },
            allowed_tools: { type: "array", items: { type: "string" } },
            disallowed_tools: { type: "array", items: { type: "string" } },
            scoped_patch: {
              type: "object",
              properties: {
                paths: { type: "array", items: { type: "string" } },
                max_diff_bytes: { type: "number" }
              }
            },
            checks: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      command: { type: "string" },
                      timeout_ms: { type: "number" }
                    },
                    required: ["command"]
                  }
                ]
              }
            },
            effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
            max_turns: { type: "number" },
            include_partial_messages: { type: "boolean" },
            include_diff: { type: "boolean", description: "When false, keep collecting diff internally but omit it from get/wait/cancel responses." },
            bare: { type: "boolean" },
            reasoning: { type: "boolean", description: "Attach the deterministic reasoning report (default from MYTHOS_REASONING)." },
            auto_revise: { type: "boolean", description: "Auto-retry Claude Code on concrete failures (default from MYTHOS_AUTO_REVISE)." },
            max_revise_passes: { type: "number", description: "Max automatic revise passes, 0-4 (default from MYTHOS_MAX_REVISE_PASSES)." },
            reliability_tier: {
              type: "string",
              enum: ["lite", "standard", "strict", "critical"],
              description: "Optional reliability profile. Defaults to WORKER_RELIABILITY_TIER or standard."
            },
            blocking_policy: {
              type: "string",
              enum: ["observe", "warn", "enforce"],
              description: "Whether missing reliability gates are observed, warned, or rejected. Defaults to observe."
            },
            semantic_gate: {
              type: "string",
              enum: ["off", "warn", "required"],
              description: "Declare semantic review expectations for high-risk jobs without running an extra model by default."
            },
            tool_budget: { type: "number", description: "Optional advisory maximum tool-call budget recorded in metrics." },
            episode: { type: "boolean", description: "When false, omit compact episode summaries from job responses." },
            stages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  prompt: { type: "string" },
                  checks: {
                    type: "array",
                    items: {
                      anyOf: [
                        { type: "string" },
                        {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            command: { type: "string" },
                            timeout_ms: { type: "number" }
                          },
                          required: ["command"]
                        }
                      ]
                    }
                  },
                  scoped_patch: {
                    type: "object",
                    properties: {
                      paths: { type: "array", items: { type: "string" } },
                      max_diff_bytes: { type: "number" }
                    }
                  }
                },
                required: ["prompt"]
              }
            }
          },
          required: ["allowed_dirs"]
        }
      },
      {
        name: "get",
        description: "Get job status and structured result",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" }, verbose: { type: "boolean" } },
          required: ["job_id"]
        }
      },
      {
        name: "get_artifact_slice",
        description:
          "Read a bounded redacted slice from a worker artifact returned by a receipt. Artifact refs are opaque and local to this worker process.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_ref: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" }
          },
          required: ["artifact_ref"]
        }
      },
      {
        name: "tail",
        description: "Read the latest job log lines",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" }, lines: { type: "number" } },
          required: ["job_id"]
        }
      },
      {
        name: "wait",
        description: "Wait for a job to finish with a timeout. Timeout returns without killing the worker.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" }, timeout_ms: { type: "number" }, verbose: { type: "boolean" } },
          required: ["job_id"]
        }
      },
      {
        name: "cancel",
        description: "Cancel a running job and kill its process tree",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string" } },
          required: ["job_id"]
        }
      },
      {
        name: "analyze",
        description:
          "Read-only analysis: read the given files (inside SANDBOX_ROOT) and answer in a single cheap-gateway call. Does NOT start Claude Code and does NOT modify any file. Use for summarize/explain/classify; use start for anything that edits or runs.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            max_tokens: { type: "number" }
          },
          required: ["prompt"]
        }
      },
      {
        name: "review",
        description:
          "Cheap-gateway code review. Use job_id to review a finished worker diff/checks, or files to review selected sandbox files. Returns structured JSON verdict when parseable.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            focus: { type: "string" },
            max_tokens: { type: "number" }
          }
        }
      },
      {
        name: "search",
        description:
          "Zero-LLM repository search using rg when available. dirs may contain sandbox directories or files; returns bounded file/line matches inside SANDBOX_ROOT.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            dirs: { type: "array", items: { type: "string" } },
            glob: { type: "string" },
            max_results: { type: "number" },
            mode: { type: "string", enum: ["lines", "files", "count"] }
          },
          required: ["pattern"]
        }
      },
      {
        name: "read_pack",
        description:
          "Zero-LLM context packing for file-reading tasks. Returns bounded symbol/keyword slices instead of whole files.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string" },
            prompt: { type: "string" },
            paths: { type: "array", items: { type: "string" } },
            base_dir: { type: "string" },
            max_files: { type: "number" },
            max_bytes_per_file: { type: "number" },
            window_lines: { type: "number" }
          },
          required: ["paths"]
        }
      },
      {
        name: "diff_digest",
        description:
          "Digest the current git diff into changed files, file-level risk, hunk headers, and optional cheap red-team review.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            max_diff_bytes: { type: "number" },
            red_team: { type: "boolean" },
            lite_review: { type: "boolean" }
          }
        }
      },
      {
        name: "shell",
        description:
          "Run a bounded worker-side command inside SANDBOX_ROOT. Use digest:true for tests/builds/lint so Codex receives a compact failure summary.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            command: { type: "string" },
            timeout_ms: { type: "number" },
            digest: { type: "boolean" },
            allow_destructive: { type: "boolean" }
          },
          required: ["command"]
        }
      },
      {
        name: "apply_edits",
        description:
          "Zero-LLM mechanical edits: bounded literal or regex replacements inside SANDBOX_ROOT. Returns changed files and replacement counts.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file: { type: "string" },
                  search: { type: "string" },
                  replace: { type: "string" },
                  regex: { type: "boolean" },
                  flags: { type: "string" },
                  expected_replacements: { type: "number" }
                },
                required: ["file", "search", "replace"]
              }
            }
          },
          required: ["edits"]
        }
      },
      {
        name: "history",
        description:
          "Git archaeology for a file or line: returns bounded log timeline and optional blame without making Codex ingest git log -p.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            file: { type: "string" },
            line: { type: "number" },
            max_commits: { type: "number" }
          },
          required: ["file"]
        }
      },
      {
        name: "draft",
        description:
          "Draft commit messages, PR descriptions, changelog notes, or release notes from the current diff using the cheap review lane.",
        inputSchema: {
          type: "object",
          properties: {
            cwd: { type: "string" },
            kind: { type: "string" },
            max_diff_bytes: { type: "number" },
            max_tokens: { type: "number" }
          }
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;
    let metricStatus: "ok" | "error" | "rejected" = "ok";
    let metricExtra: Record<string, unknown> = {};

    function mergeMetricStatus(status: ToolMetricStatus): void {
      if (status === "error") {
        metricStatus = "error";
        return;
      }
      if (status === "rejected" && metricStatus !== "error") metricStatus = "rejected";
    }

    function rememberReceipt(value: unknown): void {
      const metric = workerMetricStatusFromPayload(value);
      mergeMetricStatus(metric.status);
      metricExtra = { ...metricExtra, ...metric.extra };
    }

    function fail(tool: string, category: string, error: unknown) {
      metricStatus = "error";
      metricExtra = { ...metricExtra, ...compactMetricError(error) };
      const failure = toolFailureJson(tool, category, toolArgs, error);
      rememberReceipt(failure);
      return okJson(failure);
    }

    function reject(
      tool: string,
      category: WorkerCategory,
      reason: string,
      requiredAction: string,
      alternatives: string[] = ["start"]
    ) {
      const rejection = rejectedJson(tool, category, toolArgs, reason, requiredAction, alternatives);
      rememberReceipt(rejection);
      return okJson(rejection);
    }

    try {
      const requestCategory = TOOL_CATEGORIES[name];
      if (requestCategory) {
        const decision = getToolControlDecision(String(name), requestCategory);
        if (decision) {
          recordToolControlIntercept(decision);
          metricExtra = {
            ...metricExtra,
            tool_control_action: decision.action,
            tool_control_reason: decision.reason,
            tool_control_error_class: decision.errorClass,
            tool_control_circuit_key: decision.circuitKey,
            tool_control_expires_at: decision.expiresAt
          };
          if (decision.action === "degrade") {
            const degraded = await degradedByToolControl(String(name), requestCategory, toolArgs, decision);
            rememberReceipt(degraded);
            return okJson(degraded);
          }
          return reject(String(name), requestCategory, decision.reason, decision.requiredAction, decision.alternatives);
        }
      }

      if (name === "start") {
        const rejection = preflightStartRejection(toolArgs);
        if (rejection) {
          metricStatus = "rejected";
          rememberReceipt(rejection);
          return okJson(rejection);
        }
        const result = await startJob(toolArgs);
        rememberReceipt(result);
        return result;
      }

      if (name === "get") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) {
          return reject(
            "get",
            "job_control",
            "Job not found",
            "Use the job_id returned by start in this worker process; if it expired, rerun start and poll the new job_id.",
            ["start", "wait", "tail"]
          );
        }
        const result = publicJob(job, undefined, parseOptionalBoolean(toolArgs.verbose) ?? false, "get");
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "get_artifact_slice") {
        const result = getArtifactSlice(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "tail") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) {
          return reject(
            "tail",
            "job_control",
            "Job not found",
            "Use the current job_id returned by start before requesting log tail; if missing, rerun start.",
            ["start", "get", "wait"]
          );
        }
        const lines = parseLines(toolArgs.lines);
        return textResponse(job.logBuffer.slice(-lines).join("\n"));
      }

      if (name === "wait") {
        const result = await waitJob(toolArgs);
        if ("error" in result) {
          const error = String(result.error);
          return reject(
            "wait",
            "job_control",
            error,
            /still running/i.test(error)
              ? "Call wait again with a longer timeout_ms, or use get/tail while the job is still running."
              : "Use the job_id returned by start in this worker process; if it expired, rerun start and poll the new job_id.",
            /still running/i.test(error) ? ["wait", "get", "tail"] : ["start", "get", "tail"]
          );
        }
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "analyze") {
        const prompt = typeof toolArgs.prompt === "string" ? toolArgs.prompt : "";
        if (!prompt.trim()) {
          return reject("analyze", "analysis", "prompt is required", "Provide a non-empty prompt, or use read_pack for zero-LLM file context first.", [
            "read_pack"
          ]);
        }
        const files = Array.isArray(toolArgs.files) ? toolArgs.files.map(String) : [];
        const maxTokens = typeof toolArgs.max_tokens === "number" ? toolArgs.max_tokens : undefined;
        const answer = await analyzeDirect(prompt, files, maxTokens);
        return textResponse(answer);
      }

      if (name === "review") {
        const jobId = typeof toolArgs.job_id === "string" ? toolArgs.job_id : "";
        const job = jobId ? jobs.get(jobId) : undefined;
        if (jobId && !job) {
          return reject(
            "review",
            "review",
            "Job not found or expired",
            "Pass files for review, rerun diff_digest, or rerun start and review the new job_id.",
            ["diff_digest", "read_pack", "start"]
          );
        }
        const files = Array.isArray(toolArgs.files) ? toolArgs.files.map(String) : [];
        if (!job && files.length === 0) {
          return reject("review", "review", "review requires job_id or files", "Pass either a valid job_id or a non-empty files list.", [
            "diff_digest",
            "read_pack"
          ]);
        }
        const fileReview = job ? { diff: undefined, files: [] } : reviewDiffForFiles(files);
        const raw = await reviewDirect({
          diff: job?.result.diff ?? fileReview.diff,
          checks: job?.result.checks,
          files: fileReview.files,
          focus: typeof toolArgs.focus === "string" ? toolArgs.focus : undefined,
          maxTokens: typeof toolArgs.max_tokens === "number" ? toolArgs.max_tokens : undefined
        });
        try {
          const result = attachReceipt(JSON.parse(raw), {
            tool: "review",
            category: "review",
            input: toolArgs,
            output: raw
          });
          rememberReceipt(result);
          return okJson(result);
        } catch {
          const result = attachReceipt(
            { verdict: "unparsed", issues: [], summary: raw },
            {
              tool: "review",
              category: "review",
              input: toolArgs,
              output: raw
            }
          );
          rememberReceipt(result);
          return okJson(result);
        }
      }

      if (name === "search") {
        const pattern = typeof toolArgs.pattern === "string" ? toolArgs.pattern : "";
        const dirs = validateSearchPaths(toolArgs.dirs);
        const searchResult = searchWorkspace({
            pattern,
            dirs,
            glob: typeof toolArgs.glob === "string" ? toolArgs.glob : undefined,
            max_results: typeof toolArgs.max_results === "number" ? toolArgs.max_results : undefined,
            mode:
              toolArgs.mode === "files" || toolArgs.mode === "count" || toolArgs.mode === "lines"
                ? toolArgs.mode
                : undefined
          });
        const result = attachReceipt({ ...searchResult }, { tool: "search", category: "search", input: toolArgs, output: searchResult });
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "read_pack") {
        const result = buildContextPack(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "diff_digest") {
        const result = await digestDiff(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "shell") {
        const result = await runWorkerShell(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "apply_edits") {
        const result = applyMechanicalEdits(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "history") {
        const result = gitHistory(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "draft") {
        const result = await draftFromChanges(toolArgs);
        rememberReceipt(result);
        return okJson(result);
      }

      if (name === "cancel") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) {
          return reject(
            "cancel",
            "job_control",
            "Job not found",
            "Use the current running job_id returned by start; if the job already expired, no cancel action is needed.",
            ["get", "tail", "start"]
          );
        }
        if (isTerminalStatus(job.status)) {
          const result = publicJob(job, undefined, false, "cancel");
          rememberReceipt(result);
          return okJson(result);
        }
        await killProcessTree(job.pid);
        setTerminalStatus(String(toolArgs.job_id), job, "cancelled");
        const result = publicJob(job, undefined, false, "cancel");
        rememberReceipt(result);
        return okJson(result);
      }

      return fail(String(name || "unknown"), "unknown", `Tool not found: ${name}`);
    } catch (error: any) {
      const category = TOOL_CATEGORIES[name];
      const compact = compactMetricError(error);
      if (category && isRejectableInputError(compact.error_message)) {
        const fallback = fallbackForTool(String(name || "unknown"), compact.error_message);
        return reject(String(name || "unknown"), category, compact.error_message, String(fallback.action), fallback.alternatives as string[]);
      }
      metricStatus = "error";
      metricExtra = compact;
      const failureCategory = TOOL_CATEGORIES[name] || "unknown";
      const failure = toolFailureJson(String(name || "unknown"), failureCategory, toolArgs, error);
      rememberReceipt(failure);
      return okJson(failure);
    } finally {
      const category = TOOL_CATEGORIES[name];
      if (category) {
        const reliabilityExtra =
          name === "start"
            ? reliabilityMetricExtra(buildReliabilityProfile({ ...toolArgs, ...normalizeReliabilityArgs(toolArgs) } as Partial<StartJobInput>))
            : {};
        const controlOutcome = recordToolControlOutcome(name, category, metricStatus, metricExtra);
        appendToolMetric(name, category, metricStatus, {
          ...reliabilityExtra,
          ...metricExtra,
          ...(controlOutcome.errorClass ? { tool_error_class: controlOutcome.errorClass } : {}),
          ...(controlOutcome.circuitOpened ? { circuit_opened: true } : {}),
          ...(name === "diff_digest" ? { red_team: toolArgs.red_team === true || toolArgs.lite_review === true } : {})
        });
      }
    }
  });

  return server;
}
