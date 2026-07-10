import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendEvalSpans,
  gateEvalSpans,
  importEvalSpanJsonl,
  parseEvalSpanJsonl,
  readEvalSpanJsonl,
  validateEvalSpan,
  type EvalSpanV1,
  type TokenCost
} from "../evaluation.js";

function measured(overrides: Partial<TokenCost> = {}): TokenCost {
  return {
    measurement: "measured",
    source: "provider_export",
    source_record_sha256: "a".repeat(64),
    producer_version: "test-producer-v1",
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 10,
    cost_usd: 0.012,
    ...overrides
  };
}

function span(arm: "direct" | "worker", overrides: Partial<EvalSpanV1> = {}): EvalSpanV1 {
  return {
    schema_version: 1,
    suite_id: "suite-1",
    task_id: "task-1",
    run_id: "run-1",
    span_id: `span-${arm}`,
    arm,
    fingerprint: {
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      workspace_fingerprint: "workspace-sha256",
      task_spec_sha256: "1".repeat(64),
      prompt_sha256: "2".repeat(64),
      premium_model: "gpt-5",
      permission_profile: "workspace-write",
      deadline_ms: 60_000,
      cache_policy: "disabled"
    },
    usage: {
      premium: measured(),
      worker:
        arm === "direct"
          ? {
              measurement: "not_applicable",
              source: "worker_not_used",
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              cost_usd: 0,
              reason: "direct arm does not call the worker"
            }
          : measured({ cost_usd: 0.003 }),
      cost_source: "price_snapshot",
      price_snapshot_id: "prices-2026-07-10",
      price_snapshot_sha256: "b".repeat(64),
      total_cost_usd: arm === "direct" ? 0.012 : 0.015
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
      outcome_status: "accepted",
      pass: true,
      evidence_complete: true,
      critical_defects: 0,
      critical_defect_ids: [],
      major_defects: 0,
      major_defect_ids: [],
      evaluator_version: "rubric-v1",
      artifact_refs: ["artifact://evidence-1"]
    },
    ...overrides
  };
}

const valid = span("direct");
assert.deepEqual(validateEvalSpan(valid), valid);

const missingCost = structuredClone(valid) as any;
delete missingCost.usage.premium.cost_usd;
assert.throws(() => validateEvalSpan(missingCost), /usage\.premium\.cost_usd/);

const inconsistentCost = structuredClone(valid) as any;
inconsistentCost.usage.total_cost_usd = 999;
assert.throws(() => validateEvalSpan(inconsistentCost), /must equal premium\.cost_usd \+ worker\.cost_usd/);

const forbiddenCostSource = structuredClone(valid) as any;
forbiddenCostSource.usage.premium.source = "JobResult.total_cost_usd";
assert.throws(() => validateEvalSpan(forbiddenCostSource), /supported token source/);

const premiumFromWorkerMetrics = structuredClone(valid) as any;
premiumFromWorkerMetrics.usage.premium.source = "worker_metrics";
assert.throws(() => validateEvalSpan(premiumFromWorkerMetrics), /Codex or provider export/);

const invalidFingerprintHash = structuredClone(valid) as any;
invalidFingerprintHash.fingerprint.prompt_sha256 = "not-a-sha256";
assert.throws(() => validateEvalSpan(invalidFingerprintHash), /prompt_sha256.*64-character SHA-256/);

const abbreviatedCommit = structuredClone(valid) as any;
abbreviatedCommit.fingerprint.commit_sha = "abcdef0";
assert.throws(() => validateEvalSpan(abbreviatedCommit), /full 40- or 64-character Git commit hash/);

const missingSourceRecord = structuredClone(valid) as any;
delete missingSourceRecord.usage.premium.source_record_sha256;
assert.throws(() => validateEvalSpan(missingSourceRecord), /source_record_sha256/);

const invalidNotApplicable = structuredClone(valid) as any;
invalidNotApplicable.usage.worker.reason = "";
assert.throws(() => validateEvalSpan(invalidNotApplicable), /usage\.worker\.reason/);

