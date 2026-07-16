import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvalSpans, type EvalSpanV1 } from "./evaluation.js";

export const FORMAL_EVAL_MANIFEST_SCHEMA_VERSION = 1 as const;
export const FORMAL_EVAL_BOOTSTRAP_SAMPLES = 10_000 as const;
export const FORMAL_EVAL_BOOTSTRAP_SEED = 20_260_710 as const;
export const FORMAL_EVAL_SAMPLE_SIZES = [200, 250, 300, 350, 400] as const;
export const FORMAL_EVAL_CATEGORIES = [
  "search_read",
  "analyze_diagnosis",
  "review",
  "bugfix",
  "small_feature_refactor",
  "test_log"
] as const;

export type FormalEvalCategory = (typeof FORMAL_EVAL_CATEGORIES)[number];
export type FormalEvalSource = "real" | "edge";
export type FormalEvalStatus = "passed" | "failed" | "needs_more_tasks" | "inconclusive";

export interface FormalEvalTaskV1 {
  task_id: string;
  category: FormalEvalCategory;
  source: FormalEvalSource;
  visual: boolean;
  task_spec_sha256: string;
  prompt_sha256: string;
}

export interface FormalEvalManifestV1 {
  schema_version: typeof FORMAL_EVAL_MANIFEST_SCHEMA_VERSION;
  suite_id: string;
  evaluator_version: string;
  tasks: FormalEvalTaskV1[];
}

export interface FormalCategoryQualityEvidenceV1 {
  task_count: number;
  direct_pass_rate: number;
  worker_pass_rate: number;
  pass_delta: number;
  one_sided_95_lower_bound: number;
  one_sided_95_upper_bound: number;
  direct_only_passes: number;
  worker_only_passes: number;
  discordant_pairs: number;
}

export interface FormalEvalSummaryV1 {
  schema_version: 1;
  status: FormalEvalStatus;
  suite_id: string;
  task_count: number;
  span_count: number;
  category_counts: Record<FormalEvalCategory, number>;
  source_counts: Record<FormalEvalSource, number>;
  visual_task_count: number;
  metrics: {
    premium_tokens: {
      direct: number;
      worker: number;
      reduction: number;
      threshold: 0.5;
      meets_threshold: boolean;
    };
    total_cost: {
      direct_usd: number;
      worker_usd: number;
      reduction: number;
      threshold: 0.3;
      meets_threshold: boolean;
    };
    quality: {
      direct_pass_rate: number;
      worker_pass_rate: number;
      pass_delta: number;
      one_sided_95_lower_bound: number;
      one_sided_95_upper_bound: number;
      noninferiority_margin: -0.05;
      bootstrap_samples: 10_000;
      bootstrap_seed: 20_260_710;
      meets_threshold: boolean;
      by_category: Record<FormalEvalCategory, FormalCategoryQualityEvidenceV1>;
    };
    mcnemar: {
      direct_only_passes: number;
      worker_only_passes: number;
      discordant_pairs: number;
      p_value: number;
    };
    power: {
      method: "discordant_rate_normal_approximation";
      discordant_rate: number;
      value: number;
      threshold: 0.8;
      sufficient: boolean;
    };
    routed_only_critical_defects: number;
  };
  reason_codes: string[];
  next_sample_size?: 250 | 300 | 350 | 400;
}

export class FormalEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormalEvalError";
  }
}

const BASE_CATEGORY_QUOTAS: Record<FormalEvalCategory, number> = {
  search_read: 40,
  analyze_diagnosis: 35,
  review: 35,
  bugfix: 35,
  small_feature_refactor: 35,
  test_log: 20
};

