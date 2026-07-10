import assert from "node:assert/strict";
import {
  assertOutcomeTransition,
  canTransitionOutcome,
  createCancelledOutcome,
  createFailedOutcome,
  createRejectedOutcome,
  createRunningOutcome,
  isTerminalOutcomeStatus,
  resolveOutcome,
  type ResolveOutcomeInputV1,
  type SemanticReviewEvidenceV1
} from "../outcome.js";

const cleanReview: SemanticReviewEvidenceV1 = {
  model: "reviewer-v1",
  verdict: "approve",
  issues: [],
  duration_ms: 17,
  evidence_complete: true
};

function modifyingInput(overrides: Partial<ResolveOutcomeInputV1> = {}): ResolveOutcomeInputV1 {
  return {
    verification_policy: { version: 1, task_kind: "modifying" },
    semantic_gate: "off",
    executor_status: "passed",
    scope_status: "passed",
    checks_status: "passed",
    changed_files: ["src/example.ts"],
    checks: [{ command: "npm test", exit_code: 0, duration_ms: 25 }],
    semantic_review_status: "not_requested",
    artifact_refs: [],
    evidence_complete: true,
    evidence_truncated: false,
    ...overrides
  };
}

function readOnlyInput(overrides: Partial<ResolveOutcomeInputV1> = {}): ResolveOutcomeInputV1 {
  return {
    verification_policy: { version: 1, task_kind: "read_only" },
    semantic_gate: "off",
    executor_status: "passed",
    scope_status: "passed",
    checks_status: "missing",
    changed_files: [],
    checks: [],
    semantic_review_status: "not_requested",
    artifact_refs: [],
    evidence_complete: true,
    evidence_truncated: false,
    ...overrides
  };
}

const accepted = resolveOutcome(modifyingInput());
assert.equal(accepted.status, "accepted");
assert.deepEqual(accepted.reason_codes, ["verification_passed"]);
assert.equal(accepted.retryable, false);
assert.equal(accepted.policy.task_kind, "modifying");
assert.equal(accepted.policy.scope_required, true);
assert.equal(accepted.policy.checks_required, true);
assert.equal(accepted.verification.scope, "passed");
assert.equal(accepted.verification.checks, "passed");
assert.equal(accepted.verification.semantic, "not_required");
assert.equal(accepted.evidence.complete, true);

const readOnlyAccepted = resolveOutcome(readOnlyInput());
assert.equal(readOnlyAccepted.status, "accepted");
assert.equal(readOnlyAccepted.policy.scope_required, false);
assert.equal(readOnlyAccepted.verification.scope, "not_required");
assert.equal(readOnlyAccepted.policy.checks_required, false);
assert.equal(readOnlyAccepted.verification.checks, "not_required");

const noPolicy = resolveOutcome({
  executor_status: "passed",
  changed_files: [],
  checks: [],
  evidence_complete: true
});
assert.equal(noPolicy.status, "needs_evidence");
assert.deepEqual(noPolicy.reason_codes, ["verification_policy_missing"]);
assert.equal(noPolicy.policy.task_kind, "unknown");

const missingScope = resolveOutcome(modifyingInput({ scope_status: "missing" }));
assert.equal(missingScope.status, "needs_evidence");
assert.ok(missingScope.reason_codes.includes("scope_missing"));

const missingChecks = resolveOutcome(modifyingInput({ checks_status: "missing", checks: [] }));
assert.equal(missingChecks.status, "needs_evidence");
assert.ok(missingChecks.reason_codes.includes("checks_missing"));

const missingExpectedChange = resolveOutcome(modifyingInput({ changed_files: [] }));
assert.equal(missingExpectedChange.status, "needs_evidence");
assert.ok(missingExpectedChange.reason_codes.includes("expected_change_missing"));

const processFailed = resolveOutcome(modifyingInput({ executor_status: "failed" }));
assert.equal(processFailed.status, "failed");
assert.deepEqual(processFailed.reason_codes, ["executor_failed"]);

const failedReadOnlyModification = resolveOutcome(
  readOnlyInput({ executor_status: "failed", changed_files: ["src/unexpected.ts"] })
);
assert.equal(failedReadOnlyModification.status, "rejected");
assert.deepEqual(failedReadOnlyModification.reason_codes, ["read_only_modified"]);