const inconsistentDefects = structuredClone(valid) as any;
inconsistentDefects.acceptance.critical_defects = 1;
inconsistentDefects.acceptance.critical_defect_ids = ["critical-1"];
assert.throws(() => validateEvalSpan(inconsistentDefects), /cannot be true when major or critical defects/);

const queueAtE2e = structuredClone(valid) as any;
queueAtE2e.timing.queue_wait_ms = 1_000;
assert.deepEqual(validateEvalSpan(queueAtE2e).timing, queueAtE2e.timing);
const queuePastE2e = structuredClone(valid) as any;
queuePastE2e.timing.queue_wait_ms = 1_001;
assert.throws(() => validateEvalSpan(queuePastE2e), /queue_wait_ms: must not exceed e2e_ms/);

// Timing tolerance is 1% of wall-clock elapsed time, bounded to [100 ms, 1,000 ms].
const timingFloorBoundary = structuredClone(valid) as any;
timingFloorBoundary.timing.e2e_ms = 1_100;
assert.equal(validateEvalSpan(timingFloorBoundary).timing.e2e_ms, 1_100);
const timingPastFloorBoundary = structuredClone(valid) as any;
timingPastFloorBoundary.timing.e2e_ms = 1_101;
assert.throws(() => validateEvalSpan(timingPastFloorBoundary), /within 100 ms/);

const timingRelativeBoundary = structuredClone(valid) as any;
timingRelativeBoundary.timing.ended_at = "2026-07-10T00:00:50.000Z";
timingRelativeBoundary.timing.e2e_ms = 50_500;
assert.equal(validateEvalSpan(timingRelativeBoundary).timing.e2e_ms, 50_500);
const timingPastRelativeBoundary = structuredClone(timingRelativeBoundary) as any;
timingPastRelativeBoundary.timing.e2e_ms = 50_501;
assert.throws(() => validateEvalSpan(timingPastRelativeBoundary), /within 500 ms/);

const timingCapBoundary = structuredClone(valid) as any;
timingCapBoundary.timing.ended_at = "2026-07-10T00:03:20.000Z";
timingCapBoundary.timing.e2e_ms = 201_000;
assert.equal(validateEvalSpan(timingCapBoundary).timing.e2e_ms, 201_000);
const timingPastCapBoundary = structuredClone(timingCapBoundary) as any;
timingPastCapBoundary.timing.e2e_ms = 201_001;
assert.throws(() => validateEvalSpan(timingPastCapBoundary), /within 1000 ms/);

const contentAddressedEvidence = structuredClone(valid) as any;
contentAddressedEvidence.acceptance.artifact_refs = [
  "artifact://evidence-1/slice-1",
  `sha256:${"c".repeat(64)}`
];
assert.deepEqual(
  validateEvalSpan(contentAddressedEvidence).acceptance.artifact_refs,
  contentAddressedEvidence.acceptance.artifact_refs
);
const noEvidenceRefs = structuredClone(valid) as any;
noEvidenceRefs.acceptance.artifact_refs = [];
assert.throws(() => validateEvalSpan(noEvidenceRefs), /must include at least one recoverable reference/);
const duplicateEvidenceRefs = structuredClone(valid) as any;
duplicateEvidenceRefs.acceptance.artifact_refs = ["artifact://evidence-1", "artifact://evidence-1"];
assert.throws(() => validateEvalSpan(duplicateEvidenceRefs), /must not contain duplicate values/);
const duplicateContentAddress = structuredClone(valid) as any;
duplicateContentAddress.acceptance.artifact_refs = [
  `sha256:${"d".repeat(64)}`,
  `sha256:${"D".repeat(64)}`
];
assert.throws(() => validateEvalSpan(duplicateContentAddress), /must not contain duplicate values/);
const malformedEvidenceRef = structuredClone(valid) as any;
malformedEvidenceRef.acceptance.artifact_refs = ["temporary-file.txt"];
assert.throws(() => validateEvalSpan(malformedEvidenceRef), /artifact:\/\/\.\.\. or sha256/);

