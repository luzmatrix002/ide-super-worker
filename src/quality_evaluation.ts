export const QUALITY_EVAL_PAIR_SCHEMA_VERSION = 1 as const;
export const QUALITY_EVAL_SUMMARY_SCHEMA_VERSION = 1 as const;
export const QUALITY_EVAL_BOOTSTRAP_SAMPLES = 10_000 as const;
export const QUALITY_EVAL_BOOTSTRAP_SEED = 20_260_712 as const;
export const QUALITY_EVAL_CUMULATIVE_ALPHA_LIMIT = 0.025 as const;
export const QUALITY_EVAL_FAILURE_MARGIN = -0.02 as const;
export const QUALITY_EVAL_TRIALS = ["A", "B", "C"] as const;
export const QUALITY_EVAL_CATEGORIES = ["analyze_diagnosis", "review"] as const;

export type QualityEvalTrial = (typeof QUALITY_EVAL_TRIALS)[number];
export type QualityEvalCategory = (typeof QUALITY_EVAL_CATEGORIES)[number];
export type QualityEvalStatus = "passed" | "failed" | "inconclusive";
export type QualityEvalSource = "real" | "edge";
export type QualityEvalStageSampleSize = 200 | 500;
export type QualityEvalStageAlpha = 0.01 | 0.015;

/** One frozen, independently scored baseline/candidate task pair. */
export interface QualityEvalPairV1 {
  schema_version: typeof QUALITY_EVAL_PAIR_SCHEMA_VERSION;
  trial: QualityEvalTrial;
  category: QualityEvalCategory;
  source: QualityEvalSource;
  repo_id: string;
  task_id: string;
  evaluator_version: string;
  baseline_config_sha256: string;
  candidate_config_sha256: string;
  blind_evaluator: true;
  baseline_pass: boolean;
  candidate_pass: boolean;
  candidate_only_critical_ids: string[];
}

export interface QualityCategorySummaryV1 {
  category: QualityEvalCategory;
  status: QualityEvalStatus;
  task_count: number;
  repo_count: number;
  source_counts: { real: number; edge: number };
  baseline_pass_rate: number | null;
  candidate_pass_rate: number | null;
  pass_delta: number | null;
  stage_sample_size: QualityEvalStageSampleSize | null;
  alpha_spent: QualityEvalStageAlpha | null;
  confidence_level: 0.99 | 0.985 | null;
  cumulative_alpha_limit: typeof QUALITY_EVAL_CUMULATIVE_ALPHA_LIMIT;
  bootstrap_seed: number | null;
  one_sided_lower_bound: number | null;
  candidate_only_critical_ids: string[];
  reason_codes: string[];
}

export interface QualityTrialSummaryV1 {
  trial: QualityEvalTrial;
  status: QualityEvalStatus;
  blocked_by?: QualityEvalTrial;
  categories: Record<QualityEvalCategory, QualityCategorySummaryV1>;
  reason_codes: string[];
}

export interface QualityEvalSummaryV1 {
  schema_version: typeof QUALITY_EVAL_SUMMARY_SCHEMA_VERSION;
  status: QualityEvalStatus;
  trial_order: QualityEvalTrial[];
  highest_qualified_trial?: QualityEvalTrial;
  bootstrap: {
    method: "repo_cluster_paired_percentile";
    samples: typeof QUALITY_EVAL_BOOTSTRAP_SAMPLES;
    seed: typeof QUALITY_EVAL_BOOTSTRAP_SEED;
  };
  trials: QualityTrialSummaryV1[];
  reason_codes: string[];
}

export class QualityEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityEvalError";
  }
}

interface StageConfig {
  sampleSize: QualityEvalStageSampleSize;
  alpha: QualityEvalStageAlpha;
  confidence: 0.99 | 0.985;
}

