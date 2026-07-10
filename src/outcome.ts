export const OUTCOME_STATUSES = [
  "running",
  "accepted",
  "needs_evidence",
  "failed",
  "rejected",
  "cancelled",
  "timed_out"
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export type SemanticGateModeV1 = "off" | "warn" | "required";

export interface VerificationPolicyV1 {
  version: 1;
  task_kind: "read_only" | "modifying";
}

export interface SemanticReviewIssueV1 {
  severity: "low" | "medium" | "high" | "critical";
  path?: string;
  line?: number;
  message: string;
}

export interface SemanticReviewEvidenceV1 {
  model: string;
  verdict: "approve" | "needs_changes" | "risky";
  issues: SemanticReviewIssueV1[];
  duration_ms: number;
  evidence_complete: boolean;
}

export interface OutcomeCheckEvidenceV1 {
  command: string;
  exit_code: number;
  duration_ms: number;
}

export type OutcomeReasonCode =
  | "executor_running"
  | "executor_failed"
  | "job_cancelled"
  | "job_deadline_exceeded"
  | "verification_policy_missing"
  | "expected_change_missing"
  | "preexisting_changes_unattributed"
  | "multi_stage_evidence_incomplete"
  | "workspace_evidence_incomplete"
  | "read_only_modified"
  | "scope_pending"
  | "scope_missing"
  | "scope_violation"
  | "checks_pending"
  | "checks_missing"
  | "check_failed"
  | "semantic_review_pending"
  | "semantic_review_missing"
  | "semantic_review_unavailable"
  | "semantic_review_timed_out"
  | "semantic_review_unparsed"
  | "semantic_review_incomplete"
  | "semantic_review_inconsistent"
  | "semantic_review_risky"
  | "semantic_review_needs_changes"
  | "evidence_incomplete"
  | "evidence_truncated"
  | "verification_passed";

export interface OutcomeV1 {
  status: OutcomeStatus;
  reason_codes: string[];
  retryable: boolean;
  policy: {
    task_kind: "read_only" | "modifying" | "unknown";
    scope_required: boolean;
    checks_required: boolean;
    semantic_gate: SemanticGateModeV1;
  };
  verification: {
    executor: "pending" | "passed" | "failed";
    scope: "not_required" | "pending" | "passed" | "failed" | "missing";
    checks: "not_required" | "pending" | "passed" | "failed" | "missing";
    semantic: "not_required" | "pending" | "passed" | "failed" | "inconclusive" | "unavailable";
  };
  evidence: {
    changed_files: string[];
    checks: OutcomeCheckEvidenceV1[];
    semantic_review?: SemanticReviewEvidenceV1;
    artifact_refs: string[];
    complete: boolean;
    truncated: boolean;
  };
}

export type OutcomeExecutorStatusV1 = "running" | "passed" | "failed" | "cancelled";
export type VerificationStepStatusV1 = "pending" | "passed" | "failed" | "missing";
export type SemanticReviewAttemptStatusV1 =
  | "not_requested"
  | "pending"
  | "completed"
  | "unavailable"
  | "timed_out"
  | "unparsed";

export interface ResolveOutcomeInputV1 {
  verification_policy?: VerificationPolicyV1;
  semantic_gate?: SemanticGateModeV1;
  executor_status: OutcomeExecutorStatusV1;
  scope_status?: VerificationStepStatusV1;
  checks_status?: VerificationStepStatusV1;
  changed_files?: string[];
  checks?: OutcomeCheckEvidenceV1[];
  semantic_review_status?: SemanticReviewAttemptStatusV1;
  semantic_review?: SemanticReviewEvidenceV1;
  artifact_refs?: string[];
  evidence_complete?: boolean;
  evidence_truncated?: boolean;
  /** In-place dirty files cannot be attributed to the executor without a baseline snapshot. */
  preexisting_changes_ambiguous?: boolean;
  /** Outcome v1 does not claim acceptance for pipelines whose prior-stage evidence is incomplete. */
  multi_stage_evidence_incomplete?: boolean;
  /** Git/workspace evidence could not reliably observe file changes. */
  workspace_evidence_incomplete?: boolean;
  /** A wait/poll timeout is observational and never changes the task outcome. */
  poll_timed_out?: boolean;
  /** Only the job-level deadline may produce the `timed_out` terminal outcome. */
  job_deadline_exceeded?: boolean;
}

type VerificationScope = OutcomeV1["verification"]["scope"];
type VerificationChecks = OutcomeV1["verification"]["checks"];
type VerificationSemantic = OutcomeV1["verification"]["semantic"];

interface SemanticResolution {
  verification: VerificationSemantic;
  blockingReason?: OutcomeReasonCode;
  rejectionReason?: OutcomeReasonCode;
}

function policyFields(
  policy: VerificationPolicyV1 | undefined,
  semanticGate: SemanticGateModeV1
): OutcomeV1["policy"] {
  return {
    task_kind: policy?.task_kind ?? "unknown",
    scope_required: policy?.task_kind === "modifying",
    checks_required: policy?.task_kind === "modifying",
    semantic_gate: semanticGate
  };
}

function baseEvidence(input: ResolveOutcomeInputV1): OutcomeV1["evidence"] {
  return {
    changed_files: [...(input.changed_files ?? [])],
    checks: (input.checks ?? []).map((check) => ({ ...check })),
    ...(input.semantic_review ? { semantic_review: cloneSemanticReview(input.semantic_review) } : {}),
    artifact_refs: [...(input.artifact_refs ?? [])],
    complete: input.evidence_complete === true && input.evidence_truncated !== true,
    truncated: input.evidence_truncated === true
  };
}

function cloneSemanticReview(review: SemanticReviewEvidenceV1): SemanticReviewEvidenceV1 {
  return {
    ...review,
    issues: review.issues.map((issue) => ({ ...issue }))
  };
}

function resolveScope(input: ResolveOutcomeInputV1, required: boolean): VerificationScope {
  if (!required) return "not_required";
  return input.scope_status ?? "missing";
}

function resolveChecks(input: ResolveOutcomeInputV1, required: boolean): VerificationChecks {
  const checks = input.checks ?? [];
  if (input.checks_status === "failed" || checks.some((check) => check.exit_code !== 0)) return "failed";
  if (!required) return "not_required";
  if (input.checks_status === "passed" && checks.length > 0) return "passed";
  if (input.checks_status === "pending") return "pending";
  return "missing";
}

function resolveSemantic(input: ResolveOutcomeInputV1, gate: SemanticGateModeV1): SemanticResolution {
  if (gate === "off") return { verification: "not_required" };

  const attempt = input.semantic_review_status ?? "not_requested";
  if (attempt === "pending") {
    return { verification: "pending", blockingReason: "semantic_review_pending" };
  }
  if (attempt === "unavailable") {
    return { verification: "unavailable", blockingReason: "semantic_review_unavailable" };
  }
  if (attempt === "timed_out") {
    return { verification: "unavailable", blockingReason: "semantic_review_timed_out" };
  }
  if (attempt === "unparsed") {
    return { verification: "inconclusive", blockingReason: "semantic_review_unparsed" };
  }
  if (attempt !== "completed" || !input.semantic_review) {
    return { verification: "unavailable", blockingReason: "semantic_review_missing" };
  }

  const review = input.semantic_review;
  if (!review.evidence_complete) {
    return { verification: "inconclusive", blockingReason: "semantic_review_incomplete" };
  }
  if (review.verdict === "risky") {
    return { verification: "inconclusive", blockingReason: "semantic_review_risky" };
  }
  if (review.verdict === "needs_changes") {
    return { verification: "failed", rejectionReason: "semantic_review_needs_changes" };
  }
  if (review.issues.some((issue) => issue.severity !== "low")) {
    return { verification: "inconclusive", blockingReason: "semantic_review_inconsistent" };
  }
  return { verification: "passed" };
}

function retryable(status: OutcomeStatus): boolean {
  return status === "needs_evidence" || status === "failed" || status === "timed_out";
}

function createResolvedOutcome(
  input: ResolveOutcomeInputV1,
  status: OutcomeStatus,
  reasonCodes: OutcomeReasonCode[],
  scope: VerificationScope,
  checks: VerificationChecks,
  semantic: VerificationSemantic
): OutcomeV1 {
  const evidence = baseEvidence(input);
  evidence.complete = status === "accepted" ? true : status === "needs_evidence" || status === "running" ? false : evidence.complete;

  return {
    status,
    reason_codes: reasonCodes,
    retryable: retryable(status),
    policy: policyFields(input.verification_policy, input.semantic_gate ?? "off"),
    verification: {
      executor:
        input.executor_status === "running"
          ? "pending"
          : input.executor_status === "passed"
            ? "passed"
            : "failed",
      scope,
      checks,
      semantic
    },
    evidence
  };
}

export function resolveOutcome(input: ResolveOutcomeInputV1): OutcomeV1 {
  const semanticGate = input.semantic_gate ?? "off";
  const policy = policyFields(input.verification_policy, semanticGate);
  const scope = resolveScope(input, policy.scope_required);
  const checks = resolveChecks(input, policy.checks_required);
  const semantic = resolveSemantic(input, semanticGate);

  if (input.job_deadline_exceeded === true) {
    return createResolvedOutcome(input, "timed_out", ["job_deadline_exceeded"], scope, checks, semantic.verification);
  }
  if (input.executor_status === "running") {
    return createResolvedOutcome(input, "running", ["executor_running"], scope, checks, semantic.verification);
  }
  if (input.executor_status === "cancelled") {
    return createResolvedOutcome(input, "cancelled", ["job_cancelled"], scope, checks, semantic.verification);
  }

  const changedFiles = input.changed_files ?? [];
  if (input.verification_policy?.task_kind === "read_only" && changedFiles.length > 0) {
    const reasons: OutcomeReasonCode[] = ["read_only_modified"];
    if (scope === "failed") reasons.push("scope_violation");
    return createResolvedOutcome(input, "rejected", reasons, scope, checks, semantic.verification);
  }
  if (scope === "failed") {
    return createResolvedOutcome(input, "rejected", ["scope_violation"], scope, checks, semantic.verification);
  }
  if (input.executor_status === "failed") {
    return createResolvedOutcome(input, "failed", ["executor_failed"], scope, checks, semantic.verification);
  }
  if (checks === "failed") {
    return createResolvedOutcome(input, "failed", ["check_failed"], scope, checks, semantic.verification);
  }
  if (semanticGate === "required" && semantic.rejectionReason) {
    return createResolvedOutcome(input, "rejected", [semantic.rejectionReason], scope, checks, semantic.verification);
  }

  const missingReasons: OutcomeReasonCode[] = [];
  if (!input.verification_policy) missingReasons.push("verification_policy_missing");
  if (input.verification_policy?.task_kind === "modifying" && changedFiles.length === 0) {
    missingReasons.push("expected_change_missing");
  }
  if (scope === "pending") missingReasons.push("scope_pending");
  if (scope === "missing") missingReasons.push("scope_missing");
  if (checks === "pending") missingReasons.push("checks_pending");
  if (checks === "missing") missingReasons.push("checks_missing");
  if (semanticGate === "required" && semantic.blockingReason) missingReasons.push(semantic.blockingReason);
  if (input.evidence_truncated === true) missingReasons.push("evidence_truncated");
  if (input.preexisting_changes_ambiguous === true) missingReasons.push("preexisting_changes_unattributed");
  if (input.multi_stage_evidence_incomplete === true) missingReasons.push("multi_stage_evidence_incomplete");
  if (input.workspace_evidence_incomplete === true) missingReasons.push("workspace_evidence_incomplete");
  if (input.evidence_complete !== true) missingReasons.push("evidence_incomplete");

  if (missingReasons.length > 0) {
    return createResolvedOutcome(input, "needs_evidence", missingReasons, scope, checks, semantic.verification);
  }

  return createResolvedOutcome(input, "accepted", ["verification_passed"], scope, checks, semantic.verification);
}

function emptyPolicy(semanticGate: SemanticGateModeV1 = "off"): OutcomeV1["policy"] {
  return policyFields(undefined, semanticGate);
}

export function createRunningOutcome(
  policy: VerificationPolicyV1 | undefined,
  semanticGate: SemanticGateModeV1 = "off",
  reasonCodes: string[] = ["executor_running"]
): OutcomeV1 {
  const fields = policyFields(policy, semanticGate);
  return {
    status: "running",
    reason_codes: [...reasonCodes],
    retryable: false,
    policy: fields,
    verification: {
      executor: "pending",
      scope: fields.scope_required ? "pending" : "not_required",
      checks: fields.checks_required ? "pending" : "not_required",
      semantic: semanticGate === "off" ? "not_required" : "pending"
    },
    evidence: {
      changed_files: [],
      checks: [],
      artifact_refs: [],
      complete: false,
      truncated: false
    }
  };
}

export function createFailedOutcome(reason: string): OutcomeV1 {
  return {
    status: "failed",
    reason_codes: [reason],
    retryable: true,
    policy: emptyPolicy(),
    verification: {
      executor: "failed",
      scope: "not_required",
      checks: "not_required",
      semantic: "not_required"
    },
    evidence: {
      changed_files: [],
      checks: [],
      artifact_refs: [],
      complete: false,
      truncated: false
    }
  };
}

export function createRejectedOutcome(reason: string, isRetryable = false): OutcomeV1 {
  return {
    ...createFailedOutcome(reason),
    status: "rejected",
    retryable: isRetryable
  };
}

export function createCancelledOutcome(existing?: OutcomeV1): OutcomeV1 {
  if (!existing) {
    return {
      ...createFailedOutcome("job_cancelled"),
      status: "cancelled",
      retryable: false
    };
  }
  assertOutcomeTransition(existing.status, "cancelled");
  return {
    ...existing,
    status: "cancelled",
    reason_codes: ["job_cancelled"],
    retryable: false,
    verification: { ...existing.verification, executor: "failed" },
    evidence: {
      ...existing.evidence,
      changed_files: [...existing.evidence.changed_files],
      checks: existing.evidence.checks.map((check) => ({ ...check })),
      ...(existing.evidence.semantic_review
        ? { semantic_review: cloneSemanticReview(existing.evidence.semantic_review) }
        : {}),
      artifact_refs: [...existing.evidence.artifact_refs],
      complete: false
    }
  };
}

export function isTerminalOutcomeStatus(status: OutcomeStatus): boolean {
  return status !== "running";
}

export function canTransitionOutcome(from: OutcomeStatus, to: OutcomeStatus): boolean {
  return from === "running" || from === to;
}

export function assertOutcomeTransition(from: OutcomeStatus, to: OutcomeStatus): void {
  if (!canTransitionOutcome(from, to)) {
    throw new Error(`Illegal Outcome transition: ${from} -> ${to}`);
  }
}