const failedScopeViolation = resolveOutcome(modifyingInput({ executor_status: "failed", scope_status: "failed" }));
assert.equal(failedScopeViolation.status, "rejected");
assert.deepEqual(failedScopeViolation.reason_codes, ["scope_violation"]);

const checkFailed = resolveOutcome(
  modifyingInput({
    checks_status: "failed",
    checks: [{ command: "npm test", exit_code: 1, duration_ms: 25 }]
  })
);
assert.equal(checkFailed.status, "failed");
assert.deepEqual(checkFailed.reason_codes, ["check_failed"]);

const readOnlyModified = resolveOutcome(
  readOnlyInput({ changed_files: ["src/unexpected.ts"], scope_status: "failed" })
);
assert.equal(readOnlyModified.status, "rejected");
assert.ok(readOnlyModified.reason_codes.includes("read_only_modified"));

const scopeViolation = resolveOutcome(modifyingInput({ scope_status: "failed" }));
assert.equal(scopeViolation.status, "rejected");
assert.deepEqual(scopeViolation.reason_codes, ["scope_violation"]);

const requiredApproved = resolveOutcome(
  modifyingInput({
    semantic_gate: "required",
    semantic_review_status: "completed",
    semantic_review: cleanReview
  })
);
assert.equal(requiredApproved.status, "accepted");
assert.equal(requiredApproved.verification.semantic, "passed");
assert.deepEqual(requiredApproved.evidence.semantic_review, cleanReview);

const requiredUnavailable = resolveOutcome(
  modifyingInput({ semantic_gate: "required", semantic_review_status: "unavailable" })
);
assert.equal(requiredUnavailable.status, "needs_evidence");
assert.deepEqual(requiredUnavailable.reason_codes, ["semantic_review_unavailable"]);
assert.equal(requiredUnavailable.verification.semantic, "unavailable");

const requiredUnparsed = resolveOutcome(
  modifyingInput({ semantic_gate: "required", semantic_review_status: "unparsed" })
);
assert.equal(requiredUnparsed.status, "needs_evidence");
assert.deepEqual(requiredUnparsed.reason_codes, ["semantic_review_unparsed"]);
assert.equal(requiredUnparsed.verification.semantic, "inconclusive");

const riskyReview = resolveOutcome(
  modifyingInput({
    semantic_gate: "required",
    semantic_review_status: "completed",
    semantic_review: { ...cleanReview, verdict: "risky" }
  })
);
assert.equal(riskyReview.status, "needs_evidence");
assert.deepEqual(riskyReview.reason_codes, ["semantic_review_risky"]);
assert.equal(riskyReview.verification.semantic, "inconclusive");

const changesRequired = resolveOutcome(
  modifyingInput({
    semantic_gate: "required",
    semantic_review_status: "completed",
    semantic_review: { ...cleanReview, verdict: "needs_changes" }
  })
);
assert.equal(changesRequired.status, "rejected");
assert.deepEqual(changesRequired.reason_codes, ["semantic_review_needs_changes"]);
assert.equal(changesRequired.verification.semantic, "failed");

const incompleteReview = resolveOutcome(
  modifyingInput({
    semantic_gate: "required",
    semantic_review_status: "completed",
    semantic_review: { ...cleanReview, evidence_complete: false }
  })
);
assert.equal(incompleteReview.status, "needs_evidence");
assert.deepEqual(incompleteReview.reason_codes, ["semantic_review_incomplete"]);

const contradictoryApproval = resolveOutcome(
  modifyingInput({
    semantic_gate: "required",
    semantic_review_status: "completed",
    semantic_review: {
      ...cleanReview,
      issues: [{ severity: "medium", message: "Behavior is not fully verified." }]
    }
  })
);
assert.equal(contradictoryApproval.status, "needs_evidence");
assert.deepEqual(contradictoryApproval.reason_codes, ["semantic_review_inconsistent"]);