const legacyJobResult = { job_status: "completed", total_cost_usd: 0.01 };
assert.throws(() => validateEvalSpan(legacyJobResult), /schema_version/);

const parsed = parseEvalSpanJsonl(`\uFEFF${JSON.stringify(valid)}\n\n`, "direct-export.jsonl");
assert.deepEqual(parsed, [valid]);
assert.throws(
  () => parseEvalSpanJsonl(`${JSON.stringify(valid)}\n{broken`, "direct-export.jsonl"),
  /direct-export\.jsonl:2: invalid JSON/
);

const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eval-span-import-"));
const importSource = path.join(importRoot, "source.jsonl");
const importTarget = path.join(importRoot, "nested", "eval-spans.jsonl");
appendEvalSpans([valid], importTarget);
fs.writeFileSync(importSource, `${JSON.stringify(span("worker"))}\n`, "utf8");
assert.equal(importEvalSpanJsonl(importSource, importTarget), 1);
assert.deepEqual(readEvalSpanJsonl(importTarget), [valid, span("worker")]);

const beforeRejectedImport = fs.readFileSync(importTarget, "utf8");
fs.writeFileSync(importSource, `${JSON.stringify(span("worker"))}\n{broken\n`, "utf8");
assert.throws(() => importEvalSpanJsonl(importSource, importTarget), /source\.jsonl:2: invalid JSON/);
assert.equal(fs.readFileSync(importTarget, "utf8"), beforeRejectedImport);

const metricsOnlyFile = path.join(importRoot, "worker-metrics.jsonl");
const previousMetricsFile = process.env.WORKER_METRICS_FILE;
const previousEvalFile = process.env.WORKER_EVAL_SPAN_FILE;
try {
  process.env.WORKER_METRICS_FILE = metricsOnlyFile;
  delete process.env.WORKER_EVAL_SPAN_FILE;
  assert.throws(() => appendEvalSpans([valid]), /WORKER_EVAL_SPAN_FILE/);
  assert.equal(fs.existsSync(metricsOnlyFile), false);
  process.env.WORKER_EVAL_SPAN_FILE = metricsOnlyFile;
  assert.throws(() => appendEvalSpans([valid]), /must not point to WORKER_METRICS_FILE/);
  assert.equal(fs.existsSync(metricsOnlyFile), false);
} finally {
  if (previousMetricsFile === undefined) delete process.env.WORKER_METRICS_FILE;
  else process.env.WORKER_METRICS_FILE = previousMetricsFile;
  if (previousEvalFile === undefined) delete process.env.WORKER_EVAL_SPAN_FILE;
  else process.env.WORKER_EVAL_SPAN_FILE = previousEvalFile;
}

const direct = span("direct");
const worker = span("worker");
const paired = gateEvalSpans([direct, worker]);
assert.equal(paired.span_count, 2);
assert.equal(paired.pair_count, 1);
assert.deepEqual(paired.suite_ids, ["suite-1"]);

const incompletePair = span("worker", {
  acceptance: { ...worker.acceptance, evidence_complete: false }
});
assert.throws(() => gateEvalSpans([direct, incompletePair]), /evidence_complete.*completed pair/);

const runningPair = span("worker", {
  acceptance: { ...worker.acceptance, outcome_status: "running" }
});
assert.throws(() => gateEvalSpans([direct, runningPair]), /outcome_status.*terminal/);
assert.throws(
  () => gateEvalSpans([direct, worker], { mode: "invalid" as "paired" }),
  /mode: must be paired or pilot/
);

const deterministicWorker = span("worker", {
  usage: {
    ...worker.usage,
    worker: measured({
      source: "worker_metrics",
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cost_usd: 0
    }),
    total_cost_usd: worker.usage.premium.cost_usd
  },
  routing: { ...worker.routing, lane: "deterministic", reason_codes: ["zero_llm"] }
});
assert.equal(gateEvalSpans([direct, deterministicWorker]).pair_count, 1);

