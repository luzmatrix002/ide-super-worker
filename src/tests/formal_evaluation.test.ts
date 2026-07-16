import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateFormalEval,
  mcnemarExactTwoSided,
  validateFormalEvalManifest,
  type FormalEvalCategory,
  type FormalEvalManifestV1
} from "../formal_evaluation.js";
import type { EvalSpanV1, TokenCost } from "../evaluation.js";

const CATEGORIES: readonly FormalEvalCategory[] = [
  "search_read",
  "analyze_diagnosis",
  "review",
  "bugfix",
  "small_feature_refactor",
  "test_log"
];

const BASE_QUOTAS: Record<FormalEvalCategory, number> = {
  search_read: 40,
  analyze_diagnosis: 35,
  review: 35,
  bugfix: 35,
  small_feature_refactor: 35,
  test_log: 20
};

function measured(tokens: number, costUsd: number): TokenCost {
  return {
    measurement: "measured",
    source: "provider_export",
    source_record_sha256: "a".repeat(64),
    producer_version: "formal-test-producer-v1",
    input_tokens: tokens - 10,
    output_tokens: 10,
    cached_input_tokens: 0,
    cost_usd: costUsd
  };
}

function notApplicable(): TokenCost {
  return {
    measurement: "not_applicable",
    source: "worker_not_used",
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cost_usd: 0,
    reason: "direct arm does not call the worker"
  };
}

function categorySequence(size: number): FormalEvalCategory[] {
  const categories = CATEGORIES.flatMap((category) => Array(BASE_QUOTAS[category]).fill(category));
  for (let index = categories.length; index < size; index += 1) {
    categories.push(CATEGORIES[(index - 200) % CATEGORIES.length]);
  }
  return categories;
}

function manifest(size = 200): FormalEvalManifestV1 {
  const realCount = Math.round(size * 0.7);
  return {
    schema_version: 1,
    suite_id: `formal-${size}`,
    evaluator_version: "rubric-v1",
    tasks: categorySequence(size).map((category, index) => ({
      task_id: `task-${String(index + 1).padStart(3, "0")}`,
      category,
      source: index < realCount ? "real" : "edge",
      visual: index < 10,
      task_spec_sha256: (index + 1).toString(16).padStart(64, "0"),
      prompt_sha256: (index + 10_001).toString(16).padStart(64, "0")
    }))
  };
}

function span(
  taskId: string,
  suiteId: string,
  arm: "direct" | "worker",
  index: number,
  pass: boolean,
  overrides: Partial<EvalSpanV1> = {}
): EvalSpanV1 {
  const premium = arm === "direct" ? measured(120, 0.012) : measured(40, 0.004);
  const worker = arm === "direct" ? notApplicable() : measured(80, 0.002);
  return {
    schema_version: 1,
    suite_id: suiteId,
    task_id: taskId,
    run_id: `run-${index + 1}`,
    span_id: `${suiteId}-${taskId}-${arm}`,
    arm,
    fingerprint: {
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      workspace_fingerprint: "workspace-sha256",
      task_spec_sha256: (index + 1).toString(16).padStart(64, "0"),
      prompt_sha256: (index + 10_001).toString(16).padStart(64, "0"),
      premium_model: "gpt-5",
      permission_profile: "workspace-write",
      deadline_ms: 60_000,
      cache_policy: "disabled"
    },
    usage: {
      premium,
      worker,
      cost_source: "price_snapshot",
      price_snapshot_id: "prices-2026-07-10",
      price_snapshot_sha256: "b".repeat(64),
      total_cost_usd: premium.cost_usd + worker.cost_usd
    },
    timing: {
      started_at: "2026-07-10T00:00:00.000Z",
      ended_at: "2026-07-10T00:00:01.000Z",
      e2e_ms: 1_000,
      queue_wait_ms: 0
    },
    routing: {
      lane: arm,
      reason_codes: [],
      route_error_count: 0,
      fallback_count: 0
    },
    acceptance: {
      outcome_status: pass ? "accepted" : "rejected",
      pass,
      evidence_complete: true,
      critical_defects: 0,
      critical_defect_ids: [],
      major_defects: 0,
      major_defect_ids: [],
      evaluator_version: "rubric-v1",
      artifact_refs: [`artifact://${taskId}/${arm}`]
    },
    ...overrides
  };
}

function spansFor(
  input: FormalEvalManifestV1,
  passPattern: (index: number) => { direct: boolean; worker: boolean } = () => ({
    direct: true,
    worker: true
  })
): EvalSpanV1[] {
  return input.tasks.flatMap((task, index) => {
    const passes = passPattern(index);
    return [
      span(task.task_id, input.suite_id, "direct", index, passes.direct),
      span(task.task_id, input.suite_id, "worker", index, passes.worker)
    ];
  });
}

const baseManifest = manifest();
assert.deepEqual(validateFormalEvalManifest(baseManifest), baseManifest);

assert.throws(() => validateFormalEvalManifest(manifest(250).tasks.slice(0, 201)), /must be an object/);
const invalidSize = { ...baseManifest, tasks: baseManifest.tasks.slice(0, 199) };
assert.throws(() => validateFormalEvalManifest(invalidSize), /sample size must be one of 200, 250, 300, 350, 400/);

