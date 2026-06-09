import type { ReasoningReport } from "./reasoning.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ScopedPatch {
  paths: string[];
  max_diff_bytes?: number;
}

export interface ResolvedScopedPatch {
  relativePaths: string[];
  absolutePaths: string[];
  maxDiffBytes?: number;
}

export interface CheckCommand {
  name?: string;
  command: string;
  timeout_ms?: number;
}

export interface JobResult {
  server_version?: string;
  job_status?: string;
  changed_files?: string[];
  checks?: string[];
  diff?: string;
  preexisting_changed_files?: string[];
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  error?: string;
  reasoning?: ReasoningReport;
  revise_passes?: number;
}

export interface JobState {
  id: string;
  pid?: number;
  status: JobStatus;
  command: string;
  args: string[];
  cwd: string;
  model: string;
  allowedDirs: string[];
  scopedPatch?: ResolvedScopedPatch;
  checks: CheckCommand[];
  preexistingChangedFiles: string[];
  started_at: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  logBuffer: string[];
  stdoutRemainder: string;
  stderrRemainder: string;
  result: JobResult;
  cleanupTimer?: NodeJS.Timeout;
  // --- reasoning / auto-revise loop state ---
  originalPrompt: string;
  additionalDirs: string[];
  launchInput: StartJobInput;
  reasoningEnabled: boolean;
  autoReviseEnabled: boolean;
  maxRevisePasses: number;
  revisePass: number;
  lastReport?: ReasoningReport;
  // --- git worktree isolation (optimization O8) ---
  worktreeRepo?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface StartJobInput {
  prompt: string;
  allowed_dirs: string[];
  model?: string;
  permission_mode?: PermissionMode;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  scoped_patch?: ScopedPatch;
  checks?: CheckCommand[];
  effort?: EffortLevel;
  max_turns?: number;
  include_partial_messages?: boolean;
  include_diff?: boolean;
  bare?: boolean;
  reasoning?: boolean;
  auto_revise?: boolean;
  max_revise_passes?: number;
}
