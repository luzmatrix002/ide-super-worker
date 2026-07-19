import { createHash } from "node:crypto";
import { FANOUT_ENABLED, GLOBAL_LITE_MAX, LITE_MAX_CONCURRENCY } from "./config.js";
import { fanoutSlotSemaphore } from "./concurrency.js";
import {
  callLiteCompletionDetailed,
  LiteCompletionError,
  type LiteCompletionResult,
  type LiteCompletionTarget
} from "./lite.js";
import { appendMetrics } from "./metrics.js";
import {
  getQualityTargetApiKey,
  loadQualityTargetsConfig,
  type QualityBranchTarget,
  type QualityReviewerTarget,
  type QualityTargetDescriptor,
  type QualityTargetsConfigV1
} from "./quality_targets.js";
import { redactSecrets } from "./redact.js";

export type QualityKind = "analyze" | "review";
export type QualityStatus = "qualified" | "needs_direct_review" | "failed";

export interface QualityCitationV1 {
  file: string;
  line?: number;
  claim: string;
}

export interface QualityReviewResultV1 {
  verdict: "approve" | "needs_changes" | "risky";
  issues: Array<{ file: string; line?: number; severity: "low" | "medium" | "high" | "critical"; note: string }>;
  summary: string;
}

export interface QualityResultV1 {
  contract_version: "quality.v1";
  kind: QualityKind;
  status: QualityStatus;
  result?: string | QualityReviewResultV1;
  reason_codes: string[];
  evidence: {
    complete: boolean;
    citations: QualityCitationV1[];
    unresolved_disagreements: string[];
  };
  execution: {
    branches_completed: number;
    branch_models: string[];
    reviewer_model?: string;
    config_fingerprint?: string;
    thinking_requested: boolean[];
    thinking_observed: boolean[];
  };
}

interface QualityClaim {
  id: string;
  claim: string;
  severity: "low" | "medium" | "high" | "critical";
  citations: QualityCitationV1[];
}

interface BranchPayload {
  summary: string;
  verdict?: "approve" | "needs_changes" | "risky";
  claims: QualityClaim[];
}

interface BranchRun {
  id: string;
  status: "completed" | "failed" | "timed_out";
  reason_code?: string;
  output?: BranchPayload;
  completion?: LiteCompletionResult;
}

interface SynthesisPayload {
  result: string | QualityReviewResultV1;
  claims: Array<{ claim: string; citations: QualityCitationV1[] }>;
  resolutions: Array<{
    branch_id: string;
    claim_id: string;
    status: "accepted" | "rejected";
    reason: string;
    citations: QualityCitationV1[];
  }>;
  unresolved_disagreements: string[];
}

interface HighQualityInput {
  kind: QualityKind;
  task: string;
  evidenceContent: string;
  evidenceTruncated: boolean;
  diff?: string;
  checks?: string[];
}

const QUALITY_TOTAL_MS = 270_000;
const QUALITY_QUEUE_MS = 15_000;
const QUALITY_BRANCH_END_MS = 195_000;
const QUALITY_BRANCH_MAX_TOKENS = 1_600;
const QUALITY_REVIEWER_MAX_TOKENS = 1_800;
const QUALITY_BRANCH_PROMPT_VERSION = "quality-branch.v1";
const QUALITY_SYNTHESIS_PROMPT_VERSION = "quality-synthesis.v1";

const ANALYZE_ROLES = [
  "Trace call paths and extract facts. Every material claim must cite an exact # FILE path and line when available.",
  "Inspect boundaries, concurrency, failure semantics, and hidden assumptions. Prefer falsifiable evidence over confidence language.",
  "Red-team the likely answer: seek counterexamples, alternative explanations, omissions, and unsupported conclusions."
] as const;

const REVIEW_ROLES = [
  "Check specification alignment, semantic correctness, and regressions. Cite exact changed files and lines.",
  "Check runtime behavior, boundary conditions, error handling, and concurrency defects. Distinguish evidence from speculation.",
  "Red-team tests, compatibility, security boundaries, and false positives. Preserve every plausible high/critical finding."
] as const;

const probeCache = new Map<string, Promise<boolean>>();

function controllerUntil(deadline: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  return { controller, clear: () => clearTimeout(timer) };
}

