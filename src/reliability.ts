import type {
  BlockingPolicy,
  CheckCommand,
  EpisodeSummary,
  ReliabilityProfile,
  ReliabilityTier,
  SemanticGateMode,
  StartJobInput
} from "./types.js";

const TIERS: ReliabilityTier[] = ["lite", "standard", "strict", "critical"];
const POLICIES: BlockingPolicy[] = ["observe", "warn", "enforce"];
const SEMANTIC_GATES: SemanticGateMode[] = ["off", "warn", "required"];

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.find((item) => item === normalized);
}

export function parseReliabilityTier(value: unknown): ReliabilityTier | undefined {
  return parseEnum(value, TIERS);
}

export function parseBlockingPolicy(value: unknown): BlockingPolicy | undefined {
  return parseEnum(value, POLICIES);
}

export function parseSemanticGate(value: unknown): SemanticGateMode | undefined {
  return parseEnum(value, SEMANTIC_GATES);
}

function checksFrom(input: Partial<StartJobInput>): CheckCommand[] {
  const stageChecks = (input.stages || []).flatMap((stage) => stage.checks || []);
  return [...(input.checks || []), ...stageChecks];
}

function hasScopedPatch(input: Partial<StartJobInput>): boolean {
  if (input.scoped_patch?.paths?.length) return true;
  return Boolean((input.stages || []).some((stage) => stage.scoped_patch?.paths?.length));
}

export function normalizeReliabilityArgs(args: Record<string, unknown>): Partial<StartJobInput> {
  return {
    reliability_tier: parseReliabilityTier(args.reliability_tier),
    blocking_policy: parseBlockingPolicy(args.blocking_policy),
    semantic_gate: parseSemanticGate(args.semantic_gate),
    tool_budget: numberFrom(args.tool_budget),
    episode:
      typeof args.episode === "boolean"
        ? args.episode
        : typeof args.episode === "string" && ["0", "false", "no", "off"].includes(args.episode.toLowerCase())
          ? false
          : undefined
  };
}

export function buildReliabilityProfile(
  input: Partial<StartJobInput>,
  runtime: { worktree?: boolean } = {}
): ReliabilityProfile {
  const tier =
    input.reliability_tier ||
    parseReliabilityTier(firstString(process.env.WORKER_RELIABILITY_TIER)) ||
    "standard";
  const blockingPolicy =
    input.blocking_policy ||
    parseBlockingPolicy(firstString(process.env.WORKER_BLOCKING_POLICY)) ||
    "observe";
  const semanticGate =
    input.semantic_gate ||
    parseSemanticGate(firstString(process.env.WORKER_SEMANTIC_GATE)) ||
    (tier === "critical" ? "warn" : "off");
  const toolBudget = input.tool_budget ?? numberFrom(process.env.WORKER_TOOL_BUDGET);

  const checks = checksFrom(input);
  const hasChecks = checks.length > 0;
  const scoped = hasScopedPatch(input);
  const required = new Set<string>();
  const satisfied = new Set<string>();
  const warnings: string[] = [];

  if (tier === "lite") {
    required.add("read_only_route");
    warnings.push("lite reliability tier is safest with read-only tools; start jobs are observed but not blocked");
  }

  if (tier === "strict" || tier === "critical") {
    required.add("checks");
    required.add("scoped_patch");
    if (!hasChecks) warnings.push(`${tier} tier should include concrete checks`);
    if (!scoped) warnings.push(`${tier} tier should include scoped_patch paths`);
  }

  if (tier === "critical") {
    required.add("semantic_gate");
    required.add("escalate_model");
    required.add("worktree_isolation");
    if (semanticGate === "off") warnings.push("critical tier should enable semantic_gate=warn or required");
    if (!process.env.WORKER_ESCALATE_MODEL?.trim()) warnings.push("critical tier should configure WORKER_ESCALATE_MODEL");
    if (!runtime.worktree) warnings.push("critical tier should prefer WORKER_ISOLATION=worktree");
  }

  if (hasChecks) satisfied.add("checks");
  if (scoped) satisfied.add("scoped_patch");
  if (semanticGate !== "off") satisfied.add("semantic_gate");
  if (process.env.WORKER_ESCALATE_MODEL?.trim()) satisfied.add("escalate_model");
  if (runtime.worktree) satisfied.add("worktree_isolation");

  const missing = [...required].filter((gate) => !satisfied.has(gate));
  const blockingRisk =
    blockingPolicy === "enforce" && missing.length > 0
      ? "would_block"
      : warnings.length > 0
        ? "observe_only"
        : "none";

  return {
    tier,
    blocking_policy: blockingPolicy,
    semantic_gate: semanticGate,
    tool_budget: toolBudget,
    required_gates: [...required],
    satisfied_gates: [...satisfied],
    missing_gates: missing,
    warnings,
    blocking_risk: blockingRisk
  };
}

export function reliabilityRejectionReason(profile: ReliabilityProfile): string | undefined {
  if (profile.blocking_policy !== "enforce" || profile.missing_gates.length === 0) return undefined;
  return `reliability_policy blocked ${profile.tier} job; missing gates: ${profile.missing_gates.join(", ")}`;
}

export function buildEpisodeSummary(input: {
  job_id: string;
  profile: ReliabilityProfile;
  model: string;
  started_at: string;
  ended_at?: string;
  changed_files?: string[];
  checks?: string[];
  revise_passes?: number;
  stage_count?: number;
}): EpisodeSummary {
  const checks = input.checks || [];
  const failedCheckCount = checks.filter((line) => /failed|timeout|violation|error/i.test(line)).length;
  const missingPenalty = input.profile.missing_gates.length * 12;
  const warningPenalty = input.profile.warnings.length * 4;
  const failedPenalty = failedCheckCount * 18;
  const revisePenalty = (input.revise_passes || 0) * 5;
  const score = Math.max(0, Math.min(100, 100 - missingPenalty - warningPenalty - failedPenalty - revisePenalty));

  return {
    job_id: input.job_id,
    tier: input.profile.tier,
    blocking_policy: input.profile.blocking_policy,
    semantic_gate: input.profile.semantic_gate,
    model: input.model,
    started_at: input.started_at,
    ended_at: input.ended_at,
    changed_files_count: input.changed_files?.length || 0,
    check_count: checks.length,
    failed_check_count: failedCheckCount,
    revise_passes: input.revise_passes || 0,
    stage_count: input.stage_count || 0,
    trajectory_score: score,
    warnings: input.profile.warnings,
    missing_gates: input.profile.missing_gates
  };
}

export function reliabilityMetricExtra(profile: ReliabilityProfile | undefined): Record<string, unknown> {
  if (!profile) return {};
  return {
    reliability_tier: profile.tier,
    blocking_policy: profile.blocking_policy,
    semantic_gate: profile.semantic_gate,
    missing_gates: profile.missing_gates.length,
    blocking_risk: profile.blocking_risk
  };
}
