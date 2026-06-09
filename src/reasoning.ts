// Deterministic reasoning / quality-control core for the code worker.
//
// This is a faithful, self-contained port of the Mythos reasoning architecture
// (plan -> recurrent depth -> verify -> calibrate -> contradiction -> gate),
// adapted from the generic "claims + evidence" domain to the concrete execution
// signals a code worker produces: check results, scope compliance, the process
// exit code, the git diff, and stderr. It runs **no LLM** and makes **no network
// calls**. Every number it emits is auditable.
//
// The idea (latent-recurrent depth, Geiping et al. 2025): relax a reasoning
// *belief* toward a fixed point derived from evidence, spending more passes on
// harder inputs and halting when the state stops moving. Concretely:
//
//   belief_t = belief_{t-1} + lr * (target(state) - belief_{t-1})
//   target   = base(evidence_strength) - unknown_penalty - contradiction_load
//   lr       = 0.85 - 0.45 * difficulty      # harder inputs creep
//
// The gate then decides ready / revise / gather_evidence / block, and the worker
// uses that decision to drive an automatic, bounded re-try loop.

// ---------------------------------------------------------------------------
// Signal model
// ---------------------------------------------------------------------------

export type CheckStatus = "passed" | "failed" | "timeout";

export interface CheckSignal {
  label: string;
  status: CheckStatus;
}

/** Everything observable about a finished Claude Code pass. */
export interface JobSignals {
  /** The task prompt — used to detect code/risk intent. */
  task: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  changedFiles: string[];
  diffBytes: number;
  isGitRepo: boolean;
  /** Files changed outside the declared scoped_patch. */
  scopeViolations: string[];
  scopedPaths: string[];
  checks: CheckSignal[];
  /** Lines from stderr / [error] events that signal a failure. */
  errorLines: string[];
}

// ---------------------------------------------------------------------------
// Evidence weighting (single shared, documented model — mirrors Mythos)
// ---------------------------------------------------------------------------

export type EvidenceType =
  | "test_result"
  | "file_line"
  | "docs"
  | "web"
  | "user_input"
  | "inference"
  | "unknown";

export const EVIDENCE_WEIGHT: Record<EvidenceType, number> = {
  test_result: 0.92,
  file_line: 0.85,
  docs: 0.8,
  web: 0.68,
  user_input: 0.58,
  inference: 0.35,
  unknown: 0.0,
};

export interface EvidenceItem {
  type: EvidenceType;
  summary: string;
}

export type RiskSeverity = "low" | "medium" | "high";
const SEVERITY_RANK: Record<RiskSeverity, number> = { low: 1, medium: 2, high: 3 };

export interface RiskItem {
  kind: string;
  detail: string;
  severity: RiskSeverity;
}

export type GateDecision = "ready" | "revise" | "gather_evidence" | "block";
export type HaltReason = "converged" | "stalled" | "oscillation" | "max_passes" | "no_open_checks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const CODE_INTENT_RE =
  /\b(fix|implement|refactor|add|remove|edit|modify|patch|rename|migrate|update|rewrite|test|build|compile|bug|feature|function|class|method|module|lint)\b|修复|实现|重构|新增|修改|删除|补丁|迁移|重写|测试|编译|构建|函数|类|方法|模块/i;

const RISK_DOMAIN_RE =
  /\b(security|auth|authentication|authoriz|credential|secret|token|password|payment|billing|delete|drop|destroy|migration|production|prod|deploy)\b|安全|鉴权|认证|授权|凭证|密钥|密码|支付|计费|删除|删库|迁移|生产|部署/i;

function isCodeTask(task: string): boolean {
  return CODE_INTENT_RE.test(task);
}

function isRiskTask(task: string): boolean {
  return RISK_DOMAIN_RE.test(task);
}

// ---------------------------------------------------------------------------
// Signals -> evidence / unknowns / risks
// ---------------------------------------------------------------------------

interface Decomposed {
  evidence: EvidenceItem[];
  unknowns: string[];
  risks: RiskItem[];
  passedChecks: number;
  failedChecks: number;
  hasChecks: boolean;
}