function normalizePath(value: string): string {
  return value.trim().replace(/^([ab])\//, "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function allowedEvidencePaths(evidence: string, diff?: string): Set<string> {
  const allowed = new Set<string>();
  for (const match of evidence.matchAll(/^# FILE:\s*(.+)$/gm)) allowed.add(normalizePath(match[1]));
  for (const match of (diff ?? "").matchAll(/^(?:\+\+\+|---)\s+([^\s]+)$/gm)) {
    if (match[1] !== "/dev/null") allowed.add(normalizePath(match[1]));
  }
  return allowed;
}

function validCitation(value: unknown, allowed: ReadonlySet<string>): value is QualityCitationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.file !== "string" || typeof record.claim !== "string" || !record.claim.trim()) return false;
  if (record.line !== undefined && (!Number.isInteger(record.line) || Number(record.line) < 1)) return false;
  return allowed.has(normalizePath(record.file));
}

function validCitations(value: unknown, allowed: ReadonlySet<string>): value is QualityCitationV1[] {
  return Array.isArray(value) && value.length > 0 && value.every((citation) => validCitation(citation, allowed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBranchPayload(raw: string, allowed: ReadonlySet<string>): BranchPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.summary !== "string" || !Array.isArray(parsed.claims)) return undefined;
  if (
    parsed.verdict !== undefined &&
    !(parsed.verdict === "approve" || parsed.verdict === "needs_changes" || parsed.verdict === "risky")
  ) return undefined;
  const claims: QualityClaim[] = [];
  const ids = new Set<string>();
  for (const value of parsed.claims) {
    if (!isRecord(value)) return undefined;
    if (typeof value.id !== "string" || !value.id.trim() || ids.has(value.id)) return undefined;
    if (typeof value.claim !== "string" || !value.claim.trim()) return undefined;
    if (!(value.severity === "low" || value.severity === "medium" || value.severity === "high" || value.severity === "critical")) {
      return undefined;
    }
    if (!validCitations(value.citations, allowed)) return undefined;
    ids.add(value.id);
    claims.push({
      id: value.id,
      claim: redactSecrets(value.claim),
      severity: value.severity,
      citations: value.citations
    });
  }
  if (claims.length === 0) return undefined;
  return {
    summary: redactSecrets(parsed.summary),
    ...(parsed.verdict ? { verdict: parsed.verdict } : {}),
    claims
  };
}

function parseReviewResult(value: unknown, allowed: ReadonlySet<string>): QualityReviewResultV1 | undefined {
  if (!isRecord(value) || !(value.verdict === "approve" || value.verdict === "needs_changes" || value.verdict === "risky")) {
    return undefined;
  }
  if (typeof value.summary !== "string" || !Array.isArray(value.issues)) return undefined;
  const issues: QualityReviewResultV1["issues"] = [];
  for (const issue of value.issues) {
    if (!isRecord(issue) || typeof issue.file !== "string" || typeof issue.note !== "string") return undefined;
    if (!(issue.severity === "low" || issue.severity === "medium" || issue.severity === "high" || issue.severity === "critical")) {
      return undefined;
    }
    if (!allowed.has(normalizePath(issue.file))) return undefined;
    if (issue.line !== undefined && (!Number.isInteger(issue.line) || Number(issue.line) < 1)) return undefined;
    issues.push({
      file: issue.file,
      ...(typeof issue.line === "number" ? { line: issue.line } : {}),
      severity: issue.severity,
      note: redactSecrets(issue.note)
    });
  }
  return { verdict: value.verdict, issues, summary: redactSecrets(value.summary) };
}

function parseSynthesis(
  raw: string,
  kind: QualityKind,
  branches: BranchRun[],
  allowed: ReadonlySet<string>
): SynthesisPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.claims) || !Array.isArray(parsed.resolutions)) return undefined;
  if (!Array.isArray(parsed.unresolved_disagreements) || !parsed.unresolved_disagreements.every((item) => typeof item === "string")) {
    return undefined;
  }
  const result = kind === "analyze"
    ? typeof parsed.result === "string" && parsed.result.trim() ? redactSecrets(parsed.result) : undefined
    : parseReviewResult(parsed.result, allowed);
  if (!result) return undefined;
  const claims: SynthesisPayload["claims"] = [];
  for (const claim of parsed.claims) {
    if (!isRecord(claim) || typeof claim.claim !== "string" || !claim.claim.trim()) return undefined;
    if (!validCitations(claim.citations, allowed)) return undefined;
    claims.push({ claim: redactSecrets(claim.claim), citations: claim.citations });
  }
  if (claims.length === 0) return undefined;

  const expected = new Map<string, QualityClaim>();
  for (const branch of branches) {
    for (const claim of branch.output?.claims ?? []) expected.set(`${branch.id}\u0000${claim.id}`, claim);
  }
  const seen = new Set<string>();
  const resolutions: SynthesisPayload["resolutions"] = [];
  for (const resolution of parsed.resolutions) {
    if (!isRecord(resolution) || typeof resolution.branch_id !== "string" || typeof resolution.claim_id !== "string") return undefined;
    if (!(resolution.status === "accepted" || resolution.status === "rejected")) return undefined;
    if (typeof resolution.reason !== "string" || !resolution.reason.trim()) return undefined;
    const key = `${resolution.branch_id}\u0000${resolution.claim_id}`;
    const original = expected.get(key);
    if (!original || seen.has(key)) return undefined;
    if (!Array.isArray(resolution.citations)) return undefined;
    if (resolution.citations.length > 0 && !resolution.citations.every((citation) => validCitation(citation, allowed))) return undefined;
    if (resolution.status === "rejected" && (original.severity === "high" || original.severity === "critical")) {
      if (!validCitations(resolution.citations, allowed)) return undefined;
    }
    seen.add(key);
    resolutions.push({
      branch_id: resolution.branch_id,
      claim_id: resolution.claim_id,
      status: resolution.status,
      reason: redactSecrets(resolution.reason),
      citations: resolution.citations as QualityCitationV1[]
    });
  }
  if (seen.size !== expected.size) return undefined;
  for (const resolution of resolutions) {
    if (resolution.status !== "accepted") continue;
    const original = expected.get(`${resolution.branch_id}\u0000${resolution.claim_id}`);
    if (!original || !claims.some((claim) => claim.claim.trim() === original.claim.trim())) return undefined;
    if (kind === "analyze" && (original.severity === "high" || original.severity === "critical")) {
      if (typeof result !== "string" || !result.includes(original.claim)) return undefined;
    }
    if (kind === "review" && typeof result !== "string" && (original.severity === "high" || original.severity === "critical")) {
      if (!result.issues.some((issue) => issue.note.trim() === original.claim.trim())) return undefined;
    }
  }
  if (kind === "review" && typeof result !== "string") {
    const acceptedSevere = resolutions.some((resolution) => {
      const claim = expected.get(`${resolution.branch_id}\u0000${resolution.claim_id}`);
      return resolution.status === "accepted" && (claim?.severity === "high" || claim?.severity === "critical");
    });
    if (acceptedSevere && result.verdict === "approve") return undefined;
  }
  return {
    result,
    claims,
    resolutions,
    unresolved_disagreements: parsed.unresolved_disagreements.map((item) => redactSecrets(item))
  };
}

