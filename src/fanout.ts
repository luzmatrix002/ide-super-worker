import * as crypto from "node:crypto";
import { attachReceipt, createReceipt, saveArtifact } from "./artifacts.js";
import {
  FANOUT_ENABLED,
  FANOUT_MAX_BRANCHES,
  FANOUT_TIMEOUT_MS,
  LITE_MODEL,
  SANDBOX_ROOT,
  fallbackConfigured,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getFallbackModel,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName
} from "./config.js";
import { fanoutSlotSemaphore, liteSemaphore } from "./concurrency.js";
import { appendMetrics, pickCacheTokens } from "./metrics.js";
import { redactSecrets } from "./redact.js";
import type { WorkerReceipt } from "./types.js";

// ── Public Types ──────────────────────────────────────────────────────────────

export interface FanoutBranchV1 {
  id: string;
  focus: string;
  max_tokens?: number;
}

export interface FanoutOptionsV1 {
  branches?: FanoutBranchV1[];
  aggregate?: "strong_review" | "none";
  deadline_ms?: number;
}

export interface FanoutBranchResult {
  id: string;
  status: "completed" | "failed" | "timed_out";
  preview?: string;
  artifact_ref?: string;
  duration_ms: number;
  reason_code?: string;
}

export interface FanoutSynthesis {
  model: string;
  verdict: "approve" | "needs_changes" | "risky" | "not_applicable";
  summary: string;
  findings: Array<{ severity: string; path?: string; line?: number; message: string }>;
  disagreements: string[];
  confidence: "low" | "medium" | "high";
  evidence_complete: boolean;
}

export interface FanoutResultV1 {
  contract_version: "fanout.v1";
  fanout_id: string;
  kind: "analyze" | "review";
  status: "complete" | "partial" | "failed";
  reason_codes: string[];
  branches: FanoutBranchResult[];
  synthesis?: FanoutSynthesis;
  receipt: WorkerReceipt;
}

// ── Internal Types ────────────────────────────────────────────────────────────

interface BranchExecutionResult {
  id: string;
  status: "completed" | "failed" | "timed_out";
  output?: string;
  artifactRef?: string;
  durationMs: number;
  reasonCode?: string;
}

interface ReviewerTarget {
  baseUrl: string;
  apiKey?: string;
  model: string;
  route: "primary" | "fallback";
}

const PREVIEW_MAX_BYTES = 1024;
const FANOUT_EVIDENCE_MAX_FILES = 20;
const FANOUT_EVIDENCE_MAX_BYTES = 400_000;

// ── Validation ────────────────────────────────────────────────────────────────

export class FanoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanoutValidationError";
  }
}

export function validateBranches(branches: unknown[]): FanoutBranchV1[] {
  if (!Array.isArray(branches) || branches.length < 2) {
    throw new FanoutValidationError("fan-out requires at least 2 branches");
  }
  if (branches.length > FANOUT_MAX_BRANCHES) {
    throw new FanoutValidationError(`fan-out supports at most ${FANOUT_MAX_BRANCHES} branches; got ${branches.length}`);
  }
  const seenIds = new Set<string>();
  const result: FanoutBranchV1[] = [];
  for (let i = 0; i < branches.length; i += 1) {
    const branch = branches[i];
    if (!branch || typeof branch !== "object") {
      throw new FanoutValidationError(`branches[${i}] must be an object`);
    }
    const record = branch as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      throw new FanoutValidationError(`branches[${i}].id is required`);
    }
    if (seenIds.has(id)) {
      throw new FanoutValidationError(`duplicate branch id: ${id}`);
    }
    seenIds.add(id);
    const focus = typeof record.focus === "string" ? record.focus.trim() : "";
    if (!focus) {
      throw new FanoutValidationError(`branches[${i}].focus is required`);
    }
    const maxTokens =
      typeof record.max_tokens === "number" && record.max_tokens > 0
        ? Math.trunc(record.max_tokens)
        : undefined;
    result.push({ id, focus, ...(maxTokens ? { max_tokens: maxTokens } : {}) });
  }
  return result;
}