function fail(location: string, message: string): never {
  throw new FormalEvalError(`${location}: ${message}`);
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

function sha256Value(value: unknown, location: string): string {
  const hash = nonEmptyString(value, location);
  if (!/^[0-9a-f]{64}$/i.test(hash)) fail(location, "must be a 64-character SHA-256 hex digest");
  return hash.toLowerCase();
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean");
  return value;
}

function emptyCategoryCounts(): Record<FormalEvalCategory, number> {
  return {
    search_read: 0,
    analyze_diagnosis: 0,
    review: 0,
    bugfix: 0,
    small_feature_refactor: 0,
    test_log: 0
  };
}

/** Validate the frozen formal-evaluation task manifest before reading results. */
export function validateFormalEvalManifest(value: unknown): FormalEvalManifestV1 {
  const input = record(value, "FormalEval manifest");
  if (input.schema_version !== FORMAL_EVAL_MANIFEST_SCHEMA_VERSION) {
    fail("FormalEval manifest.schema_version", `must equal ${FORMAL_EVAL_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.tasks)) fail("FormalEval manifest.tasks", "must be an array");
  if (!(FORMAL_EVAL_SAMPLE_SIZES as readonly number[]).includes(input.tasks.length)) {
    fail("FormalEval manifest.tasks", "sample size must be one of 200, 250, 300, 350, 400");
  }

  const tasks = input.tasks.map((value, index): FormalEvalTaskV1 => {
    const task = record(value, `FormalEval manifest.tasks[${index}]`);
    const category = task.category;
    if (!(FORMAL_EVAL_CATEGORIES as readonly unknown[]).includes(category)) {
      fail(
        `FormalEval manifest.tasks[${index}].category`,
        `must be one of ${FORMAL_EVAL_CATEGORIES.join(", ")}`
      );
    }
    const source = task.source;
    if (source !== "real" && source !== "edge") {
      fail(`FormalEval manifest.tasks[${index}].source`, "must be real or edge");
    }
    return {
      task_id: nonEmptyString(task.task_id, `FormalEval manifest.tasks[${index}].task_id`),
      category: category as FormalEvalCategory,
      source,
      visual: booleanValue(task.visual, `FormalEval manifest.tasks[${index}].visual`),
      task_spec_sha256: sha256Value(
        task.task_spec_sha256,
        `FormalEval manifest.tasks[${index}].task_spec_sha256`
      ),
      prompt_sha256: sha256Value(task.prompt_sha256, `FormalEval manifest.tasks[${index}].prompt_sha256`)
    };
  });

  const taskIds = new Set<string>();
  const categoryCounts = emptyCategoryCounts();
  const sourceCounts: Record<FormalEvalSource, number> = { real: 0, edge: 0 };
  let visualTaskCount = 0;
  for (const task of tasks) {
    if (taskIds.has(task.task_id)) fail(`FormalEval task ${task.task_id}`, "task_id must be unique");
    taskIds.add(task.task_id);
    categoryCounts[task.category] += 1;
    sourceCounts[task.source] += 1;
    if (task.visual) visualTaskCount += 1;
  }

  for (const category of FORMAL_EVAL_CATEGORIES) {
    const quota = BASE_CATEGORY_QUOTAS[category];
    const valid = tasks.length === 200 ? categoryCounts[category] === quota : categoryCounts[category] >= quota;
    if (!valid) {
      const expectation = tasks.length === 200 ? `must equal ${quota}` : `must be at least ${quota}`;
      fail(`FormalEval manifest category quota ${category}`, expectation);
    }
  }

  const expectedReal = Math.round(tasks.length * 0.7);
  const expectedEdge = tasks.length - expectedReal;
  if (sourceCounts.real !== expectedReal || sourceCounts.edge !== expectedEdge) {
    fail(
      "FormalEval manifest source quota",
      `must contain exactly ${expectedReal} real and ${expectedEdge} edge tasks`
    );
  }
  if (visualTaskCount < 10) fail("FormalEval manifest visual quota", "must contain at least 10 visual tasks");

  return {
    schema_version: FORMAL_EVAL_MANIFEST_SCHEMA_VERSION,
    suite_id: nonEmptyString(input.suite_id, "FormalEval manifest.suite_id"),
    evaluator_version: nonEmptyString(input.evaluator_version, "FormalEval manifest.evaluator_version"),
    tasks
  };
}

export function readFormalEvalManifest(file: string): FormalEvalManifestV1 {
  const resolved = path.resolve(file);
  const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(resolved, "invalid JSON");
  }
  return validateFormalEvalManifest(value);
}

interface FormalPair {
  task: FormalEvalTaskV1;
  direct: EvalSpanV1;
  worker: EvalSpanV1;
}

function exactPairs(spans: readonly EvalSpanV1[], manifest: FormalEvalManifestV1): FormalPair[] {
  gateEvalSpans(spans);
  const expectedTaskIds = new Set(manifest.tasks.map((task) => task.task_id));
  const byTask = new Map<string, EvalSpanV1[]>();
  for (const span of spans) {
    if (span.suite_id !== manifest.suite_id) {
      fail(`EvalSpan ${span.span_id}.suite_id`, "must match the formal manifest suite_id");
    }
    if (!span.acceptance.evidence_complete || span.acceptance.artifact_refs.length === 0) {
      fail(
        `EvalSpan ${span.span_id}.acceptance`,
        "evidence must be complete and include at least one artifact_ref"
      );
    }
    const group = byTask.get(span.task_id) || [];
    group.push(span);
    byTask.set(span.task_id, group);
  }
  if (
    spans.length !== expectedTaskIds.size * 2 ||
    byTask.size !== expectedTaskIds.size ||
    [...byTask.keys()].some((taskId) => !expectedTaskIds.has(taskId)) ||
    [...expectedTaskIds].some((taskId) => !byTask.has(taskId))
  ) {
    fail("FormalEval spans", "must match the manifest exact task set");
  }

  return manifest.tasks.map((task) => {
    const group = byTask.get(task.task_id) as EvalSpanV1[];
    const direct = group.filter((span) => span.arm === "direct");
    const worker = group.filter((span) => span.arm === "worker");
    if (group.length !== 2 || direct.length !== 1 || worker.length !== 1) {
      fail(`FormalEval task ${task.task_id}`, "must have exactly one direct and one worker span");
    }
    if (
      direct[0].fingerprint.task_spec_sha256 !== task.task_spec_sha256 ||
      direct[0].fingerprint.prompt_sha256 !== task.prompt_sha256
    ) {
      fail(`FormalEval task ${task.task_id}`, "task/prompt fingerprints must match the preregistered manifest");
    }
    if (direct[0].acceptance.evaluator_version !== manifest.evaluator_version) {
      fail(`FormalEval task ${task.task_id}`, "evaluator_version must match the preregistered manifest");
    }
    return { task, direct: direct[0], worker: worker[0] };
  });
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

/**
 * Resample paired pass differences with replacement inside each category x source stratum.
 * The bounds are the Type-7 fifth and 95th percentiles of 10,000 seeded bootstrap deltas.
 */
function stratifiedBootstrapBounds(
  pairs: readonly FormalPair[]
): { lower: number; upper: number } {
  const strata = new Map<string, number[]>();
  for (const pair of pairs) {
    const key = `${pair.task.category}\u0000${pair.task.source}`;
    const values = strata.get(key) || [];
    values.push(Number(pair.worker.acceptance.pass) - Number(pair.direct.acceptance.pass));
    strata.set(key, values);
  }
  const random = mulberry32(FORMAL_EVAL_BOOTSTRAP_SEED);
  const deltas = new Array<number>(FORMAL_EVAL_BOOTSTRAP_SAMPLES);
  for (let iteration = 0; iteration < FORMAL_EVAL_BOOTSTRAP_SAMPLES; iteration += 1) {
    let sum = 0;
    for (const values of strata.values()) {
      for (let draw = 0; draw < values.length; draw += 1) {
        sum += values[Math.floor(random() * values.length)];
      }
    }
    deltas[iteration] = sum / pairs.length;
  }
  return { lower: quantile(deltas, 0.05), upper: quantile(deltas, 0.95) };
}

function pairedQualityEvidence(pairs: readonly FormalPair[]): FormalCategoryQualityEvidenceV1 {
  if (pairs.length === 0) fail("FormalEval quality evidence", "requires at least one pair");
  const directPasses = pairs.filter((pair) => pair.direct.acceptance.pass).length;
  const workerPasses = pairs.filter((pair) => pair.worker.acceptance.pass).length;
  const directOnlyPasses = pairs.filter(
    (pair) => pair.direct.acceptance.pass && !pair.worker.acceptance.pass
  ).length;
  const workerOnlyPasses = pairs.filter(
    (pair) => !pair.direct.acceptance.pass && pair.worker.acceptance.pass
  ).length;
  const bounds = stratifiedBootstrapBounds(pairs);
  return {
    task_count: pairs.length,
    direct_pass_rate: directPasses / pairs.length,
    worker_pass_rate: workerPasses / pairs.length,
    pass_delta: (workerPasses - directPasses) / pairs.length,
    one_sided_95_lower_bound: bounds.lower,
    one_sided_95_upper_bound: bounds.upper,
    direct_only_passes: directOnlyPasses,
    worker_only_passes: workerOnlyPasses,
    discordant_pairs: directOnlyPasses + workerOnlyPasses
  };
}

/** Exact two-sided McNemar p-value, conditioning on the number of discordant pairs. */
export function mcnemarExactTwoSided(directOnlyPasses: number, workerOnlyPasses: number): number {
  if (
    !Number.isInteger(directOnlyPasses) ||
    !Number.isInteger(workerOnlyPasses) ||
    directOnlyPasses < 0 ||
    workerOnlyPasses < 0
  ) {
    fail("McNemar counts", "must be non-negative integers");
  }
  const discordant = directOnlyPasses + workerOnlyPasses;
  if (discordant === 0) return 1;
  const tailEnd = Math.min(directOnlyPasses, workerOnlyPasses);
  let probability = 2 ** -discordant;
  let tail = probability;
  for (let successes = 1; successes <= tailEnd; successes += 1) {
    probability *= (discordant - successes + 1) / successes;
    tail += probability;
  }
  return Math.min(1, 2 * tail);
}

function standardNormalCdf(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return 1;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const polynomial =
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = 1 - (Math.exp((-absolute * absolute) / 2) / Math.sqrt(2 * Math.PI)) * polynomial;
  return value >= 0 ? upper : 1 - upper;
}

/** Pre-registered power = Phi(0.05 / sqrt(q/n) - 1.6448536), q = discordant/n. */
function noninferiorityPower(discordant: number, sampleSize: number): number {
  if (discordant === 0) return 1;
  const discordantRate = discordant / sampleSize;
  return standardNormalCdf(0.05 / Math.sqrt(discordantRate / sampleSize) - 1.6448536);
}

function premiumTokens(span: EvalSpanV1): number {
  return span.usage.premium.input_tokens + span.usage.premium.output_tokens;
}

/** Run the pre-registered formal effectiveness gate over one exact paired task set. */
export function evaluateFormalEval(
  spans: readonly EvalSpanV1[],
  manifestValue: FormalEvalManifestV1
): FormalEvalSummaryV1 {
  const manifest = validateFormalEvalManifest(manifestValue);
  const pairs = exactPairs(spans, manifest);
  const taskCount = pairs.length;

  const directPremiumTokens = pairs.reduce((sum, pair) => sum + premiumTokens(pair.direct), 0);
  const workerPremiumTokens = pairs.reduce((sum, pair) => sum + premiumTokens(pair.worker), 0);
  const directCost = pairs.reduce((sum, pair) => sum + pair.direct.usage.total_cost_usd, 0);
  const workerCost = pairs.reduce((sum, pair) => sum + pair.worker.usage.total_cost_usd, 0);
  if (directPremiumTokens <= 0) fail("FormalEval premium tokens", "direct total must be greater than zero");
  if (directCost <= 0) fail("FormalEval total cost", "direct total must be greater than zero");

  const premiumReduction = 1 - workerPremiumTokens / directPremiumTokens;
  const costReduction = 1 - workerCost / directCost;
  const premiumMeetsThreshold = premiumReduction + 1e-12 >= 0.5;
  const costMeetsThreshold = costReduction + 1e-12 >= 0.3;
  const quality = pairedQualityEvidence(pairs);
  const categoryQuality = Object.fromEntries(
    FORMAL_EVAL_CATEGORIES.map((category) => [
      category,
      pairedQualityEvidence(pairs.filter((pair) => pair.task.category === category))
    ])
  ) as Record<FormalEvalCategory, FormalCategoryQualityEvidenceV1>;
  const directOnlyPasses = quality.direct_only_passes;
  const workerOnlyPasses = quality.worker_only_passes;
  const discordantPairs = quality.discordant_pairs;
  const directPassRate = quality.direct_pass_rate;
  const workerPassRate = quality.worker_pass_rate;
  const passDelta = quality.pass_delta;
  const lowerBound = quality.one_sided_95_lower_bound;
  const power = noninferiorityPower(discordantPairs, taskCount);
  const routedOnlyCriticalDefects = pairs.reduce(
    (sum, pair) => {
      const directIds = new Set(pair.direct.acceptance.critical_defect_ids);
      return sum + pair.worker.acceptance.critical_defect_ids.filter((id) => !directIds.has(id)).length;
    },
    0
  );

  const categoryCounts = emptyCategoryCounts();
  const sourceCounts: Record<FormalEvalSource, number> = { real: 0, edge: 0 };
  let visualTaskCount = 0;
  for (const task of manifest.tasks) {
    categoryCounts[task.category] += 1;
    sourceCounts[task.source] += 1;
    if (task.visual) visualTaskCount += 1;
  }

  const reasonCodes: string[] = [];
  if (!premiumMeetsThreshold) reasonCodes.push("premium_token_reduction_below_0.50");
  if (!costMeetsThreshold) reasonCodes.push("total_cost_reduction_below_0.30");
  if (routedOnlyCriticalDefects > 0) reasonCodes.push("routed_only_critical_defect");

  const powerSufficient = power >= 0.8;
  let status: FormalEvalStatus;
  let nextSampleSize: 250 | 300 | 350 | 400 | undefined;
  if (reasonCodes.length > 0) {
    status = "failed";
  } else if (!powerSufficient) {
    if (taskCount < 400) {
      status = "needs_more_tasks";
      nextSampleSize = (taskCount + 50) as 250 | 300 | 350 | 400;
      reasonCodes.push("quality_power_below_0.80");
    } else {
      status = "inconclusive";
      reasonCodes.push("quality_power_below_0.80_at_max_sample");
    }
  } else if (lowerBound + 1e-12 < -0.05) {
    status = "failed";
    reasonCodes.push("quality_noninferiority_failed");
  } else {
    status = "passed";
  }

  return {
    schema_version: 1,
    status,
    suite_id: manifest.suite_id,
    task_count: taskCount,
    span_count: spans.length,
    category_counts: categoryCounts,
    source_counts: sourceCounts,
    visual_task_count: visualTaskCount,
    metrics: {
      premium_tokens: {
        direct: directPremiumTokens,
        worker: workerPremiumTokens,
        reduction: premiumReduction,
        threshold: 0.5,
        meets_threshold: premiumMeetsThreshold
      },
      total_cost: {
        direct_usd: directCost,
        worker_usd: workerCost,
        reduction: costReduction,
        threshold: 0.3,
        meets_threshold: costMeetsThreshold
      },
      quality: {
        direct_pass_rate: directPassRate,
        worker_pass_rate: workerPassRate,
        pass_delta: passDelta,
        one_sided_95_lower_bound: lowerBound,
        one_sided_95_upper_bound: quality.one_sided_95_upper_bound,
        noninferiority_margin: -0.05,
        bootstrap_samples: FORMAL_EVAL_BOOTSTRAP_SAMPLES,
        bootstrap_seed: FORMAL_EVAL_BOOTSTRAP_SEED,
        meets_threshold: lowerBound + 1e-12 >= -0.05,
        by_category: categoryQuality
      },
      mcnemar: {
        direct_only_passes: directOnlyPasses,
        worker_only_passes: workerOnlyPasses,
        discordant_pairs: discordantPairs,
        p_value: mcnemarExactTwoSided(directOnlyPasses, workerOnlyPasses)
      },
      power: {
        method: "discordant_rate_normal_approximation",
        discordant_rate: discordantPairs / taskCount,
        value: power,
        threshold: 0.8,
        sufficient: powerSufficient
      },
      routed_only_critical_defects: routedOnlyCriticalDefects
    },
    reason_codes: reasonCodes,
    ...(nextSampleSize === undefined ? {} : { next_sample_size: nextSampleSize })
  };
}