function toLiteTarget(target: QualityTargetDescriptor & { id?: string }): LiteCompletionTarget {
  return {
    baseUrl: target.base_url.replace(/\/+$/, ""),
    apiKey: getQualityTargetApiKey(target),
    model: target.model,
    label: target.id ? `quality:${target.id}` : "quality:reviewer"
  };
}

function targetKey(target: QualityTargetDescriptor): string {
  return createHash("sha256")
    .update(`${target.base_url}\u0000${target.model}\u0000${target.thinking}`)
    .digest("hex")
    .slice(0, 16);
}

function configFingerprint(config: QualityTargetsConfigV1): string {
  return createHash("sha256")
    .update(JSON.stringify({
      config,
      branch_prompt_version: QUALITY_BRANCH_PROMPT_VERSION,
      synthesis_prompt_version: QUALITY_SYNTHESIS_PROMPT_VERSION,
      contract_version: "quality.v1"
    }))
    .digest("hex");
}

async function probeTarget(target: QualityTargetDescriptor, deadline: number): Promise<boolean> {
  if (target.thinking !== "probe") return true;
  const key = targetKey(target);
  let pending = probeCache.get(key);
  if (!pending) {
    pending = (async () => {
      const timeout = controllerUntil(Math.min(deadline, Date.now() + 45_000));
      try {
        const result = await callLiteCompletionDetailed(
          "Solve 17 * 19. Use internal reasoning and return only the final integer.",
          512,
          "quality_probe",
          {
            signal: timeout.controller.signal,
            bypassCache: true,
            target: toLiteTarget(target),
            thinking: true,
            requireThinking: true,
            contractVersion: "quality-probe.v1",
            role: "capability_probe"
          }
        );
        return result.model === target.model && result.thinkingObserved;
      } catch {
        return false;
      } finally {
        timeout.clear();
      }
    })();
    probeCache.set(key, pending);
    void pending.then((ready) => {
      if (!ready && probeCache.get(key) === pending) probeCache.delete(key);
    });
  }
  return pending;
}

