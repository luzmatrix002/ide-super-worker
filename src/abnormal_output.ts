import type {
  AbnormalOutputAssessment,
  AbnormalOutputIssue,
  AbnormalReasonCode,
  AbnormalReviewerHint,
  WorkerReceipt
} from "./types.js";

type ReceiptForAssessment = Omit<WorkerReceipt, "abnormal">;

export interface AbnormalAssessmentOptions {
  artifactMinBytes?: number;
  summaryMaxBytes?: number;
}

const DEFAULT_ARTIFACT_MIN_BYTES = 32_000;
const DEFAULT_SUMMARY_MAX_BYTES = 16_000;
const ARTIFACT_REQUIRED_CATEGORIES = new Set(["context_pack", "diff_digest", "command_digest", "job_control"]);
const SUMMARY_BOUNDED_CATEGORIES = new Set([
  "analysis",
  "command_digest",
  "context_pack",
  "diff_digest",
  "draft",
  "history",
  "implementation",
  "job_control",
  "mechanical_edit",
  "review",
  "search"
]);

function isFiniteByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function primaryIssue(issues: AbnormalOutputIssue[]): AbnormalOutputIssue | undefined {
  const severityRank = { high: 3, medium: 2, low: 1 } as const;
  return [...issues].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0];
}

function repairPrompt(issue: AbnormalOutputIssue, receipt: ReceiptForAssessment): string {
  const common =
    `Repair worker output for ${receipt.tool}/${receipt.category}. Return the same public payload shape, keep existing fields compatible, and do not add extra model calls.`;
  if (issue.reason_code === "missing_artifact") {
    return `${common} Store the large raw output as an artifact_ref, keep the main response compact, and include the artifact_ref in receipt.artifact_refs.`;
  }
  if (issue.reason_code === "oversized_summary") {
    return `${common} Shorten the main-thread summary under the response budget and move detail behind artifact_ref slices.`;
  }
  if (issue.reason_code === "failed_check") {
    return `${common} Preserve the failed status, include the compact failure evidence, and provide the smallest next repair action.`;
  }
  if (issue.reason_code === "schema_error") {
    return `${common} Rebuild the receipt with valid route, tool, category, byte counts, artifact_refs, truncation, cache, and status fields.`;
  }
  return `${common} Provide concise evidence, a stable reason_code, and a bounded repair action.`;
}

function reviewerHint(issue: AbnormalOutputIssue): AbnormalReviewerHint | undefined {
  if (issue.reason_code !== "failed_check" && issue.reason_code !== "review_disagreement") return undefined;
  return {
    required: true,
    route: "cheap_review",
    tool: "review",
    reason_code: issue.reason_code,
    focus: "Verify the compact evidence and decide whether another repair pass is justified.",
    max_tokens: 512
  };
}

export function assessAbnormalReceipt(
  receipt: ReceiptForAssessment,
  options: AbnormalAssessmentOptions = {}
): AbnormalOutputAssessment {
  const artifactMinBytes = options.artifactMinBytes ?? DEFAULT_ARTIFACT_MIN_BYTES;
  const summaryMaxBytes = options.summaryMaxBytes ?? DEFAULT_SUMMARY_MAX_BYTES;
  const issues: AbnormalOutputIssue[] = [];

  if (
    !receipt.route ||
    !receipt.tool ||
    !receipt.category ||
    !isFiniteByteCount(receipt.input_bytes) ||
    !isFiniteByteCount(receipt.output_bytes) ||
    !isFiniteByteCount(receipt.summary_bytes) ||
    !Array.isArray(receipt.artifact_refs) ||
    (receipt.status !== "ok" && receipt.status !== "error")
  ) {
    issues.push({
      reason_code: "schema_error",
      severity: "high",
      note: "Receipt is missing required contract fields or has invalid byte/status values."
    });
  }

  if (
    ARTIFACT_REQUIRED_CATEGORIES.has(receipt.category) &&
    receipt.output_bytes > artifactMinBytes &&
    receipt.artifact_refs.length === 0
  ) {
    issues.push({
      reason_code: "missing_artifact",
      severity: "high",
      note: `Large ${receipt.category} output must be represented by artifact_refs before it reaches the main thread.`
    });
  }

  if (SUMMARY_BOUNDED_CATEGORIES.has(receipt.category) && receipt.summary_bytes > summaryMaxBytes) {
    issues.push({
      reason_code: "oversized_summary",
      severity: "medium",
      note: `Receipt summary is ${receipt.summary_bytes} bytes, above the ${summaryMaxBytes} byte budget.`
    });
  }

  if (receipt.status === "error") {
    issues.push({
      reason_code: "failed_check",
      severity: "medium",
      note: "Worker reported an error status; return compact evidence and a repair action instead of raw output."
    });
  }

  const issue = primaryIssue(issues);
  if (!issue) {
    return {
      verdict: "accept",
      confidence: 0.97,
      issues: []
    };
  }

  const reviewer = reviewerHint(issue);
  return {
    verdict: issue.reason_code === "schema_error" ? "reject" : "repair",
    reason_code: issue.reason_code,
    confidence: issue.severity === "high" ? 0.96 : 0.94,
    required_action: issue.reason_code === "failed_check" ? "summarize_failure_and_repair" : "repair_payload_contract",
    issues,
    repair_prompt: repairPrompt(issue, receipt),
    ...(reviewer ? { reviewer } : {})
  };
}