const truncated = resolveOutcome(modifyingInput({ evidence_truncated: true }));
assert.equal(truncated.status, "needs_evidence");
assert.ok(truncated.reason_codes.includes("evidence_truncated"));
assert.equal(truncated.evidence.complete, false);

const evidenceIncomplete = resolveOutcome(modifyingInput({ evidence_complete: false }));
assert.equal(evidenceIncomplete.status, "needs_evidence");
assert.ok(evidenceIncomplete.reason_codes.includes("evidence_incomplete"));

const dirtyBaseline = resolveOutcome(
  modifyingInput({ preexisting_changes_ambiguous: true, evidence_complete: false })
);
assert.equal(dirtyBaseline.status, "needs_evidence");
assert.ok(dirtyBaseline.reason_codes.includes("preexisting_changes_unattributed"));

const incompleteStages = resolveOutcome(
  modifyingInput({ multi_stage_evidence_incomplete: true, evidence_complete: false })
);
assert.equal(incompleteStages.status, "needs_evidence");
assert.ok(incompleteStages.reason_codes.includes("multi_stage_evidence_incomplete"));

const incompleteWorkspace = resolveOutcome(
  modifyingInput({ workspace_evidence_incomplete: true, evidence_complete: false })
);
assert.equal(incompleteWorkspace.status, "needs_evidence");
assert.ok(incompleteWorkspace.reason_codes.includes("workspace_evidence_incomplete"));

const pollingTimeout = resolveOutcome(
  modifyingInput({ executor_status: "running", poll_timed_out: true })
);
assert.equal(pollingTimeout.status, "running");
assert.deepEqual(pollingTimeout.reason_codes, ["executor_running"]);

const jobDeadline = resolveOutcome(
  modifyingInput({ executor_status: "running", job_deadline_exceeded: true })
);
assert.equal(jobDeadline.status, "timed_out");
assert.deepEqual(jobDeadline.reason_codes, ["job_deadline_exceeded"]);

const cancelled = resolveOutcome(modifyingInput({ executor_status: "cancelled" }));
assert.equal(cancelled.status, "cancelled");
assert.deepEqual(cancelled.reason_codes, ["job_cancelled"]);

const warnReviewFailure = resolveOutcome(
  modifyingInput({
    semantic_gate: "warn",
    semantic_review_status: "completed",
    semantic_review: { ...cleanReview, verdict: "needs_changes" }
  })
);
assert.equal(warnReviewFailure.status, "accepted");
assert.equal(warnReviewFailure.verification.semantic, "failed");

const running = createRunningOutcome({ version: 1, task_kind: "modifying" }, "required");
assert.equal(running.status, "running");
assert.equal(running.policy.checks_required, true);
assert.equal(running.verification.semantic, "pending");

const helperFailure = createFailedOutcome("adapter_failed");
assert.equal(helperFailure.status, "failed");
assert.deepEqual(helperFailure.reason_codes, ["adapter_failed"]);

const helperRejection = createRejectedOutcome("unsafe_request");
assert.equal(helperRejection.status, "rejected");
assert.equal(helperRejection.retryable, false);

const helperCancellation = createCancelledOutcome(running);
assert.equal(helperCancellation.status, "cancelled");
assert.deepEqual(helperCancellation.reason_codes, ["job_cancelled"]);
assert.equal(helperCancellation.policy.task_kind, "modifying");
assert.notEqual(helperCancellation.evidence, running.evidence);
assert.throws(() => createCancelledOutcome(accepted), /Illegal Outcome transition/);

assert.equal(isTerminalOutcomeStatus("running"), false);
for (const status of ["accepted", "needs_evidence", "failed", "rejected", "cancelled", "timed_out"] as const) {
  assert.equal(isTerminalOutcomeStatus(status), true);
  assert.equal(canTransitionOutcome(status, status), true);
  assert.equal(canTransitionOutcome(status, "running"), false);
}
assert.equal(canTransitionOutcome("running", "accepted"), true);
assert.equal(canTransitionOutcome("running", "running"), true);
assert.doesNotThrow(() => assertOutcomeTransition("running", "accepted"));
assert.throws(() => assertOutcomeTransition("accepted", "failed"), /Illegal Outcome transition/);

console.log("outcome tests passed");