export async function warmQualityTargetProbes(): Promise<{ configured: boolean; ready: boolean }> {
  if (!process.env.WORKER_QUALITY_TARGETS_FILE) return { configured: false, ready: false };
  try {
    const config = loadQualityTargetsConfig();
    const deadline = Date.now() + 45_000;
    const ready = (await Promise.all([...config.branches, config.reviewer].map((target) => probeTarget(target, deadline)))).every(Boolean);
    return { configured: true, ready };
  } catch {
    return { configured: true, ready: false };
  }
}

function emptyResult(
  kind: QualityKind,
  status: QualityStatus,
  reasonCodes: string[],
  runs: BranchRun[] = [],
  fingerprint?: string
): QualityResultV1 {
  return {
    contract_version: "quality.v1",
    kind,
    status,
    reason_codes: reasonCodes,
    evidence: { complete: false, citations: [], unresolved_disagreements: [] },
    execution: {
      branches_completed: runs.filter((run) => run.status === "completed").length,
      branch_models: runs.flatMap((run) => run.completion ? [run.completion.model] : []),
      ...(fingerprint ? { config_fingerprint: fingerprint } : {}),
      thinking_requested: runs.map((run) => run.completion?.thinkingRequested ?? false),
      thinking_observed: runs.map((run) => run.completion?.thinkingObserved ?? false)
    }
  };
}

function branchPrompt(kind: QualityKind, input: HighQualityInput, role: string): string {
  const outputShape = JSON.stringify({
    summary: "concise branch conclusion",
    ...(kind === "review" ? { verdict: "approve|needs_changes|risky" } : {}),
    claims: [
      {
        id: "stable-claim-id",
        claim: "one material factual claim",
        severity: "low|medium|high|critical",
        citations: [{ file: "exact path from # FILE or diff", line: 1, claim: "what the citation proves" }]
      }
    ]
  });
  return [
    "You are one independent branch in a quality-critical code analysis pipeline.",
    "Return ONLY JSON. Do not report confidence. Do not include hidden reasoning.",
    `Required shape: ${outputShape}`,
    `# ROLE\n${role}`,
    `# TASK\n${input.task}`,
    input.diff ? `# DIFF\n${input.diff}` : "",
    input.checks?.length ? `# CHECKS\n${input.checks.join("\n\n")}` : "",
    `# EVIDENCE\n${input.evidenceContent}`
  ].filter(Boolean).join("\n\n");
}

function synthesisPrompt(kind: QualityKind, input: HighQualityInput, runs: BranchRun[]): string {
  const resultShape = kind === "analyze"
    ? "a concise final answer string"
    : { verdict: "approve|needs_changes|risky", issues: [], summary: "concise final review" };
  return [
    "You are an independent quality adjudicator. Return ONLY JSON and do not expose hidden reasoning.",
    "Do not vote. Resolve every branch claim against the complete evidence.",
    "Every final claim needs an exact citation. A rejected high/critical claim needs evidence-backed citations.",
    "Every accepted branch claim must be copied verbatim into final claims. Accepted high/critical review claims must also appear verbatim as issue.note; accepted high/critical analyze claims must appear verbatim in result.",
    JSON.stringify({
      result: resultShape,
      claims: [{ claim: "final material claim", citations: [{ file: "exact path", line: 1, claim: "support" }] }],
      resolutions: [
        { branch_id: "branch id", claim_id: "claim id", status: "accepted|rejected", reason: "evidence-based reason", citations: [] }
      ],
      unresolved_disagreements: []
    }),
    `# KIND\n${kind}`,
    `# TASK\n${input.task}`,
    input.diff ? `# DIFF\n${input.diff}` : "",
    input.checks?.length ? `# CHECKS\n${input.checks.join("\n\n")}` : "",
    `# COMPLETE EVIDENCE\n${input.evidenceContent}`,
    `# COMPLETE BRANCH OUTPUTS\n${JSON.stringify(runs.map((run) => ({ id: run.id, output: run.output })))}`
  ].filter(Boolean).join("\n\n");
}