export function decomposeSignals(s: JobSignals): Decomposed {
  const evidence: EvidenceItem[] = [];
  const unknowns: string[] = [];
  const risks: RiskItem[] = [];

  const failedChecks = s.checks.filter((c) => c.status !== "passed");
  const passedChecks = s.checks.filter((c) => c.status === "passed");
  const hasChecks = s.checks.length > 0;
  const codeTask = isCodeTask(s.task);
  const producedChanges = s.changedFiles.length > 0 || s.diffBytes > 0;

  // --- Evidence (positive) ---
  for (const c of passedChecks) {
    evidence.push({ type: "test_result", summary: `check "${c.label}" passed` });
  }
  if (s.exitCode === 0) {
    // Process success is weak proof of correctness, not strong evidence.
    evidence.push({ type: "inference", summary: "worker exited 0" });
  }
  if (s.isGitRepo && producedChanges && s.scopeViolations.length === 0) {
    evidence.push({ type: "file_line", summary: `${s.changedFiles.length} file(s) changed within scope` });
  }

  // --- Unknowns (verifiability gaps) ---
  if (!hasChecks) {
    unknowns.push("no verification command (check) was provided, so correctness is unverified");
  }
  if (!s.isGitRepo) {
    unknowns.push("not a git repository, so changes cannot be diffed or audited");
  }
  if (codeTask && !producedChanges && s.exitCode === 0) {
    unknowns.push("code task exited 0 but produced no file changes");
  }

  // --- Risks / contradictions (negative; drive revise) ---
  for (const c of failedChecks) {
    risks.push({
      kind: "failing_check",
      detail: `check "${c.label}" ${c.status}`,
      severity: "high",
    });
  }
  if (s.scopeViolations.length > 0) {
    risks.push({
      kind: "scope_violation",
      detail: `changed outside declared scope: ${s.scopeViolations.join(", ")}`,
      severity: "high",
    });
  }
  if (s.exitCode !== 0 && s.exitCode !== null) {
    risks.push({
      kind: "nonzero_exit",
      detail: `worker exited with code ${s.exitCode}`,
      severity: producedChanges ? "medium" : "high",
    });
  }
  if (s.signal) {
    risks.push({ kind: "killed", detail: `worker terminated by signal ${s.signal}`, severity: "high" });
  }
  if (codeTask && !producedChanges && s.exitCode === 0) {
    risks.push({
      kind: "no_changes",
      detail: "code task completed without changing any file",
      severity: "medium",
    });
  }
  if (s.errorLines.length > 0) {
    risks.push({
      kind: "error_output",
      detail: `worker emitted error output (${s.errorLines.length} line(s))`,
      severity: "low",
    });
  }
  if (isRiskTask(s.task) && !hasChecks) {
    risks.push({
      kind: "unverified_risk_domain",
      detail: "risk-domain task (security/auth/payment/destructive) finished with no verification check",
      severity: "medium",
    });
  }

  return {
    evidence,
    unknowns,
    risks,
    passedChecks: passedChecks.length,
    failedChecks: failedChecks.length,
    hasChecks,
  };
}

// ---------------------------------------------------------------------------
// Recurrent depth (belief relaxation toward a fixed point)
// ---------------------------------------------------------------------------

function evidenceStrength(evidence: EvidenceItem[]): number {
  // Diminishing returns: independent evidence items each chip away at doubt.
  let doubt = 1;
  for (const item of evidence) {
    doubt *= 1 - clamp01(EVIDENCE_WEIGHT[item.type] * 0.7);
  }
  return clamp01(1 - doubt);
}

function unknownPenalty(count: number): number {
  return clamp01(1 - Math.exp(-count * 0.35)) * 0.5;
}

export function riskLoad(risks: RiskItem[]): number {
  // Saturating penalty in [0,0.9].
  const raw = risks.reduce((sum, item) => sum + SEVERITY_RANK[item.severity] * 0.12, 0);
  return clamp01(1 - Math.exp(-raw)) * 0.9;
}

const NEUTRAL_BASE = 0.15;

function beliefTarget(evidence: EvidenceItem[], unknowns: string[], risks: RiskItem[]): number {
  const support = evidenceStrength(evidence);
  const base = NEUTRAL_BASE + (1 - NEUTRAL_BASE) * support;
  return clamp01(base - unknownPenalty(unknowns.length) - riskLoad(risks) * 0.6);
}

export function estimateDifficulty(evidence: EvidenceItem[], unknowns: string[], risks: RiskItem[]): number {
  const support = evidenceStrength(evidence);
  const unknownLoad = clamp01(1 - Math.exp(-unknowns.length * 0.3));
  const contraLoad = riskLoad(risks);
  return clamp01(0.55 * (1 - support) + 0.2 * unknownLoad + 0.3 * contraLoad);
}

function learningRate(difficulty: number): number {
  return clamp01(0.85 - 0.45 * difficulty);
}

export interface DepthResult {
  belief: number;
  difficulty: number;
  converged: boolean;
  halted_reason: HaltReason;
  compute_used: number;
  recommended_additional_passes: number;
  trace: string[];
}

const DEFAULT_EPSILON = 0.02;

