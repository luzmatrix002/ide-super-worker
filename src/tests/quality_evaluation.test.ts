import assert from "node:assert/strict";
import {
  evaluateQualityTrials,
  validateQualityEvalPair,
  type QualityEvalCategory,
  type QualityEvalPairV1,
  type QualityEvalTrial,
  type QualityTrialSummaryV1
} from "../quality_evaluation.js";

const CATEGORIES: readonly QualityEvalCategory[] = ["analyze_diagnosis", "review"];
const BASELINE_SHA = "a".repeat(64);
const CANDIDATE_SHA = "b".repeat(64);

function pair(
  trial: QualityEvalTrial,
  category: QualityEvalCategory,
  index: number,
  overrides: Partial<QualityEvalPairV1> = {}
): QualityEvalPairV1 {
  return {
    schema_version: 1,
    trial,
    category,
    source: index % 10 < 7 ? "real" : "edge",
    repo_id: `repo-${index % 20}`,
    task_id: `${trial}-${category}-${index}`,
    evaluator_version: "quality-rubric-v1",
    baseline_config_sha256: BASELINE_SHA,
    candidate_config_sha256: CANDIDATE_SHA,
    blind_evaluator: true,
    baseline_pass: false,
    candidate_pass: true,
    candidate_only_critical_ids: [],
    ...overrides
  };
}

function stagePairs(
  trial: QualityEvalTrial,
  size: 200 | 500,
  outcome: (category: QualityEvalCategory, index: number) => Pick<
    QualityEvalPairV1,
    "baseline_pass" | "candidate_pass"
  > = () => ({ baseline_pass: false, candidate_pass: true })
): QualityEvalPairV1[] {
  return CATEGORIES.flatMap((category) =>
    Array.from({ length: size }, (_, index) =>
      pair(trial, category, index, outcome(category, index))
    )
  );
}

function trial(summary: ReturnType<typeof evaluateQualityTrials>, id: QualityEvalTrial): QualityTrialSummaryV1 {
  const value = summary.trials.find((candidate) => candidate.trial === id);
  assert(value, `missing Trial ${id}`);
  return value;
}

const valid = pair("A", "analyze_diagnosis", 1);
assert.deepEqual(validateQualityEvalPair(valid), valid);
assert.throws(
  () => validateQualityEvalPair({ ...valid, schema_version: 2 }),
  /schema_version.*must equal 1/
);
assert.throws(
  () => validateQualityEvalPair({ ...valid, blind_evaluator: false }),
  /blind_evaluator.*must be true/
);
assert.throws(
  () => validateQualityEvalPair({ ...valid, baseline_config_sha256: "bad" }),
  /baseline_config_sha256.*SHA-256/
);
assert.throws(
  () =>
    validateQualityEvalPair({
      ...valid,
      candidate_pass: true,
      candidate_only_critical_ids: ["critical-1"]
    }),
  /candidate_pass.*false.*critical/
);
assert.throws(
  () => evaluateQualityTrials([pair("B", "analyze_diagnosis", 0)]),
  /Trial B.*without Trial A/
);
assert.throws(
  () =>
    evaluateQualityTrials([
      pair("A", "analyze_diagnosis", 0),
      pair("A", "review", 0, { task_id: "A-analyze_diagnosis-0" })
    ]),
  /task_id.*unique within each trial/
);

const trialAOnly = evaluateQualityTrials(stagePairs("A", 200));
assert.equal(trialAOnly.status, "inconclusive");
assert.equal(trialAOnly.highest_qualified_trial, "A");
assert.deepEqual(trialAOnly.trial_order, ["A", "B", "C"]);
assert.equal(trialAOnly.bootstrap.method, "repo_cluster_paired_percentile");
const trialASummary = trial(trialAOnly, "A");
assert.equal(trialASummary.status, "passed");
assert.equal(trialASummary.categories.analyze_diagnosis.task_count, 200);
assert.equal(trialASummary.categories.analyze_diagnosis.repo_count, 20);
assert.deepEqual(trialASummary.categories.analyze_diagnosis.source_counts, { real: 140, edge: 60 });
assert.equal(trialASummary.categories.analyze_diagnosis.alpha_spent, 0.01);
assert.equal(trialASummary.categories.analyze_diagnosis.confidence_level, 0.99);
assert.equal(trialASummary.categories.analyze_diagnosis.one_sided_lower_bound, 1);

const completeSequence = evaluateQualityTrials([
  ...stagePairs("A", 200),
  ...stagePairs("B", 200),
  ...stagePairs("C", 200)
]);
assert.equal(completeSequence.status, "passed");
assert.equal(completeSequence.highest_qualified_trial, "C");
assert(completeSequence.reason_codes.includes("all_trials_passed"));
assert.equal(trial(completeSequence, "B").status, "passed");
assert.equal(trial(completeSequence, "C").status, "passed");