const unprovenZeroWorker = span("worker", {
  usage: {
    ...worker.usage,
    worker: measured({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cost_usd: 0 }),
    total_cost_usd: worker.usage.premium.cost_usd
  },
  routing: { ...worker.routing, reason_codes: ["zero_llm"] }
});
assert.throws(() => validateEvalSpan(unprovenZeroWorker), /zero usage requires source worker_metrics/);

const unmarkedZeroWorker = span("worker", {
  usage: deterministicWorker.usage,
  routing: { ...worker.routing, lane: "deterministic", reason_codes: [] }
});
assert.throws(() => validateEvalSpan(unmarkedZeroWorker), /routing reason zero_llm/);

const falselyMarkedWorker = span("worker", {
  routing: { ...worker.routing, reason_codes: ["zero_llm"] }
});
assert.throws(() => validateEvalSpan(falselyMarkedWorker), /only valid when worker token usage is zero/);

const nonZeroWorkerFromMetrics = span("worker", {
  usage: {
    ...worker.usage,
    worker: measured({ source: "worker_metrics", cost_usd: 0.003 })
  }
});
assert.throws(() => validateEvalSpan(nonZeroWorkerFromMetrics), /non-zero worker usage must come from a provider export/);

const directWithWorkerUsage = span("direct", {
  usage: { ...direct.usage, worker: measured(), total_cost_usd: 0.024 }
});
assert.throws(() => validateEvalSpan(directWithWorkerUsage), /direct arm worker usage must be not_applicable/);

assert.throws(
  () => gateEvalSpans([direct, span("direct", { span_id: "span-direct-duplicate" })]),
  /must contain exactly one direct and one worker arm/
);
assert.throws(() => gateEvalSpans([direct]), /must contain exactly one direct and one worker arm/);
assert.throws(
  () => gateEvalSpans([direct, span("worker", { span_id: direct.span_id })]),
  /span_id must be globally unique/
);

assert.throws(
  () =>
    gateEvalSpans([
      direct,
      span("worker", {
        fingerprint: { ...worker.fingerprint, premium_model: "different-model" }
      })
    ]),
  /fingerprint\.premium_model: must match/
);
assert.throws(
  () =>
    gateEvalSpans([
      direct,
      span("worker", {
        usage: { ...worker.usage, price_snapshot_id: "different-prices" }
      })
    ]),
  /usage\.price_snapshot_id: must match/
);

const isolatedDirect = span("direct", {
  fingerprint: { ...direct.fingerprint, cache_policy: "isolated", cache_namespace: "shared-cache" }
});
const isolatedWorker = span("worker", {
  fingerprint: { ...worker.fingerprint, cache_policy: "isolated", cache_namespace: "shared-cache" }
});
assert.throws(() => gateEvalSpans([isolatedDirect, isolatedWorker]), /cache namespaces must differ/);
assert.equal(
  gateEvalSpans([
    isolatedDirect,
    span("worker", {
      fingerprint: { ...worker.fingerprint, cache_policy: "isolated", cache_namespace: "worker-cache" }
    })
  ]).pair_count,
  1
);

const reusedCacheSpans = [1, 2].flatMap((index) => [
  span("direct", {
    task_id: `cache-task-${index}`,
    run_id: `cache-run-${index}`,
    span_id: `cache-direct-${index}`,
    fingerprint: {
      ...direct.fingerprint,
      cache_policy: "isolated",
      cache_namespace: "direct-shared"
    }
  }),
  span("worker", {
    task_id: `cache-task-${index}`,
    run_id: `cache-run-${index}`,
    span_id: `cache-worker-${index}`,
    fingerprint: {
      ...worker.fingerprint,
      cache_policy: "isolated",
      cache_namespace: `worker-${index}`
    }
  })
]);
assert.throws(() => gateEvalSpans(reusedCacheSpans), /must be unique for every isolated span/);

