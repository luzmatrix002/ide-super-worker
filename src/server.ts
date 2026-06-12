import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureAnthropicOpenAIAdapter, shouldUseOpenAIAdapter } from "./anthropic_openai_adapter.js";
import { analyzeDirect, digestFailure, reviewDirect } from "./lite.js";
import {
  AUTO_REVISE_ENABLED,
  CHECK_OUTPUT_RESPONSE_MAX,
  FAILURE_DIGEST_ENABLED,
  INCLUDE_DIFF_DEFAULT,
  MAX_REVISE_PASSES,
  MAX_RUNNING_JOBS,
  REASONING_ENABLED,
  SANDBOX_ROOT,
  SERVER_VERSION,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS
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
import { killProcessTree } from "./process.js";
import { assess, buildRevisePrompt, isStalled, type JobSignals, type ReasoningReport } from "./reasoning.js";
import { redactSecrets } from "./redact.js";
import { searchWorkspace } from "./search.js";
import { validateAllowedDirs, validateScopedPatch } from "./security.js";
import {
  collectChangedFiles,
  collectWorkspaceSummary,
  createWorktree,
  findGitRoot,
  findOutOfScopeChanges,
  type WorktreeHandle
} from "./workspace.js";
import type { CheckCommand, JobState, StageInput, StageResult, StartJobInput } from "./types.js";

function okJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function textResponse(text: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text: redactSecrets(text) }] };
}

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
    auto_revise: parseOptionalBoolean(args.auto_revise),
    max_revise_passes: typeof args.max_revise_passes === "number" ? args.max_revise_passes : undefined,
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

export function publicJob(job: JobState, includeDiff = job.launchInput.include_diff ?? INCLUDE_DIFF_DEFAULT, verbose = false) {
  const checks = verbose
    ? job.result.checks || []
    : (job.result.checks || []).map((line) => truncateResponseText(line, CHECK_OUTPUT_RESPONSE_MAX));
  const diff = includeDiff ? job.result.diff || "" : "";
  const compact = {
    id: job.id,
    server_version: job.result.server_version || SERVER_VERSION,
    job_status: job.status,
    changed_files: job.result.changed_files || [],
    preexisting_changed_files: job.preexistingChangedFiles || [],
    checks,
    diff,
    reasoning: verbose ? job.result.reasoning : compactReasoning(job.result.reasoning),
    revise_passes: job.result.revise_passes ?? job.revisePass,
    failure_digest: job.result.failure_digest,
    error: job.result.error,
    summary: job.result.result,
    session_id: job.result.session_id,
    duration_ms: job.result.duration_ms,
    total_cost_usd: job.result.total_cost_usd
  };
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
    stage_results: job.stages?.length ? job.stageResults : undefined
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

    const canRevise =
      !job.seenBlockerSigs.has([...report.blockers].sort().join("|")) &&
      job.autoReviseEnabled &&
      report.should_revise &&
      job.revisePass < job.maxRevisePasses &&
      !isStalled(prevReport, report);
    job.seenBlockerSigs.add([...report.blockers].sort().join("|"));

    if (canRevise) {
      job.revisePass += 1;
      const revisePrompt = buildRevisePrompt(job.originalPrompt, report, job.revisePass, failureEvidence(evaluation));
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

  await maybeDigestFailure(job, evaluation, report);

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
    return textResponse(`Too many running jobs. Limit is ${MAX_RUNNING_JOBS}.`, true);
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
    return okJson({ job_id: jobId, status: job.status, error: job.result.error });
  }

  return okJson({ job_id: jobId, pid: job.pid, status: job.status, cwd: job.cwd, model: job.model, server_version: SERVER_VERSION });
}

async function waitJob(args: Record<string, unknown>) {
  const jobId = String(args.job_id || "");
  const job = jobs.get(jobId);
  if (!job) return textResponse("Job not found", true);

  const timeoutMs = parseWaitTimeout(args.timeout_ms);
  const deadline = Date.now() + timeoutMs;

  while (job.status === "running") {
    if (Date.now() >= deadline) {
      return textResponse(`wait timeout after ${timeoutMs}ms; job is still running`, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return okJson(publicJob(job, undefined, parseOptionalBoolean(args.verbose) ?? false));
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
          "Zero-LLM repository search using rg when available. Returns bounded file/line matches inside SANDBOX_ROOT.",
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
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    try {
      if (name === "start") return await startJob(toolArgs);

      if (name === "get") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) return textResponse("Job not found", true);
        return okJson(publicJob(job, undefined, parseOptionalBoolean(toolArgs.verbose) ?? false));
      }

      if (name === "tail") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) return textResponse("Job not found", true);
        const lines = parseLines(toolArgs.lines);
        return textResponse(job.logBuffer.slice(-lines).join("\n"));
      }

      if (name === "wait") return await waitJob(toolArgs);

      if (name === "analyze") {
        const prompt = typeof toolArgs.prompt === "string" ? toolArgs.prompt : "";
        if (!prompt.trim()) return textResponse("prompt is required", true);
        const files = Array.isArray(toolArgs.files) ? toolArgs.files.map(String) : [];
        const maxTokens = typeof toolArgs.max_tokens === "number" ? toolArgs.max_tokens : undefined;
        const answer = await analyzeDirect(prompt, files, maxTokens);
        return textResponse(answer);
      }

      if (name === "review") {
        const jobId = typeof toolArgs.job_id === "string" ? toolArgs.job_id : "";
        const job = jobId ? jobs.get(jobId) : undefined;
        if (jobId && !job) return textResponse("Job not found or expired; re-run with verbose or pass files", true);
        const files = Array.isArray(toolArgs.files) ? toolArgs.files.map(String) : [];
        if (!job && files.length === 0) return textResponse("review requires job_id or files", true);
        const fileReview = job ? { diff: undefined, files: [] } : reviewDiffForFiles(files);
        const raw = await reviewDirect({
          diff: job?.result.diff ?? fileReview.diff,
          checks: job?.result.checks,
          files: fileReview.files,
          focus: typeof toolArgs.focus === "string" ? toolArgs.focus : undefined,
          maxTokens: typeof toolArgs.max_tokens === "number" ? toolArgs.max_tokens : undefined
        });
        try {
          return okJson(JSON.parse(raw));
        } catch {
          return okJson({ verdict: "unparsed", issues: [], summary: raw });
        }
      }

      if (name === "search") {
        const pattern = typeof toolArgs.pattern === "string" ? toolArgs.pattern : "";
        const dirs = validateAllowedDirs(Array.isArray(toolArgs.dirs) && toolArgs.dirs.length ? toolArgs.dirs : [SANDBOX_ROOT]);
        return okJson(
          searchWorkspace({
            pattern,
            dirs,
            glob: typeof toolArgs.glob === "string" ? toolArgs.glob : undefined,
            max_results: typeof toolArgs.max_results === "number" ? toolArgs.max_results : undefined,
            mode:
              toolArgs.mode === "files" || toolArgs.mode === "count" || toolArgs.mode === "lines"
                ? toolArgs.mode
                : undefined
          })
        );
      }

      if (name === "cancel") {
        const job = jobs.get(String(toolArgs.job_id || ""));
        if (!job) return textResponse("Job not found", true);
        if (isTerminalStatus(job.status)) {
          return okJson(publicJob(job));
        }
        await killProcessTree(job.pid);
        setTerminalStatus(String(toolArgs.job_id), job, "cancelled");
        return okJson(publicJob(job));
      }

      return textResponse(`Tool not found: ${name}`, true);
    } catch (error: any) {
      return textResponse(error.message || String(error), true);
    }
  });

  return server;
}