export function runRecurrentDepth(
  evidence: EvidenceItem[],
  unknowns: string[],
  risks: RiskItem[],
  options: { maxPasses?: number; minPasses?: number; epsilon?: number; initialBelief?: number } = {},
): DepthResult {
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const minPasses = Math.max(1, options.minPasses ?? 1);
  const difficulty = estimateDifficulty(evidence, unknowns, risks);
  // Adaptive compute: harder inputs get a bigger pass budget.
  const maxPasses = Math.max(minPasses, options.maxPasses ?? Math.round(2 + difficulty * 6));
  const lr = learningRate(difficulty);
  const target = beliefTarget(evidence, unknowns, risks);

  let belief = clamp01(options.initialBelief ?? 0);
  let lastDelta = 1;
  let converged = false;
  const trace: string[] = [];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const next = clamp01(belief + lr * (target - belief));
    lastDelta = Math.abs(next - belief);
    belief = next;
    trace.push(`pass ${pass}: belief ${belief.toFixed(3)} -> target ${target.toFixed(3)} (delta ${lastDelta.toFixed(3)})`);
    if (pass >= minPasses && lastDelta < epsilon) {
      converged = true;
      break;
    }
  }

  let halted_reason: HaltReason;
  if (!converged) {
    halted_reason = "max_passes";
  } else if (belief < 0.5 && (unknowns.length > 0 || risks.length > 0)) {
    halted_reason = "stalled";
  } else if (risks.length === 0 && unknowns.length === 0) {
    halted_reason = "no_open_checks";
  } else {
    halted_reason = "converged";
  }

  let recommended_additional_passes = 0;
  if (halted_reason === "max_passes" && lastDelta > epsilon) {
    const remaining = Math.ceil(Math.log(epsilon / lastDelta) / Math.log(1 - lr));
    recommended_additional_passes = Math.max(1, Math.min(4, Number.isFinite(remaining) ? remaining : 1));
  }

  return {
    belief: Number(belief.toFixed(4)),
    difficulty: Number(difficulty.toFixed(3)),
    converged,
    halted_reason,
    compute_used: trace.length,
    recommended_additional_passes,
    trace,
  };
}

// ---------------------------------------------------------------------------
// Calibration: did the worker's *claim of success* match the evidence?
// ---------------------------------------------------------------------------

export interface CalibrationReport {
  /** What the worker implicitly claimed (exit 0 == "I succeeded"). */
  stated_success: number;
  /** What the evidence actually supports. */
  evidence_confidence: number;
  calibration_gap: number;
  overconfident: boolean;
}

function calibrate(s: JobSignals, evidence: EvidenceItem[], belief: number): CalibrationReport {
  const stated = s.exitCode === 0 ? 0.9 : 0.1;
  const evidenceConfidence = clamp01(0.5 * evidenceStrength(evidence) + 0.5 * belief);
  const gap = stated - evidenceConfidence;
  return {
    stated_success: Number(stated.toFixed(3)),
    evidence_confidence: Number(evidenceConfidence.toFixed(3)),
    calibration_gap: Number(gap.toFixed(3)),
    overconfident: gap > 0.15,
  };
}

// ---------------------------------------------------------------------------
// Gate + required changes
// ---------------------------------------------------------------------------

export interface ReasoningReport {
  enabled: true;
  decision: GateDecision;
  ready: boolean;
  belief: number;
  difficulty: number;
  halted_reason: HaltReason;
  blockers: string[];
  risks: RiskItem[];
  unknowns: string[];
  evidence: EvidenceItem[];
  calibration: CalibrationReport;
  required_changes: string[];
  recommended_checks: string[];
  /** True only when there is concrete, fixable failure evidence worth a re-try. */
  should_revise: boolean;
  depth_trace: string[];
}

function buildRequiredChanges(risks: RiskItem[], decomposed: Decomposed, s: JobSignals): string[] {
  const out: string[] = [];
  for (const r of risks.filter((x) => x.kind === "failing_check")) {
    out.push(`Make this pass: ${r.detail}.`);
  }
  if (s.scopeViolations.length > 0) {
    out.push(
      `Revert or relocate changes outside the declared scope (${s.scopedPaths.join(", ") || "scope"}): ${s.scopeViolations.join(", ")}.`,
    );
  }
  if (risks.some((r) => r.kind === "nonzero_exit" || r.kind === "killed")) {
    out.push("Resolve the runtime failure so the worker can complete cleanly.");
  }
  if (risks.some((r) => r.kind === "no_changes")) {
    out.push("The task asks for a code change but none was produced — make the actual edit or explain why none is needed.");
  }
  return [...new Set(out)];
}