const STAGE_CONFIGS: Readonly<Record<QualityEvalStageSampleSize, StageConfig>> = {
  200: { sampleSize: 200, alpha: 0.01, confidence: 0.99 },
  500: { sampleSize: 500, alpha: 0.015, confidence: 0.985 }
};

function fail(location: string, message: string): never {
  throw new QualityEvalError(`${location}: ${message}`);
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(location, "must be a non-empty string");
  }
  return value;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean");
  return value;
}

function uniqueStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  const result = value.map((item, index) => nonEmptyString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length) fail(location, "must not contain duplicate values");
  return result;
}

function sha256(value: unknown, location: string): string {
  const parsed = nonEmptyString(value, location).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) fail(location, "must be a 64-character SHA-256 hex string");
  return parsed;
}

/** Validate and normalize one versioned quality-evaluation pair. */
export function validateQualityEvalPair(
  value: unknown,
  location = "QualityEval pair"
): QualityEvalPairV1 {
  const input = record(value, location);
  if (input.schema_version !== QUALITY_EVAL_PAIR_SCHEMA_VERSION) {
    fail(`${location}.schema_version`, `must equal ${QUALITY_EVAL_PAIR_SCHEMA_VERSION}`);
  }
  if (!(QUALITY_EVAL_TRIALS as readonly unknown[]).includes(input.trial)) {
    fail(`${location}.trial`, `must be one of ${QUALITY_EVAL_TRIALS.join(", ")}`);
  }
  if (!(QUALITY_EVAL_CATEGORIES as readonly unknown[]).includes(input.category)) {
    fail(`${location}.category`, `must be one of ${QUALITY_EVAL_CATEGORIES.join(", ")}`);
  }
  if (!(input.source === "real" || input.source === "edge")) {
    fail(`${location}.source`, "must be real or edge");
  }
  if (input.blind_evaluator !== true) fail(`${location}.blind_evaluator`, "must be true");

  const candidatePass = booleanValue(input.candidate_pass, `${location}.candidate_pass`);
  const criticalIds = uniqueStringArray(
    input.candidate_only_critical_ids,
    `${location}.candidate_only_critical_ids`
  );
  if (candidatePass && criticalIds.length > 0) {
    fail(
      `${location}.candidate_pass`,
      "must be false when candidate_only_critical_ids contains critical defects"
    );
  }

  return {
    schema_version: QUALITY_EVAL_PAIR_SCHEMA_VERSION,
    trial: input.trial as QualityEvalTrial,
    category: input.category as QualityEvalCategory,
    source: input.source,
    repo_id: nonEmptyString(input.repo_id, `${location}.repo_id`),
    task_id: nonEmptyString(input.task_id, `${location}.task_id`),
    evaluator_version: nonEmptyString(input.evaluator_version, `${location}.evaluator_version`),
    baseline_config_sha256: sha256(input.baseline_config_sha256, `${location}.baseline_config_sha256`),
    candidate_config_sha256: sha256(input.candidate_config_sha256, `${location}.candidate_config_sha256`),
    blind_evaluator: true,
    baseline_pass: booleanValue(input.baseline_pass, `${location}.baseline_pass`),
    candidate_pass: candidatePass,
    candidate_only_critical_ids: criticalIds
  };
}