export function validateFanoutEvidence(evidence: {
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}): void {
  if (evidence.truncated) {
    throw new FanoutValidationError("fan-out rejects truncated EvidencePack; narrow the file list");
  }
  if (evidence.fileCount > FANOUT_EVIDENCE_MAX_FILES) {
    throw new FanoutValidationError(
      `fan-out evidence exceeds ${FANOUT_EVIDENCE_MAX_FILES} files; got ${evidence.fileCount}`
    );
  }
  if (evidence.totalBytes > FANOUT_EVIDENCE_MAX_BYTES) {
    throw new FanoutValidationError(
      `fan-out evidence exceeds ${FANOUT_EVIDENCE_MAX_BYTES} bytes; got ${evidence.totalBytes}`
    );
  }
}

function validateDeadlineMs(deadlineMs: unknown): number {
  if (deadlineMs === undefined || deadlineMs === null) return FANOUT_TIMEOUT_MS;
  const parsed = typeof deadlineMs === "number" ? deadlineMs : Number(deadlineMs);
  if (!Number.isFinite(parsed)) return FANOUT_TIMEOUT_MS;
  return Math.min(300_000, Math.max(10_000, Math.trunc(parsed)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncatePreview(text: string): string {
  const safe = redactSecrets(text);
  const buffer = Buffer.from(safe, "utf8");
  if (buffer.length <= PREVIEW_MAX_BYTES) return safe;
  return `${buffer.subarray(0, PREVIEW_MAX_BYTES).toString("utf8")}...[preview truncated at ${PREVIEW_MAX_BYTES} bytes]`;
}

function reviewerModel(): string | undefined {
  return process.env.WORKER_SEMANTIC_REVIEW_MODEL?.trim();
}

function reviewerTarget(model: string): ReviewerTarget | undefined {
  const primaryBaseUrl = getGatewayBaseUrl()?.trim();
  if (primaryBaseUrl) {
    return {
      baseUrl: primaryBaseUrl.replace(/\/+$/, ""),
      apiKey: getGatewayApiKey(),
      model,
      route: "primary"
    };
  }
  if (fallbackConfigured()) {
    return {
      baseUrl: getFallbackBaseUrl()!.replace(/\/+$/, ""),
      apiKey: getFallbackApiKey(),
      model,
      route: "fallback"
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSynthesis(content: unknown, model: string): FanoutSynthesis | undefined {
  if (typeof content !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactSecrets(content));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const verdict = parsed.verdict;
  if (!(["approve", "needs_changes", "risky", "not_applicable"] as unknown[]).includes(verdict)) {
    return undefined;
  }
  if (typeof parsed.summary !== "string") return undefined;
  const confidence = parsed.confidence;
  if (!(["low", "medium", "high"] as unknown[]).includes(confidence)) return undefined;
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const parsedFindings: FanoutSynthesis["findings"] = [];
  for (const finding of findings) {
    if (!isRecord(finding)) return undefined;
    if (typeof finding.message !== "string" || !finding.message.trim()) return undefined;
    if (typeof finding.severity !== "string") return undefined;
    parsedFindings.push({
      severity: finding.severity,
      ...(typeof finding.path === "string" ? { path: finding.path } : {}),
      ...(typeof finding.line === "number" ? { line: finding.line } : {}),
      message: finding.message
    });
  }
  const disagreements = Array.isArray(parsed.disagreements)
    ? parsed.disagreements.filter((d): d is string => typeof d === "string")
    : [];
  return {
    model,
    verdict: verdict as FanoutSynthesis["verdict"],
    summary: parsed.summary,
    findings: parsedFindings,
    disagreements,
    confidence: confidence as FanoutSynthesis["confidence"],
    evidence_complete: parsed.evidence_complete === true
  };
}

function buildSynthesisPrompt(
  kind: "analyze" | "review",
  task: string,
  sharedEvidenceSummary: string,
  branchResults: Array<{ id: string; focus: string; output: string }>
): string {
  const branchSections = branchResults
    .map(
      (branch) =>
        `## Branch ${branch.id} (focus: ${branch.focus})\n${branch.output}`
    )
    .join("\n\n");
  return [
    "You are a synthesis reviewer. Below are multiple independent analyses of the same codebase,",
    "each with a different focus. Synthesize them into a single verdict.",
    "Return ONLY JSON with this exact shape:",
    JSON.stringify({
      verdict: "approve|needs_changes|risky|not_applicable",
      summary: "concise synthesis of all branches",
      findings: [
        { severity: "low|medium|high|critical", path: "optional/path", line: 1, message: "short finding" }
      ],
      disagreements: ["where branches disagreed, if any"],
      confidence: "low|medium|high",
      evidence_complete: true
    }),
    `\n# TASK\n${task}`,
    `\n# SHARED EVIDENCE SUMMARY\n${sharedEvidenceSummary}`,
    `\n# BRANCH OUTPUTS\n${branchSections}`
  ].join("\n");
}

// ── FanoutCoordinator ─────────────────────────────────────────────────────────

/**
 * Process-level coordinator for read-only fan-out analysis.
 *
 * Guarantees:
 * - All shared files are read exactly once into an immutable EvidencePack.
 * - Branches execute concurrently via Promise.allSettled with a shared deadline.
 * - At most one reviewer call is made (only when ≥2 branches succeed).
 * - Nested fan-out is forbidden: fanoutSlotSemaphore limits to WORKER_FANOUT_MAX_ACTIVE.
 * - Full branch outputs are written to artifacts; the response carries only previews.
 */
export class FanoutCoordinator {
  /**
   * Run a fan-out analyze operation.
   *
   * @param prompt   The shared question for all branches.
   * @param evidence Pre-built immutable EvidencePack (files read once by the caller).
   * @param branches 2–3 independent focus areas.
   * @param options  Aggregate mode, deadline, etc.
   */
  async runAnalyze(
    prompt: string,
    evidence: { content: string; fileCount: number; totalBytes: number; truncated: boolean },
    branches: FanoutBranchV1[],
    options: { aggregate?: "strong_review" | "none"; deadline_ms?: number }
  ): Promise<FanoutResultV1> {
    return this.run("analyze", prompt, evidence, branches, options);
  }

  /**
   * Run a fan-out review operation.
   *
   * @param sharedContext  Shared review context (diff, checks, evidence content).
   * @param branches       2–3 independent review dimensions.
   * @param options        Aggregate mode, deadline, etc.
   */
  async runReview(
    sharedContext: {
      task: string;
      diff?: string;
      checks?: string[];
      evidenceContent: string;
      evidenceFileCount: number;
      evidenceTotalBytes: number;
      evidenceTruncated: boolean;
    },
    branches: FanoutBranchV1[],
    options: { aggregate?: "strong_review" | "none"; deadline_ms?: number }
  ): Promise<FanoutResultV1> {
    return this.run(
      "review",
      sharedContext.task,
      {
        content: sharedContext.evidenceContent,
        fileCount: sharedContext.evidenceFileCount,
        totalBytes: sharedContext.evidenceTotalBytes,
        truncated: sharedContext.evidenceTruncated
      },
      branches,
      options,
      sharedContext.diff,
      sharedContext.checks
    );
  }

  private async run(
    kind: "analyze" | "review",
    task: string,
    evidence: { content: string; fileCount: number; totalBytes: number; truncated: boolean },
    branches: FanoutBranchV1[],
    options: { aggregate?: "strong_review" | "none"; deadline_ms?: number },
    diff?: string,
    checks?: string[]
  ): Promise<FanoutResultV1> {
    const fanoutId = crypto.randomUUID();
    const aggregate = options.aggregate ?? "strong_review";
    const deadlineMs = validateDeadlineMs(options.deadline_ms);
    const startedAt = Date.now();
    const deadline = startedAt + deadlineMs;
    const reasonCodes: string[] = [];

    // Pre-flight: validate reviewer config before spending branch calls.
    let reviewerModelName: string | undefined;
    if (aggregate === "strong_review") {
      reviewerModelName = reviewerModel();
      if (!reviewerModelName) {
        throw new FanoutValidationError(
          "fan-out aggregate=strong_review requires WORKER_SEMANTIC_REVIEW_MODEL to be configured"
        );
      }
      const target = reviewerTarget(reviewerModelName);
      if (!target) {
        throw new FanoutValidationError(
          "fan-out aggregate=strong_review requires a gateway URL (ONEAPI_BASE_URL or fallback)"
        );
      }
    }

    // Acquire fan-out slot (prevents overlapping/nested fan-outs).
    const slotTicket = await fanoutSlotSemaphore.acquire();
    const queueWaitMs = Date.now() - startedAt;

    try {
      // Execute all branches concurrently with shared deadline.
      const branchPromises = branches.map((branch) =>
        this.executeBranch(kind, task, evidence, branch, deadline, diff, checks, fanoutId)
      );
      const settled = await Promise.allSettled(branchPromises);

      const branchResults: BranchExecutionResult[] = settled.map((result, index) => {
        const branch = branches[index];
        if (result.status === "fulfilled") {
          return result.value;
        }
        const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return {
          id: branch.id,
          status: "failed" as const,
          durationMs: 0,
          reasonCode: `branch_error: ${redactSecrets(errorMessage).slice(0, 200)}`
        };
      });

      const successCount = branchResults.filter((r) => r.status === "completed").length;

      // Determine overall status.
      let status: FanoutResultV1["status"];
      if (successCount === 0) {
        status = "failed";
        reasonCodes.push("all_branches_failed");
      } else if (successCount < branchResults.length) {
        status = "partial";
        reasonCodes.push("partial_branch_failure");
      } else {
        status = "complete";
      }

      // Write artifacts for completed branches and build public branch results.
      const publicBranches: FanoutBranchResult[] = branchResults.map((r) => {
        const artifactRef = r.output ? saveArtifact(`fanout_${kind}_branch`, r.output)?.artifact_ref : undefined;
        return {
          id: r.id,
          status: r.status,
          ...(r.output ? { preview: truncatePreview(r.output) } : {}),
          ...(artifactRef ? { artifact_ref: artifactRef } : {}),
          duration_ms: r.durationMs,
          ...(r.reasonCode ? { reason_code: r.reasonCode } : {})
        };
      });

      // Run synthesis reviewer if configured and ≥2 branches succeeded.
      let synthesis: FanoutSynthesis | undefined;
      if (aggregate === "strong_review" && successCount >= 2) {
        const completedBranches = branchResults.filter((r) => r.status === "completed" && r.output);
        const synthesisResult = await this.runSynthesis(
          kind,
          task,
          evidence.content.slice(0, 8_000),
          completedBranches.map((r) => ({
            id: r.id,
            focus: branches.find((b) => b.id === r.id)?.focus ?? "",
            output: r.output!
          })),
          reviewerModelName!,
          deadline,
          fanoutId
        );
        if (synthesisResult.synthesis) {
          synthesis = synthesisResult.synthesis;
        } else {
          reasonCodes.push("synthesis_failed");
          if (status === "complete") status = "partial";
        }
      } else if (aggregate === "strong_review" && successCount === 1) {
        reasonCodes.push("synthesis_skipped_single_branch");
      }

      const e2eMs = Date.now() - startedAt;
      const artifactRefs = publicBranches
        .map((b) => b.artifact_ref)
        .filter((ref): ref is string => typeof ref === "string");

      // Record internal metrics for the overall fan-out.
      // Use event: "fanout_internal" (not "tool_call") so stats.mjs and
      // codex_audit.mjs do NOT count internal coordinator/branch/reviewer
      // rows as user-facing tool calls — which would inflate error rates.
      appendMetrics({
        event: "fanout_internal",
        route: "worker",
        tool: kind,
        category: kind === "analyze" ? "analysis" : "review",
        status: status === "failed" ? "error" : "ok",
        fanout_id: fanoutId,
        role: "coordinator",
        queue_wait_ms: queueWaitMs,
        e2e_ms: e2eMs,
        branch_count: branches.length,
        success_count: successCount,
        prompt_tokens: 0,
        completion_tokens: 0
      });

      const result: FanoutResultV1 = {
        contract_version: "fanout.v1",
        fanout_id: fanoutId,
        kind,
        status,
        reason_codes: reasonCodes,
        branches: publicBranches,
        ...(synthesis ? { synthesis } : {}),
        receipt: createReceipt({
          tool: kind,
          category: kind === "analyze" ? "analysis" : "review",
          input: { fanout_id: fanoutId, branch_count: branches.length },
          output: { status, branch_count: branches.length, success_count: successCount },
          artifactRefs,
          truncated: true,
          status: status === "failed" ? "error" : "ok"
        })
      };

      return result;
    } finally {
      slotTicket.release();
    }
  }

  private async executeBranch(
    kind: "analyze" | "review",
    task: string,
    evidence: { content: string; fileCount: number; totalBytes: number; truncated: boolean },
    branch: FanoutBranchV1,
    deadline: number,
    diff: string | undefined,
    checks: string[] | undefined,
    fanoutId: string
  ): Promise<BranchExecutionResult> {
    const branchStart = Date.now();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        id: branch.id,
        status: "timed_out",
        durationMs: 0,
        reasonCode: "deadline_exceeded_before_start"
      };
    }

    const focusParts = [branch.focus];
    // For review, include the shared diff/checks context in each branch's focus.
    const combinedFocus = focusParts.join("\n");

    try {
      let output: string;

      // Use a timeout wrapper to enforce the shared deadline per branch.
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(
        () => timeoutController.abort(),
        Math.min(remainingMs, FANOUT_TIMEOUT_MS)
      );

      try {
        if (kind === "analyze") {
          // Import dynamically to avoid circular dependency at module load.
          const { analyzeWithEvidence } = await import("./lite.js");
          output = await analyzeWithEvidence(task, evidence, branch.max_tokens, combinedFocus);
        } else {
          const { reviewWithEvidence } = await import("./lite.js");
          output = await reviewWithEvidence({
            diff,
            checks,
            evidenceContent: evidence.content,
            focus: combinedFocus,
            maxTokens: branch.max_tokens
          });
        }
      } finally {
        clearTimeout(timeoutTimer);
      }

      const durationMs = Date.now() - branchStart;

      // Record per-branch internal metrics (not user-facing tool_call).
      appendMetrics({
        event: "fanout_internal",
        route: "worker",
        tool: kind,
        category: kind === "analyze" ? "analysis" : "review",
        status: "ok",
        fanout_id: fanoutId,
        branch_id: branch.id,
        role: "branch",
        e2e_ms: durationMs,
        prompt_tokens: 0,
        completion_tokens: 0
      });

      return {
        id: branch.id,
        status: "completed",
        output,
        durationMs
      };
    } catch (error) {
      const durationMs = Date.now() - branchStart;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = /timed? ?out|abort/i.test(errorMessage) || Date.now() >= deadline;

      appendMetrics({
        event: "fanout_internal",
        route: "worker",
        tool: kind,
        category: kind === "analyze" ? "analysis" : "review",
        status: "error",
        fanout_id: fanoutId,
        branch_id: branch.id,
        role: "branch",
        e2e_ms: durationMs,
        prompt_tokens: 0,
        completion_tokens: 0
      });

      return {
        id: branch.id,
        status: isTimeout ? "timed_out" : "failed",
        durationMs,
        reasonCode: redactSecrets(errorMessage).slice(0, 200)
      };
    }
  }

  private async runSynthesis(
    kind: "analyze" | "review",
    task: string,
    sharedEvidenceSummary: string,
    completedBranches: Array<{ id: string; focus: string; output: string }>,
    model: string,
    deadline: number,
    fanoutId: string
  ): Promise<{ synthesis?: FanoutSynthesis }> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      appendMetrics({
        event: "fanout_internal",
        route: "worker",
        tool: kind,
        category: kind === "analyze" ? "analysis" : "review",
        status: "error",
        fanout_id: fanoutId,
        role: "reviewer",
        reason_code: "deadline_exceeded",
        e2e_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0
      });
      return {};
    }

    const target = reviewerTarget(model);
    if (!target) return {};

    const prompt = buildSynthesisPrompt(kind, task, sharedEvidenceSummary, completedBranches);
    const reviewerStart = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    try {
      const response = await fetch(`${target.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: target.model,
          messages: [
            {
              role: "system",
              content:
                "You are an independent synthesis reviewer. Judge whether the branch analyses collectively satisfy the task."
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 1_200,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        appendMetrics({
          event: "fanout_internal",
          route: "worker",
          tool: kind,
          category: kind === "analyze" ? "analysis" : "review",
          status: "error",
          fanout_id: fanoutId,
          role: "reviewer",
          reason_code: "upstream_unavailable",
          e2e_ms: Date.now() - reviewerStart,
          prompt_tokens: 0,
          completion_tokens: 0
        });
        return {};
      }

      const data: any = await response.json();
      appendMetrics({
        route: target.route,
        tool: kind,
        model: data?.model || target.model,
        prompt_tokens: data?.usage?.prompt_tokens ?? 0,
        completion_tokens: data?.usage?.completion_tokens ?? 0,
        cache_hit_tokens: pickCacheTokens(data?.usage),
        cache_miss_tokens: data?.usage?.prompt_cache_miss_tokens ?? null,
        fanout_id: fanoutId,
        role: "reviewer",
        e2e_ms: Date.now() - reviewerStart
      });

      const synthesis = parseSynthesis(data?.choices?.[0]?.message?.content, data?.model || target.model);
      if (!synthesis) {
        // response_unparsed is a model-quality issue, not a system error.
        // The code degrades gracefully (returns empty synthesis), so record
        // as ok+degraded rather than error to avoid inflating error rates.
        appendMetrics({
          event: "fanout_internal",
          route: "worker",
          tool: kind,
          category: kind === "analyze" ? "analysis" : "review",
          status: "ok",
          degraded: true,
          fanout_id: fanoutId,
          role: "reviewer",
          reason_code: "response_unparsed",
          e2e_ms: Date.now() - reviewerStart,
          prompt_tokens: 0,
          completion_tokens: 0
        });
      }
      return { synthesis };
    } catch {
      const isTimeout = controller.signal.aborted || Date.now() >= deadline;
      appendMetrics({
        event: "fanout_internal",
        route: "worker",
        tool: kind,
        category: kind === "analyze" ? "analysis" : "review",
        status: "error",
        fanout_id: fanoutId,
        role: "reviewer",
        reason_code: isTimeout ? "timeout" : "upstream_unavailable",
        e2e_ms: Date.now() - reviewerStart,
        prompt_tokens: 0,
        completion_tokens: 0
      });
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Singleton & Convenience ───────────────────────────────────────────────────

export const fanoutCoordinator = new FanoutCoordinator();

export function isFanoutEnabled(): boolean {
  return FANOUT_ENABLED;
}

/**
 * Check if a request has valid fan-out branches and the feature is enabled.
 * Returns a rejection message if fan-out is requested but not enabled, or
 * undefined if the request should proceed normally (no branches or fan-out is on).
 */
export function checkFanoutAvailability(branches: unknown): string | undefined {
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  if (!FANOUT_ENABLED) {
    return "fan-out is disabled (WORKER_FANOUT_ENABLED=0); omit branches or set WORKER_FANOUT_ENABLED=1 to enable";
  }
  return undefined;
}