function buildRecommendedChecks(decomposed: Decomposed, s: JobSignals): string[] {
  const out: string[] = [];
  if (!decomposed.hasChecks && isCodeTask(s.task)) {
    out.push("Provide a `checks` command (e.g. unit tests / build) so correctness can be verified automatically.");
  }
  if (!s.isGitRepo) {
    out.push("Run the worker inside a git repository so changes can be diffed and scoped.");
  }
  if (isRiskTask(s.task) && !decomposed.hasChecks) {
    out.push("Risk-domain task: add an explicit verification step before trusting the result.");
  }
  return out;
}

export interface AssessOptions {
  maxPasses?: number;
}

export function assess(s: JobSignals, options: AssessOptions = {}): ReasoningReport {
  const decomposed = decomposeSignals(s);
  const depth = runRecurrentDepth(decomposed.evidence, decomposed.unknowns, decomposed.risks, {
    maxPasses: options.maxPasses,
  });
  const calibration = calibrate(s, decomposed.evidence, depth.belief);

  // Blockers: concrete reasons the result is not trustworthy as-is.
  const blockers: string[] = [];
  if (decomposed.failedChecks > 0) blockers.push(`${decomposed.failedChecks} failing check(s)`);
  if (s.scopeViolations.length > 0) blockers.push(`${s.scopeViolations.length} out-of-scope change(s)`);
  if (s.exitCode !== 0 && s.exitCode !== null) blockers.push(`nonzero exit code ${s.exitCode}`);
  if (s.signal) blockers.push(`terminated by signal ${s.signal}`);
  if (calibration.overconfident) blockers.push("worker claimed success but evidence is weak");

  const highSeverity = decomposed.risks.filter((r) => r.severity === "high").length;
  const hasConcreteFailure =
    decomposed.failedChecks > 0 ||
    s.scopeViolations.length > 0 ||
    (s.exitCode !== 0 && s.exitCode !== null) ||
    Boolean(s.signal) ||
    decomposed.risks.some((r) => r.kind === "no_changes");

  // Gate decision bands (mirrors Mythos gateAnswer).
  let decision: GateDecision;
  if (blockers.length === 0) {
    decision = "ready";
  } else if (highSeverity > 0 && hasConcreteFailure) {
    // Concrete, fixable failure with strong signal -> worth another bounded pass.
    decision = "revise";
  } else if (decomposed.unknowns.length > 0 && !hasConcreteFailure) {
    // Cannot verify, but nothing concretely broke -> ask for evidence, don't burn passes.
    decision = "gather_evidence";
  } else {
    decision = "revise";
  }

  // `block` is reserved: a risk-domain task that failed and produced changes we
  // cannot trust — surface for human review rather than auto-iterating blindly.
  if (decision === "revise" && isRiskTask(s.task) && decomposed.failedChecks > 0 && s.scopeViolations.length > 0) {
    decision = "block";
  }

  const required_changes = buildRequiredChanges(decomposed.risks, decomposed, s);
  const recommended_checks = buildRecommendedChecks(decomposed, s);

  return {
    enabled: true,
    decision,
    ready: decision === "ready",
    belief: depth.belief,
    difficulty: depth.difficulty,
    halted_reason: depth.halted_reason,
    blockers,
    risks: decomposed.risks,
    unknowns: decomposed.unknowns,
    evidence: decomposed.evidence,
    calibration,
    required_changes,
    recommended_checks,
    // Only auto-revise on concrete, fixable failures with a documented fix —
    // never merely on "low belief" or "missing checks" (that wastes tokens).
    should_revise: decision === "revise" && hasConcreteFailure && required_changes.length > 0,
    depth_trace: depth.trace,
  };
}

/** Compose the critique-driven prompt block for an automatic revise pass. */
export function buildRevisePrompt(originalPrompt: string, report: ReasoningReport, pass: number): string {
  const lines: string[] = [
    originalPrompt.trim(),
    "",
    `[Automated review — revise pass ${pass}]`,
    "Your previous attempt did NOT pass deterministic verification. Fix ONLY these concrete problems, keep changes minimal, and stay within the declared scope. Do not revert unrelated working changes.",
    "",
    "Problems to fix:",
    ...report.required_changes.map((c) => `- ${c}`),
  ];
  if (report.risks.length > 0) {
    lines.push("", "Detected risks:");
    for (const r of report.risks.slice(0, 6)) {
      lines.push(`- [${r.severity}] ${r.detail}`);
    }
  }
  lines.push("", "Re-run the relevant checks yourself before finishing.");
  return lines.join("\n");
}

/**
 * Stall detection across revise passes: if a pass does not strictly reduce the
 * blocker count, more passes of the same kind will not help (Mythos "stalled").
 */
export function isStalled(previous: ReasoningReport | undefined, current: ReasoningReport): boolean {
  if (!previous) return false;
  return current.blockers.length >= previous.blockers.length;
}