async function executeBranch(
  target: QualityBranchTarget,
  role: string,
  input: HighQualityInput,
  allowed: ReadonlySet<string>,
  deadline: number
): Promise<BranchRun> {
  const timeout = controllerUntil(deadline);
  try {
    if (!(await probeTarget(target, deadline))) return { id: target.id, status: "failed", reason_code: "thinking_probe_failed" };
    const thinking = target.thinking !== "off";
    const completion = await callLiteCompletionDetailed(branchPrompt(input.kind, input, role), QUALITY_BRANCH_MAX_TOKENS, input.kind, {
      signal: timeout.controller.signal,
      bypassCache: true,
      target: toLiteTarget(target),
      thinking,
      requireThinking: thinking,
      contractVersion: QUALITY_BRANCH_PROMPT_VERSION,
      role: `quality_branch:${target.id}`
    });
    if (completion.model !== target.model) return { id: target.id, status: "failed", reason_code: "model_mismatch", completion };
    const output = parseBranchPayload(completion.content, allowed);
    if (!output) return { id: target.id, status: "failed", reason_code: "branch_response_unparsed", completion };
    return { id: target.id, status: "completed", output, completion };
  } catch (error) {
    const timedOut = timeout.controller.signal.aborted || Date.now() >= deadline;
    const code = error instanceof LiteCompletionError ? error.code : timedOut ? "timeout" : "branch_failed";
    return { id: target.id, status: timedOut ? "timed_out" : "failed", reason_code: code };
  } finally {
    timeout.clear();
  }
}

async function runReviewer(
  target: QualityReviewerTarget,
  input: HighQualityInput,
  runs: BranchRun[],
  deadline: number
): Promise<LiteCompletionResult> {
  if (!(await probeTarget(target, deadline))) throw new Error("thinking_probe_failed");
  const timeout = controllerUntil(deadline);
  try {
    const thinking = target.thinking !== "off";
    const completion = await callLiteCompletionDetailed(
      synthesisPrompt(input.kind, input, runs),
      QUALITY_REVIEWER_MAX_TOKENS,
      input.kind,
      {
        signal: timeout.controller.signal,
        bypassCache: true,
        target: toLiteTarget(target),
        thinking,
        requireThinking: thinking,
        contractVersion: QUALITY_SYNTHESIS_PROMPT_VERSION,
        role: "quality_reviewer"
      }
    );
    if (completion.model !== target.model) {
      throw new LiteCompletionError("model_mismatch", "quality reviewer returned an unexpected model");
    }
    return completion;
  } finally {
    timeout.clear();
  }
}

