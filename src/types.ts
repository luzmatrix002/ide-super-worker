import type { ReasoningReport } from "./reasoning.js";
import type { OutcomeV1, VerificationPolicyV1 } from "./outcome.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ReliabilityTier = "lite" | "standard" | "strict" | "critical";

export type BlockingPolicy = "observe" | "warn" | "enforce";

export type SemanticGateMode = "off" | "warn" | "required";

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

export interface StageInput {
  prompt: string;
  checks?: CheckCommand[];
  scoped_patch?: ScopedPatch;
}

export interface StageResult {
  index: number;
  status: JobStatus;
  changed_files: string[];
  checks: string[];
  error?: string;
  failure_digest?: string;
}

export interface ReliabilityProfile {
  tier: ReliabilityTier;
  blocking_policy: BlockingPolicy;
  semantic_gate: SemanticGateMode;
  tool_budget?: number;
  required_gates: string[];
  satisfied_gates: string[];
  missing_gates: string[];
  warnings: string[];
  blocking_risk: "none" | "observe_only" | "would_block";
}

export interface EpisodeSummary {
  job_id: string;
  tier: ReliabilityTier;
  blocking_policy: BlockingPolicy;
  semantic_gate: SemanticGateMode;
  model: string;
  started_at: string;
  ended_at?: string;
  changed_files_count: number;
  check_count: number;
  failed_check_count: number;
  revise_passes: number;
  stage_count: number;
  trajectory_score: number;
  warnings: string[];
  missing_gates: string[];
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
  failure_digest?: string;
  reasoning?: ReasoningReport;
  revise_passes?: number;
  stage_index?: number;
  stage_results?: StageResult[];
  reliability?: ReliabilityProfile;
  episode?: EpisodeSummary;
}

export type AbnormalReasonCode =
  | "schema_error"
  | "missing_artifact"
  | "oversized_summary"
  | "missing_evidence"
  | "failed_check"
  | "main_model_rejected"
  | "review_disagreement";

export type AbnormalVerdict = "accept" | "repair" | "escalate" | "reject";

export interface AbnormalOutputIssue {
  reason_code: AbnormalReasonCode;
  severity: "low" | "medium" | "high";
  note: string;
}

export interface AbnormalReviewerHint {
  required: boolean;
  route: "cheap_review";
  tool: "review";
  reason_code?: AbnormalReasonCode;
  focus: string;
  max_tokens: number;
}

export interface AbnormalOutputAssessment {
  verdict: AbnormalVerdict;
  reason_code?: AbnormalReasonCode;
  confidence: number;
  required_action?: string;
  issues: AbnormalOutputIssue[];
  repair_prompt?: string;
  reviewer?: AbnormalReviewerHint;
}

export interface WorkerReceipt {
  route: string;
  tool: string;
  category: string;
  input_bytes: number;
  output_bytes: number;
  summary_bytes: number;
  artifact_refs: string[];
  truncated: boolean;
  cached: boolean;
  status: "ok" | "error";
  abnormal?: AbnormalOutputAssessment;
}

export interface JobState {
  id: string;
  pid?: number;
  status: JobStatus;
  outcome: OutcomeV1;
  command: string;
  args: string[];
  cwd: string;
  model: string;
  allowedDirs: string[];
  scopedPatch?: ResolvedScopedPatch;
  checks: CheckCommand[];
  /** Frozen 2.5 projection: pre-existing files inside the declared scope. */
  preexistingChangedFiles: string[];
  /** Full baseline used only for Outcome attribution; never projected into legacy fields. */
  outcomeBaselineChangedFiles: string[];
  started_at: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  logBuffer: string[];
  stdoutRemainder: string;
  stderrRemainder: string;
  result: JobResult;
  cleanupTimer?: NodeJS.Timeout;
  resourceAbort?: AbortController;
  resourceRelease?: () => void;
  // --- reasoning / auto-revise loop state ---
  originalPrompt: string;
  additionalDirs: string[];
  launchInput: StartJobInput;
  reasoningEnabled: boolean;
  autoReviseEnabled: boolean;
  maxRevisePasses: number;
  revisePass: number;
  lastReport?: ReasoningReport;
  seenBlockerSigs: Set<string>;
  reliabilityProfile?: ReliabilityProfile;
  // --- multi-stage pipeline (optimization O18) ---
  stages?: StageInput[];
  stageIndex: number;
  stageResults: StageResult[];
  // --- git worktree isolation (optimization O8) ---
  worktreeRepo?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface StartJobInput {
  prompt: string;
  allowed_dirs: string[];
  verification_policy?: VerificationPolicyV1;
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
  stages?: StageInput[];
  reliability_tier?: ReliabilityTier;
  blocking_policy?: BlockingPolicy;
  semantic_gate?: SemanticGateMode;
  tool_budget?: number;
  episode?: boolean;
}