/** Validate pair identity, official sample ceilings, and the A -> B -> C data order. */
export function validateQualityEvalPairs(values: readonly unknown[]): QualityEvalPairV1[] {
  if (!Array.isArray(values) || values.length === 0) {
    fail("QualityEval pairs", "must be a non-empty array");
  }
  const pairs = values.map((value, index) =>
    validateQualityEvalPair(value, `QualityEval pairs[${index}]`)
  );
  const taskKeys = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const presentTrials = new Set<QualityEvalTrial>();
  const evaluatorVersions = new Set<string>();
  const trialFingerprints = new Map<QualityEvalTrial, { baseline: Set<string>; candidate: Set<string> }>();

  for (const pair of pairs) {
    presentTrials.add(pair.trial);
    evaluatorVersions.add(pair.evaluator_version);
    const fingerprints = trialFingerprints.get(pair.trial) || { baseline: new Set<string>(), candidate: new Set<string>() };
    fingerprints.baseline.add(pair.baseline_config_sha256);
    fingerprints.candidate.add(pair.candidate_config_sha256);
    trialFingerprints.set(pair.trial, fingerprints);
    const taskKey = `${pair.trial}\u0000${pair.task_id}`;
    if (taskKeys.has(taskKey)) {
      fail(`QualityEval pair ${pair.task_id}.task_id`, "must be unique within each trial");
    }
    taskKeys.add(taskKey);

    const categoryKey = `${pair.trial}\u0000${pair.category}`;
    const count = (categoryCounts.get(categoryKey) || 0) + 1;
    if (count > 500) {
      fail(`QualityEval Trial ${pair.trial} ${pair.category}`, "must not exceed 500 task pairs");
    }
    categoryCounts.set(categoryKey, count);
  }

  if (presentTrials.has("B") && !presentTrials.has("A")) {
    fail("QualityEval pairs", "cannot include Trial B without Trial A");
  }
  if (presentTrials.has("C") && !presentTrials.has("B")) {
    fail("QualityEval pairs", "cannot include Trial C without Trial B");
  }
  if (evaluatorVersions.size !== 1) fail("QualityEval pairs", "must use exactly one evaluator_version");
  for (const [trial, fingerprints] of trialFingerprints) {
    if (fingerprints.baseline.size !== 1 || fingerprints.candidate.size !== 1) {
      fail(`QualityEval Trial ${trial}`, "must use one frozen baseline and candidate config fingerprint");
    }
    if ([...fingerprints.baseline][0] === [...fingerprints.candidate][0]) {
      fail(`QualityEval Trial ${trial}`, "baseline and candidate config fingerprints must differ");
    }
  }
  return pairs;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(values: number[], probability: number): number {
  values.sort((left, right) => left - right);
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  const upper = values[Math.min(lower + 1, values.length - 1)];
  return values[lower] + (upper - values[lower]) * weight;
}

function bootstrapSeed(
  trial: QualityEvalTrial,
  category: QualityEvalCategory,
  sampleSize: QualityEvalStageSampleSize
): number {
  let hash: number = QUALITY_EVAL_BOOTSTRAP_SEED;
  const identity = `${trial}:${category}:${sampleSize}`;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash;
}

interface RepoCluster {
  repoId: string;
  count: number;
  deltaSum: number;
}

/**
 * Resample whole repositories with replacement while retaining every paired task in a
 * selected repository. The statistic remains task-weighted within each bootstrap draw.
 */
function repoClusterBootstrapLowerBound(
  pairs: readonly QualityEvalPairV1[],
  alpha: QualityEvalStageAlpha,
  seed: number
): number {
  const byRepo = new Map<string, RepoCluster>();
  for (const pair of pairs) {
    const cluster = byRepo.get(pair.repo_id) || {
      repoId: pair.repo_id,
      count: 0,
      deltaSum: 0
    };
    cluster.count += 1;
    cluster.deltaSum += Number(pair.candidate_pass) - Number(pair.baseline_pass);
    byRepo.set(pair.repo_id, cluster);
  }
  const clusters = [...byRepo.values()].sort((left, right) =>
    left.repoId.localeCompare(right.repoId)
  );
  const random = mulberry32(seed);
  const deltas = new Array<number>(QUALITY_EVAL_BOOTSTRAP_SAMPLES);
  for (let iteration = 0; iteration < QUALITY_EVAL_BOOTSTRAP_SAMPLES; iteration += 1) {
    let taskCount = 0;
    let deltaSum = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      taskCount += cluster.count;
      deltaSum += cluster.deltaSum;
    }
    deltas[iteration] = deltaSum / taskCount;
  }
  return quantile(deltas, alpha);
}

