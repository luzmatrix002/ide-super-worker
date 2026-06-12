import { JOB_TTL_MS, LOG_BUFFER_MAX, LOG_LINE_MAX, MAX_STORED_JOBS, RAW_STREAM_MAX, SERVER_VERSION } from "./config.js";
import { redactSecrets } from "./redact.js";
import { removeWorktree } from "./workspace.js";
import type { CheckCommand, JobState, JobStatus, ResolvedScopedPatch, StartJobInput } from "./types.js";

export const jobs = new Map<string, JobState>();

export interface JobReasoningConfig {
  originalPrompt: string;
  additionalDirs: string[];
  launchInput: StartJobInput;
  reasoningEnabled: boolean;
  autoReviseEnabled: boolean;
  maxRevisePasses: number;
  stages?: StartJobInput["stages"];
}

export function createJobState(
  id: string,
  command: string,
  args: string[],
  cwd: string,
  model: string,
  allowedDirs: string[] = [cwd],
  scopedPatch?: ResolvedScopedPatch,
  checks: CheckCommand[] = [],
  preexistingChangedFiles: string[] = [],
  reasoning?: JobReasoningConfig
): JobState {
  return {
    id,
    status: "running",
    command,
    args,
    cwd,
    model,
    allowedDirs,
    scopedPatch,
    checks,
    preexistingChangedFiles,
    started_at: new Date().toISOString(),
    logBuffer: [],
    stdoutRemainder: "",
    stderrRemainder: "",
    originalPrompt: reasoning?.originalPrompt ?? "",
    additionalDirs: reasoning?.additionalDirs ?? [],
    launchInput:
      reasoning?.launchInput ?? ({ prompt: reasoning?.originalPrompt ?? "", allowed_dirs: allowedDirs } as StartJobInput),
    reasoningEnabled: reasoning?.reasoningEnabled ?? false,
    autoReviseEnabled: reasoning?.autoReviseEnabled ?? false,
    maxRevisePasses: reasoning?.maxRevisePasses ?? 0,
    revisePass: 0,
    seenBlockerSigs: new Set<string>(),
    stages: reasoning?.stages,
    stageIndex: 0,
    stageResults: [],
    result: {
      server_version: SERVER_VERSION,
      job_status: "running",
      changed_files: [],
      checks: [],
      diff: ""
    }
  };
}

function truncateLine(line: string): string {
  if (line.length <= LOG_LINE_MAX) return line;
  return `${line.slice(0, LOG_LINE_MAX)}...[truncated ${line.length - LOG_LINE_MAX} chars]`;
}

export function appendLog(job: JobState, line: string): void {
  const safeLine = truncateLine(redactSecrets(line).replace(/\r/g, ""));
  if (!safeLine) return;

  job.logBuffer.push(safeLine);
  if (job.logBuffer.length > LOG_BUFFER_MAX) {
    job.logBuffer.splice(0, job.logBuffer.length - LOG_BUFFER_MAX);
  }
}

function trimRemainder(job: JobState, field: "stdoutRemainder" | "stderrRemainder", label: string): void {
  const value = job[field];
  if (value.length <= RAW_STREAM_MAX) return;

  const dropped = value.length - RAW_STREAM_MAX;
  job[field] = value.slice(-RAW_STREAM_MAX);
  appendLog(job, `[${label}] partial line exceeded ${RAW_STREAM_MAX} chars; dropped ${dropped} leading chars`);
}

function formatClaudeEvent(data: any): string {
  if (data?.type === "assistant" && Array.isArray(data.message?.content)) {
    const text = data.message.content
      .filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text)
      .join("");
    if (text.trim()) return `[assistant] ${text}`;
  }

  if (data?.type === "result" && typeof data.result === "string") {
    return `[result] ${data.result}`;
  }

  if (typeof data?.message === "string") {
    return data.message;
  }

  const type = typeof data?.type === "string" ? data.type : "json";
  return `[event:${type}] ${JSON.stringify(data)}`;
}