const extensionStage = evaluateQualityTrials(stagePairs("A", 500));
assert.equal(trial(extensionStage, "A").categories.review.stage_sample_size, 500);
assert.equal(trial(extensionStage, "A").categories.review.alpha_spent, 0.015);
assert.equal(trial(extensionStage, "A").categories.review.confidence_level, 0.985);
assert.equal(trial(extensionStage, "A").categories.review.cumulative_alpha_limit, 0.025);

const notAtLook = evaluateQualityTrials([
  ...Array.from({ length: 250 }, (_, index) => pair("A", "analyze_diagnosis", index)),
  ...Array.from({ length: 250 }, (_, index) => pair("A", "review", index))
]);
assert.equal(trial(notAtLook, "A").status, "inconclusive");
assert.equal(trial(notAtLook, "A").categories.review.one_sided_lower_bound, null);
assert(
  trial(notAtLook, "A").categories.review.reason_codes.includes(
    "sample_size_not_at_preregistered_look"
  )
);

const wrongSourceMix = evaluateQualityTrials(
  stagePairs("A", 200).map((candidate, index) => ({ ...candidate, source: index % 2 === 0 ? "real" as const : "edge" as const }))
);
assert.equal(trial(wrongSourceMix, "A").status, "inconclusive");
assert(
  trial(wrongSourceMix, "A").categories.review.reason_codes.includes("source_mix_must_be_70_30")
);

assert.throws(
  () => evaluateQualityTrials(stagePairs("A", 200).map((candidate, index) => ({
    ...candidate,
    candidate_config_sha256: index === 0 ? "c".repeat(64) : candidate.candidate_config_sha256
  }))),
  /one frozen baseline and candidate config fingerprint/
);

const blockedSequence = evaluateQualityTrials([
  ...stagePairs("A", 200, () => ({ baseline_pass: true, candidate_pass: true })),
  ...stagePairs("B", 200)
]);
assert.equal(trial(blockedSequence, "A").status, "inconclusive");
assert.equal(trial(blockedSequence, "B").status, "inconclusive");
assert.equal(trial(blockedSequence, "B").blocked_by, "A");
assert.equal(trial(blockedSequence, "B").categories.review.one_sided_lower_bound, null);

const qualityFailure = evaluateQualityTrials(
  stagePairs("A", 200, (category) =>
    category === "analyze_diagnosis"
      ? { baseline_pass: true, candidate_pass: false }
      : { baseline_pass: false, candidate_pass: true }
  )
);
assert.equal(qualityFailure.status, "failed");
assert.equal(trial(qualityFailure, "A").status, "failed");
assert.equal(
  trial(qualityFailure, "A").categories.analyze_diagnosis.one_sided_lower_bound,
  -1
);
assert(
  trial(qualityFailure, "A").categories.analyze_diagnosis.reason_codes.includes(
    "quality_lower_bound_below_minus_0_02"
  )
);

const earlyCritical = evaluateQualityTrials([
  pair("A", "analyze_diagnosis", 0, {
    candidate_pass: false,
    candidate_only_critical_ids: ["worker-only-critical"]
  }),
  pair("A", "review", 0)
]);
assert.equal(earlyCritical.status, "failed");
assert.equal(trial(earlyCritical, "A").categories.analyze_diagnosis.status, "failed");
assert.deepEqual(
  trial(earlyCritical, "A").categories.analyze_diagnosis.candidate_only_critical_ids,
  ["worker-only-critical"]
);
assert.equal(
  trial(earlyCritical, "A").categories.analyze_diagnosis.one_sided_lower_bound,
  null
);

const oneRepo = evaluateQualityTrials(
  stagePairs("A", 200).map((candidate) => ({ ...candidate, repo_id: "only-repo" }))
);
assert.equal(trial(oneRepo, "A").categories.review.status, "inconclusive");
assert.equal(trial(oneRepo, "A").categories.review.one_sided_lower_bound, null);
assert(
  trial(oneRepo, "A").categories.review.reason_codes.includes("insufficient_repo_clusters")
);

const clusteredPairs = stagePairs("A", 200).map((candidate) => {
  if (candidate.category !== "analyze_diagnosis") return candidate;
  const index = Number(candidate.task_id.split("-").at(-1));
  return {
    ...candidate,
    repo_id: index === 199 ? "small-losing-repo" : "large-winning-repo",
    baseline_pass: index === 199,
    candidate_pass: index !== 199
  };
});
const clusteredFirst = evaluateQualityTrials(clusteredPairs);
const clusteredSecond = evaluateQualityTrials(clusteredPairs);
assert.deepEqual(clusteredSecond, clusteredFirst);
assert.equal(
  trial(clusteredFirst, "A").categories.analyze_diagnosis.one_sided_lower_bound,
  -1
);

console.log("quality evaluation tests passed");