function stageConfig(taskCount: number): StageConfig | null {
  if (taskCount === 200) return STAGE_CONFIGS[200];
  if (taskCount === 500) return STAGE_CONFIGS[500];
  return null;
}

function rawRates(pairs: readonly QualityEvalPairV1[]): {
  baselinePassRate: number | null;
  candidatePassRate: number | null;
  passDelta: number | null;
} {
  if (pairs.length === 0) {
    return { baselinePassRate: null, candidatePassRate: null, passDelta: null };
  }
  const baselinePasses = pairs.filter((pair) => pair.baseline_pass).length;
  const candidatePasses = pairs.filter((pair) => pair.candidate_pass).length;
  return {
    baselinePassRate: baselinePasses / pairs.length,
    candidatePassRate: candidatePasses / pairs.length,
    passDelta: (candidatePasses - baselinePasses) / pairs.length
  };
}

function categorySummary(
  trial: QualityEvalTrial,
  category: QualityEvalCategory,
  pairs: readonly QualityEvalPairV1[],
  blockedBy?: QualityEvalTrial
): QualityCategorySummaryV1 {
  const repos = new Set(pairs.map((pair) => pair.repo_id));
  const sourceCounts = {
    real: pairs.filter((pair) => pair.source === "real").length,
    edge: pairs.filter((pair) => pair.source === "edge").length
  };
  const rates = rawRates(pairs);
  const criticalIds = [
    ...new Set(pairs.flatMap((pair) => pair.candidate_only_critical_ids))
  ].sort();
  const config = blockedBy ? null : stageConfig(pairs.length);
  const base = {
    category,
    task_count: pairs.length,
    repo_count: repos.size,
    source_counts: sourceCounts,
    baseline_pass_rate: rates.baselinePassRate,
    candidate_pass_rate: rates.candidatePassRate,
    pass_delta: rates.passDelta,
    stage_sample_size: config?.sampleSize || null,
    alpha_spent: config?.alpha || null,
    confidence_level: config?.confidence || null,
    cumulative_alpha_limit: QUALITY_EVAL_CUMULATIVE_ALPHA_LIMIT,
    bootstrap_seed: null,
    one_sided_lower_bound: null,
    candidate_only_critical_ids: criticalIds
  } satisfies Omit<QualityCategorySummaryV1, "status" | "reason_codes">;

  if (criticalIds.length > 0) {
    return {
      ...base,
      status: "failed",
      reason_codes: [
        "candidate_only_critical_defect",
        ...(blockedBy ? [`prior_trial_not_passed:${blockedBy}`] : [])
      ]
    };
  }
  if (blockedBy) {
    return {
      ...base,
      status: "inconclusive",
      reason_codes: [`prior_trial_not_passed:${blockedBy}`]
    };
  }
  if (pairs.length === 0) {
    return { ...base, status: "inconclusive", reason_codes: ["missing_category"] };
  }
  if (!config) {
    return {
      ...base,
      status: "inconclusive",
      reason_codes: ["sample_size_not_at_preregistered_look"]
    };
  }
  const expectedReal = config.sampleSize * 0.7;
  const expectedEdge = config.sampleSize * 0.3;
  if (sourceCounts.real !== expectedReal || sourceCounts.edge !== expectedEdge) {
    return {
      ...base,
      status: "inconclusive",
      reason_codes: ["source_mix_must_be_70_30"]
    };
  }
  if (repos.size < 2) {
    return {
      ...base,
      status: "inconclusive",
      reason_codes: ["insufficient_repo_clusters"]
    };
  }

  const seed = bootstrapSeed(trial, category, config.sampleSize);
  const lowerBound = repoClusterBootstrapLowerBound(pairs, config.alpha, seed);
  if (lowerBound > 0) {
    return {
      ...base,
      status: "passed",
      bootstrap_seed: seed,
      one_sided_lower_bound: lowerBound,
      reason_codes: ["candidate_significantly_better"]
    };
  }
  if (lowerBound < QUALITY_EVAL_FAILURE_MARGIN) {
    return {
      ...base,
      status: "failed",
      bootstrap_seed: seed,
      one_sided_lower_bound: lowerBound,
      reason_codes: ["quality_lower_bound_below_minus_0_02"]
    };
  }
  return {
    ...base,
    status: "inconclusive",
    bootstrap_seed: seed,
    one_sided_lower_bound: lowerBound,
    reason_codes: ["quality_gain_not_proven"]
  };
}