function pilotSpans(): EvalSpanV1[] {
  return Array.from({ length: 10 }, (_, index) => {
    const identity = {
      task_id: `pilot-task-${index + 1}`,
      run_id: `pilot-run-${index + 1}`
    };
    return [
      span("direct", { ...identity, span_id: `pilot-direct-${index + 1}` }),
      span("worker", { ...identity, span_id: `pilot-worker-${index + 1}` })
    ];
  }).flat();
}

const pilot = pilotSpans();
assert.deepEqual(gateEvalSpans(pilot, { mode: "pilot" }), {
  mode: "pilot",
  span_count: 20,
  pair_count: 10,
  suite_ids: ["suite-1"]
});
assert.throws(() => gateEvalSpans(pilot.slice(0, 18), { mode: "pilot" }), /exactly 10 pairs and 20 spans/);

const incompletePilot = pilotSpans();
incompletePilot[0] = span("direct", {
  task_id: "pilot-task-1",
  run_id: "pilot-run-1",
  span_id: "pilot-direct-1",
  acceptance: { ...incompletePilot[0].acceptance, evidence_complete: false }
});
assert.throws(() => gateEvalSpans(incompletePilot, { mode: "pilot" }), /evidence_complete.*completed pair/);

const routedCriticalPilot = pilotSpans();
routedCriticalPilot[1] = span("worker", {
  task_id: "pilot-task-1",
  run_id: "pilot-run-1",
  span_id: "pilot-worker-1",
  acceptance: {
    ...routedCriticalPilot[1].acceptance,
    pass: false,
    outcome_status: "rejected",
    critical_defects: 1,
    critical_defect_ids: ["worker-only-critical"]
  }
});
assert.throws(() => gateEvalSpans(routedCriticalPilot, { mode: "pilot" }), /routed-only critical defect/);

const frozenCorpus = JSON.parse(fs.readFileSync("eval/fixtures/pilot-v1.json", "utf8"));
const frozenPilotSpans = frozenCorpus.tasks.flatMap((task: any, index: number) => {
  const identity = {
    suite_id: frozenCorpus.suite_id,
    task_id: task.task_id,
    run_id: `frozen-run-${index + 1}`
  };
  const fingerprint = {
    ...valid.fingerprint,
    workspace_fingerprint: `frozen-workspace-${index + 1}`,
    task_spec_sha256: task.task_spec_sha256,
    prompt_sha256: task.prompt_sha256
  };
  return [
    span("direct", { ...identity, span_id: `frozen-direct-${index + 1}`, fingerprint }),
    span("worker", { ...identity, span_id: `frozen-worker-${index + 1}`, fingerprint })
  ];
});
const frozenPilotFile = path.join(importRoot, "frozen-pilot.jsonl");
fs.writeFileSync(frozenPilotFile, `${frozenPilotSpans.map((item: EvalSpanV1) => JSON.stringify(item)).join("\n")}\n`);
const frozenPilotRun = spawnSync(
  process.execPath,
  ["scripts/eval_gate.mjs", "--input", frozenPilotFile, "--mode", "pilot"],
  { cwd: process.cwd(), encoding: "utf8" }
);
assert.equal(frozenPilotRun.status, 0, frozenPilotRun.stderr);

const tamperedPromptSpans = frozenPilotSpans.map((item: EvalSpanV1, index: number) =>
  index < 2
    ? { ...item, fingerprint: { ...item.fingerprint, prompt_sha256: "f".repeat(64) } }
    : item
);
const tamperedPilotFile = path.join(importRoot, "tampered-pilot.jsonl");
fs.writeFileSync(tamperedPilotFile, `${tamperedPromptSpans.map((item: EvalSpanV1) => JSON.stringify(item)).join("\n")}\n`);
const tamperedPilotRun = spawnSync(
  process.execPath,
  ["scripts/eval_gate.mjs", "--input", tamperedPilotFile, "--mode", "pilot"],
  { cwd: process.cwd(), encoding: "utf8" }
);
assert.equal(tamperedPilotRun.status, 2);
assert.match(tamperedPilotRun.stderr, /prompt_sha256 does not match/);

console.log("evaluation contract tests passed");