function updateResultFromEvent(job: JobState, data: any): void {
  if (!data || typeof data !== "object") return;

  if (data.type === "summary" || data.type === "result") {
    job.result = {
      ...job.result,
      server_version: data.server_version || job.result.server_version,
      job_status: data.status || data.subtype || job.result.job_status,
      changed_files: Array.isArray(data.changed_files) ? data.changed_files : job.result.changed_files,
      checks: Array.isArray(data.checks) ? data.checks : job.result.checks,
      diff: typeof data.diff === "string" ? data.diff : job.result.diff,
      session_id: typeof data.session_id === "string" ? data.session_id : job.result.session_id,
      total_cost_usd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : job.result.total_cost_usd,
      duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : job.result.duration_ms,
      result: typeof data.result === "string" ? data.result : job.result.result
    };
  }
}

export function parseStreamJSON(job: JobState, chunk: string): void {
  job.stdoutRemainder += chunk;
  trimRemainder(job, "stdoutRemainder", "stdout");

  const lines = job.stdoutRemainder.split("\n");
  job.stdoutRemainder = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      updateResultFromEvent(job, data);
      appendLog(job, formatClaudeEvent(data));
    } catch {
      appendLog(job, `[stdout] ${line}`);
    }
  }
}

export function appendStderrChunk(job: JobState, chunk: string): void {
  job.stderrRemainder += chunk;
  trimRemainder(job, "stderrRemainder", "stderr");

  const lines = job.stderrRemainder.split("\n");
  job.stderrRemainder = lines.pop() || "";

  for (const line of lines) {
    if (line.trim()) appendLog(job, `[stderr] ${line}`);
  }
}

export function flushPartialStreams(job: JobState): void {
  if (job.stdoutRemainder.trim()) {
    parseStreamJSON(job, "\n");
  }
  if (job.stderrRemainder.trim()) {
    appendLog(job, `[stderr] ${job.stderrRemainder}`);
    job.stderrRemainder = "";
  }
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function setTerminalStatus(
  jobId: string,
  job: JobState,
  status: Exclude<JobStatus, "running">,
  details: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string } = {}
): void {
  if (isTerminalStatus(job.status) && job.status !== "running") {
    return;
  }

  job.status = status;
  job.ended_at = new Date().toISOString();
  job.exit_code = details.exitCode;
  job.signal = details.signal;

  if (details.error) {
    job.result.error = redactSecrets(details.error);
    job.result.job_status = "failed";
    appendLog(job, `[error] ${details.error}`);
  } else if (!job.result.job_status) {
    job.result.job_status = status;
  }

  // Optimization O8: tear down the isolated worktree (if any) as soon as the job
  // reaches a terminal state. Auto-revise passes do not pass through here, so the
  // worktree survives across revise passes and is only removed when truly done.
  if (job.worktreePath) {
    removeWorktree({ repo: job.worktreeRepo, path: job.worktreePath, branch: job.worktreeBranch });
    job.worktreePath = undefined;
  }

  scheduleJobCleanup(jobId, job);
  pruneStoredJobs();
}

export function scheduleJobCleanup(jobId: string, job: JobState): void {
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }

  job.cleanupTimer = setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS);
  job.cleanupTimer.unref?.();
}

export function pruneStoredJobs(): void {
  if (jobs.size <= MAX_STORED_JOBS) return;

  const terminalJobs = [...jobs.entries()]
    .filter(([, job]) => isTerminalStatus(job.status))
    .sort(([, a], [, b]) => a.started_at.localeCompare(b.started_at));

  for (const [jobId] of terminalJobs) {
    if (jobs.size <= MAX_STORED_JOBS) break;
    jobs.delete(jobId);
  }
}

export function runningJobCount(): number {
  return [...jobs.values()].filter((job) => job.status === "running").length;
}