const duplicateTask = structuredClone(baseManifest);
duplicateTask.tasks[1].task_id = duplicateTask.tasks[0].task_id;
assert.throws(() => validateFormalEvalManifest(duplicateTask), /task_id must be unique/);

const wrongQuota = structuredClone(baseManifest);
wrongQuota.tasks[0].category = "analyze_diagnosis";
assert.throws(() => validateFormalEvalManifest(wrongQuota), /category quota/);

const wrongSourceRatio = structuredClone(baseManifest);
wrongSourceRatio.tasks[139].source = "edge";
assert.throws(() => validateFormalEvalManifest(wrongSourceRatio), /140 real and 60 edge/);

const tooFewVisual = structuredClone(baseManifest);
for (const task of tooFewVisual.tasks) task.visual = false;
assert.throws(() => validateFormalEvalManifest(tooFewVisual), /at least 10 visual tasks/);

const invalidManifestHash = structuredClone(baseManifest);
invalidManifestHash.tasks[0].prompt_sha256 = "not-a-sha256";
assert.throws(() => validateFormalEvalManifest(invalidManifestHash), /prompt_sha256.*64-character SHA-256/);

const passedSpans = spansFor(baseManifest);
const passed = evaluateFormalEval(passedSpans, baseManifest);
assert.equal(passed.status, "passed");
assert.equal(passed.task_count, 200);
assert.equal(passed.metrics.premium_tokens.direct, 24_000);
assert.equal(passed.metrics.premium_tokens.worker, 8_000);
assert.ok(Math.abs(passed.metrics.premium_tokens.reduction - 2 / 3) < 1e-12);
assert.ok(Math.abs(passed.metrics.total_cost.reduction - 0.5) < 1e-12);
assert.equal(passed.metrics.quality.pass_delta, 0);
assert.equal(passed.metrics.quality.one_sided_95_lower_bound, 0);
assert.equal(passed.metrics.quality.one_sided_95_upper_bound, 0);
assert.equal(passed.metrics.quality.by_category.analyze_diagnosis.task_count, 35);
assert.equal(passed.metrics.quality.by_category.analyze_diagnosis.pass_delta, 0);
assert.equal(passed.metrics.quality.by_category.analyze_diagnosis.one_sided_95_lower_bound, 0);
assert.equal(passed.metrics.quality.by_category.analyze_diagnosis.one_sided_95_upper_bound, 0);
assert.equal(passed.metrics.quality.by_category.review.task_count, 35);
assert.equal(passed.metrics.quality.by_category.review.discordant_pairs, 0);
assert.equal(passed.metrics.power.value, 1);
assert.equal(passed.metrics.mcnemar.p_value, 1);

const missingTaskSpans = passedSpans.filter((candidate) => candidate.task_id !== "task-001");
assert.throws(() => evaluateFormalEval(missingTaskSpans, baseManifest), /exact task set/);

const mismatchedTaskFingerprint = [...passedSpans];
for (const index of [0, 1]) {
  mismatchedTaskFingerprint[index] = {
    ...mismatchedTaskFingerprint[index],
    fingerprint: { ...mismatchedTaskFingerprint[index].fingerprint, task_spec_sha256: "f".repeat(64) }
  };
}
assert.throws(
  () => evaluateFormalEval(mismatchedTaskFingerprint, baseManifest),
  /task\/prompt fingerprints must match/
);

const extraRunSpans = [
  ...passedSpans,
  span("task-001", baseManifest.suite_id, "direct", 999, true, {
    span_id: "extra-direct",
    run_id: "extra-run"
  }),
  span("task-001", baseManifest.suite_id, "worker", 999, true, {
    span_id: "extra-worker",
    run_id: "extra-run"
  })
];
assert.throws(() => evaluateFormalEval(extraRunSpans, baseManifest), /exact task set/);

const incompleteEvidence = [...passedSpans];
incompleteEvidence[0] = {
  ...incompleteEvidence[0],
  acceptance: { ...incompleteEvidence[0].acceptance, evidence_complete: false }
};
assert.throws(() => evaluateFormalEval(incompleteEvidence, baseManifest), /evidence_complete.*completed pair/);

const lowSavings = spansFor(baseManifest).map((candidate) => {
  if (candidate.arm !== "worker") return candidate;
  const premium = measured(80, 0.009);
  const worker = measured(80, 0.002);
  return {
    ...candidate,
    usage: { ...candidate.usage, premium, worker, total_cost_usd: premium.cost_usd + worker.cost_usd }
  };
});
const failedSavings = evaluateFormalEval(lowSavings, baseManifest);
assert.equal(failedSavings.status, "failed");
assert.ok(failedSavings.reason_codes.includes("premium_token_reduction_below_0.50"));
assert.ok(failedSavings.reason_codes.includes("total_cost_reduction_below_0.30"));