function trialSummary(
  trial: QualityEvalTrial,
  pairs: readonly QualityEvalPairV1[],
  blockedBy?: QualityEvalTrial
): QualityTrialSummaryV1 {
  const categories = Object.fromEntries(
    QUALITY_EVAL_CATEGORIES.map((category) => [
      category,
      categorySummary(
        trial,
        category,
        pairs.filter((pair) => pair.category === category),
        blockedBy
      )
    ])
  ) as Record<QualityEvalCategory, QualityCategorySummaryV1>;
  const categoryValues = Object.values(categories);
  const status: QualityEvalStatus = categoryValues.some((category) => category.status === "failed")
    ? "failed"
    : categoryValues.every((category) => category.status === "passed")
      ? "passed"
      : "inconclusive";
  const reasonCodes = categoryValues.flatMap((category) =>
    category.status === "failed"
      ? [`category_failed:${category.category}`]
      : category.status === "inconclusive"
        ? [`category_inconclusive:${category.category}`]
        : []
  );
  if (blockedBy) reasonCodes.unshift(`prior_trial_not_passed:${blockedBy}`);
  return {
    trial,
    status,
    ...(blockedBy ? { blocked_by: blockedBy } : {}),
    categories,
    reason_codes: reasonCodes
  };
}

/**
 * Evaluate the preregistered A -> B -> C quality program. Only Trial C passing after
 * A and B have passed makes the overall program pass.
 */
export function evaluateQualityTrials(values: readonly unknown[]): QualityEvalSummaryV1 {
  const pairs = validateQualityEvalPairs(values);
  const presentTrials = QUALITY_EVAL_TRIALS.filter((trial) =>
    pairs.some((pair) => pair.trial === trial)
  );
  const summaries: QualityTrialSummaryV1[] = [];
  let blockedBy: QualityEvalTrial | undefined;
  let highestQualifiedTrial: QualityEvalTrial | undefined;

  for (const trial of presentTrials) {
    const summary = trialSummary(
      trial,
      pairs.filter((pair) => pair.trial === trial),
      blockedBy
    );
    summaries.push(summary);
    if (!blockedBy && summary.status === "passed") {
      highestQualifiedTrial = trial;
    } else if (!blockedBy) {
      blockedBy = trial;
    }
  }

  const failedTrials = summaries.filter((summary) => summary.status === "failed");
  const completePass =
    summaries.length === QUALITY_EVAL_TRIALS.length &&
    summaries.every((summary) => summary.status === "passed");
  const status: QualityEvalStatus = failedTrials.length > 0
    ? "failed"
    : completePass
      ? "passed"
      : "inconclusive";
  const reasonCodes = completePass
    ? ["all_trials_passed"]
    : failedTrials.length > 0
      ? failedTrials.map((summary) => `trial_failed:${summary.trial}`)
      : ["full_sequence_not_qualified"];

  return {
    schema_version: QUALITY_EVAL_SUMMARY_SCHEMA_VERSION,
    status,
    trial_order: [...QUALITY_EVAL_TRIALS],
    ...(highestQualifiedTrial ? { highest_qualified_trial: highestQualifiedTrial } : {}),
    bootstrap: {
      method: "repo_cluster_paired_percentile",
      samples: QUALITY_EVAL_BOOTSTRAP_SAMPLES,
      seed: QUALITY_EVAL_BOOTSTRAP_SEED
    },
    trials: summaries,
    reason_codes: reasonCodes
  };
}