async function runHighQuality(input: HighQualityInput): Promise<QualityResultV1> {
  const startedAt = Date.now();
  if (!FANOUT_ENABLED) return emptyResult(input.kind, "needs_direct_review", ["quality_fanout_disabled"]);
  if (LITE_MAX_CONCURRENCY < 3 || GLOBAL_LITE_MAX < 3) {
    return emptyResult(input.kind, "needs_direct_review", ["quality_concurrency_below_3"]);
  }
  if (input.evidenceTruncated || /\.\.\.\[file truncated at \d+ bytes\]/.test(input.evidenceContent)) {
    return emptyResult(input.kind, "needs_direct_review", ["evidence_truncated"]);
  }
  const allowed = allowedEvidencePaths(input.evidenceContent, input.diff);
  if (allowed.size === 0) return emptyResult(input.kind, "needs_direct_review", ["no_citable_evidence"]);

  let config: QualityTargetsConfigV1;
  try {
    config = loadQualityTargetsConfig();
  } catch {
    return emptyResult(input.kind, "failed", ["quality_targets_invalid"]);
  }
  const fingerprint = configFingerprint(config);

  const totalDeadline = startedAt + QUALITY_TOTAL_MS;
  const queueTimeout = controllerUntil(Math.min(totalDeadline, startedAt + QUALITY_QUEUE_MS));
  let slot: { release: () => void };
  try {
    slot = await fanoutSlotSemaphore.acquire(queueTimeout.controller.signal);
  } catch {
    return emptyResult(input.kind, "needs_direct_review", ["quality_queue_timeout"]);
  } finally {
    queueTimeout.clear();
  }

  try {
    const branchDeadline = Math.min(totalDeadline, startedAt + QUALITY_BRANCH_END_MS);
    const roles = input.kind === "analyze" ? ANALYZE_ROLES : REVIEW_ROLES;
    const runs = await Promise.all(
      config.branches.map((target, index) => executeBranch(target, roles[index], input, allowed, branchDeadline))
    );
    if (runs.some((run) => run.status !== "completed")) {
      const reasons = ["quality_branches_incomplete", ...runs.flatMap((run) => run.reason_code ? [run.reason_code] : [])];
      return emptyResult(input.kind, runs.every((run) => run.status !== "completed") ? "failed" : "needs_direct_review", [...new Set(reasons)], runs, fingerprint);
    }
    if (Date.now() >= totalDeadline) return emptyResult(input.kind, "needs_direct_review", ["quality_reviewer_budget_exhausted"], runs, fingerprint);

    let reviewer: LiteCompletionResult;
    try {
      reviewer = await runReviewer(config.reviewer, input, runs, totalDeadline);
    } catch (error) {
      const code = error instanceof LiteCompletionError ? error.code : Date.now() >= totalDeadline ? "timeout" : "reviewer_failed";
      return emptyResult(input.kind, "needs_direct_review", [code], runs, fingerprint);
    }
    const synthesis = parseSynthesis(reviewer.content, input.kind, runs, allowed);
    if (!synthesis) return emptyResult(input.kind, "needs_direct_review", ["quality_synthesis_unparsed_or_incomplete"], runs, fingerprint);
    if (synthesis.unresolved_disagreements.length > 0) {
      const result = emptyResult(input.kind, "needs_direct_review", ["unresolved_disagreements"], runs, fingerprint);
      result.execution.reviewer_model = reviewer.model;
      result.evidence.unresolved_disagreements = synthesis.unresolved_disagreements;
      return result;
    }
    const citations = synthesis.claims.flatMap((claim) => claim.citations);
    const result: QualityResultV1 = {
      contract_version: "quality.v1",
      kind: input.kind,
      status: "qualified",
      result: synthesis.result,
      reason_codes: [],
      evidence: { complete: true, citations, unresolved_disagreements: [] },
      execution: {
        branches_completed: 3,
        branch_models: runs.map((run) => run.completion!.model),
        reviewer_model: reviewer.model,
        config_fingerprint: fingerprint,
        thinking_requested: [...runs.map((run) => run.completion!.thinkingRequested), reviewer.thinkingRequested],
        thinking_observed: [...runs.map((run) => run.completion!.thinkingObserved), reviewer.thinkingObserved]
      }
    };
    appendMetrics({
      event: "fanout_internal",
      route: "worker",
      tool: input.kind,
      category: input.kind === "analyze" ? "analysis" : "review",
      status: "ok",
      contract_version: "quality.v1",
      role: "quality_coordinator",
      config_fingerprint: fingerprint,
      e2e_ms: Date.now() - startedAt,
      branch_count: 3,
      evidence_complete: true,
      prompt_tokens: 0,
      completion_tokens: 0
    });
    return result;
  } finally {
    slot.release();
  }
}

export function runHighQualityAnalyze(input: {
  prompt: string;
  evidenceContent: string;
  evidenceTruncated: boolean;
}): Promise<QualityResultV1> {
  return runHighQuality({
    kind: "analyze",
    task: input.prompt,
    evidenceContent: input.evidenceContent,
    evidenceTruncated: input.evidenceTruncated
  });
}

export function runHighQualityReview(input: {
  task: string;
  evidenceContent: string;
  evidenceTruncated: boolean;
  diff?: string;
  checks?: string[];
}): Promise<QualityResultV1> {
  return runHighQuality({ kind: "review", ...input });
}