const criticalSpans = spansFor(baseManifest);
criticalSpans[1] = {
  ...criticalSpans[1],
  acceptance: {
    ...criticalSpans[1].acceptance,
    pass: false,
    outcome_status: "rejected",
    critical_defects: 1,
    critical_defect_ids: ["worker-only-critical"]
  }
};
const failedCritical = evaluateFormalEval(criticalSpans, baseManifest);
assert.equal(failedCritical.status, "failed");
assert.equal(failedCritical.metrics.routed_only_critical_defects, 1);

const differentCriticalSpans = spansFor(baseManifest);
differentCriticalSpans[0] = {
  ...differentCriticalSpans[0],
  acceptance: {
    ...differentCriticalSpans[0].acceptance,
    pass: false,
    outcome_status: "rejected",
    critical_defects: 1,
    critical_defect_ids: ["direct-critical"]
  }
};
differentCriticalSpans[1] = {
  ...differentCriticalSpans[1],
  acceptance: {
    ...differentCriticalSpans[1].acceptance,
    pass: false,
    outcome_status: "rejected",
    critical_defects: 1,
    critical_defect_ids: ["worker-different-critical"]
  }
};
assert.equal(evaluateFormalEval(differentCriticalSpans, baseManifest).metrics.routed_only_critical_defects, 1);

const underpowered = evaluateFormalEval(
  spansFor(baseManifest, (index) => ({
    direct: index < 20 || index >= 40,
    worker: index >= 20
  })),
  baseManifest
);
assert.equal(underpowered.metrics.mcnemar.discordant_pairs, 40);
assert.ok(underpowered.metrics.power.value < 0.8);
assert.equal(underpowered.status, "needs_more_tasks");
assert.equal(underpowered.next_sample_size, 250);

const manifest400 = manifest(400);
const underpowered400 = evaluateFormalEval(
  spansFor(manifest400, (index) => ({
    direct: index < 40 || index >= 80,
    worker: index >= 40
  })),
  manifest400
);
assert.ok(underpowered400.metrics.power.value < 0.8);
assert.equal(underpowered400.status, "inconclusive");
assert.equal(underpowered400.next_sample_size, undefined);

const qualityFailure = evaluateFormalEval(
  spansFor(baseManifest, (index) => ({ direct: true, worker: index >= 15 })),
  baseManifest
);
assert.ok(qualityFailure.metrics.power.value >= 0.8);
assert.ok(qualityFailure.metrics.quality.one_sided_95_lower_bound < -0.05);
assert.equal(qualityFailure.status, "failed");
assert.ok(qualityFailure.reason_codes.includes("quality_noninferiority_failed"));

const reviewRegression = evaluateFormalEval(
  spansFor(baseManifest, (index) => ({
    direct: true,
    worker: baseManifest.tasks[index].category !== "review" || index % 5 !== 0
  })),
  baseManifest
);
assert.equal(reviewRegression.metrics.quality.by_category.analyze_diagnosis.pass_delta, 0);
assert(reviewRegression.metrics.quality.by_category.review.pass_delta < -0.1);
assert.equal(
  reviewRegression.metrics.quality.by_category.review.direct_only_passes,
  reviewRegression.metrics.quality.by_category.review.discordant_pairs
);
assert.equal(reviewRegression.metrics.quality.by_category.review.worker_only_passes, 0);

assert.equal(mcnemarExactTwoSided(0, 0), 1);
assert.ok(Math.abs(mcnemarExactTwoSided(10, 0) - 0.001953125) < 1e-15);

const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formal-eval-cli-"));
function runCli(inputManifest: FormalEvalManifestV1, spans: EvalSpanV1[]) {
  const manifestFile = path.join(cliRoot, `${inputManifest.suite_id}-manifest.json`);
  const spansFile = path.join(cliRoot, `${inputManifest.suite_id}-spans.jsonl`);
  fs.writeFileSync(manifestFile, JSON.stringify(inputManifest), "utf8");
  fs.writeFileSync(spansFile, `${spans.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`, "utf8");
  return spawnSync(
    process.execPath,
    ["scripts/eval_formal.mjs", "--input", spansFile, "--manifest", manifestFile],
    { cwd: process.cwd(), encoding: "utf8" }
  );
}

const passedCli = runCli(baseManifest, passedSpans);
assert.equal(passedCli.status, 0);
const passedCliSummary = JSON.parse(passedCli.stdout);
assert.equal(passedCliSummary.metrics.quality.one_sided_95_upper_bound, 0);
assert.equal(passedCliSummary.metrics.quality.by_category.analyze_diagnosis.task_count, 35);
assert.equal(passedCliSummary.metrics.quality.by_category.review.task_count, 35);
assert.equal(runCli(baseManifest, lowSavings).status, 2);
assert.equal(
  runCli(
    baseManifest,
    spansFor(baseManifest, (index) => ({ direct: index < 20 || index >= 40, worker: index >= 20 }))
  ).status,
  3
);
assert.equal(
  runCli(
    manifest400,
    spansFor(manifest400, (index) => ({ direct: index < 40 || index >= 80, worker: index >= 40 }))
  ).status,
  4
);

console.log("formal evaluation tests passed");
