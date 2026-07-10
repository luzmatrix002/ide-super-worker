import * as fs from "node:fs";
import * as path from "node:path";
import { OUTCOME_STATUSES, type OutcomeStatus } from "./outcome.js";

export const EVAL_SPAN_SCHEMA_VERSION = 1 as const;

export type EvalArm = "direct" | "worker";
export type TokenMeasurement = "measured" | "not_applicable";
export type TokenSource =
  | "codex_export"
  | "provider_export"
  | "worker_metrics"
  | "worker_not_used";
export type CachePolicy = "disabled" | "isolated";

export interface TokenCost {
  measurement: TokenMeasurement;
  source: TokenSource;
  source_record_sha256?: string;
  producer_version?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  reason?: string;
}

export interface EvalSpanV1 {
  schema_version: typeof EVAL_SPAN_SCHEMA_VERSION;
  suite_id: string;
  task_id: string;
  run_id: string;
  span_id: string;
  arm: EvalArm;
  fingerprint: {
    commit_sha: string;
    workspace_fingerprint: string;
    task_spec_sha256: string;
    prompt_sha256: string;
    premium_model: string;
    permission_profile: string;
    deadline_ms: number;
    cache_policy: CachePolicy;
    cache_namespace?: string;
  };
  usage: {
    premium: TokenCost;
    worker: TokenCost;
    cost_source: "billing_export" | "price_snapshot";
    price_snapshot_id: string;
    price_snapshot_sha256: string;
    total_cost_usd: number;
  };
  timing: {
    started_at: string;
    ended_at: string;
    e2e_ms: number;
    queue_wait_ms: number;
  };
  routing: {
    lane: string;
    reason_codes: string[];
    route_error_count: number;
    fallback_count: number;
  };
  acceptance: {
    outcome_status: OutcomeStatus;
    pass: boolean;
    evidence_complete: boolean;
    critical_defects: number;
    critical_defect_ids: string[];
    major_defects: number;
    major_defect_ids: string[];
    evaluator_version: string;
    artifact_refs: string[];
  };
}

export interface EvalPairV1 {
  key: string;
  direct: EvalSpanV1;
  worker: EvalSpanV1;
}

export interface EvalGateSummary {
  mode: "paired" | "pilot";
  span_count: number;
  pair_count: number;
  suite_ids: string[];
}

export class EvalContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalContractError";
  }
}

function fail(location: string, message: string): never {
  throw new EvalContractError(`${location}: ${message}`);
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

function nonNegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(location, "must be a finite non-negative number");
  }
  return value;
}

function nonNegativeInteger(value: unknown, location: string): number {
  const number = nonNegativeNumber(value, location);
  if (!Number.isInteger(number)) fail(location, "must be an integer");
  return number;
}

function booleanValue(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean");
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  return value.map((item, index) => nonEmptyString(item, `${location}[${index}]`));
}

function uniqueStringArray(value: unknown, location: string): string[] {
  const values = stringArray(value, location);
  if (new Set(values).size !== values.length) fail(location, "must not contain duplicate values");
  return values;
}

function artifactRefs(value: unknown, location: string): string[] {
  const refs = stringArray(value, location).map((ref) =>
    /^sha256:[0-9a-f]{64}$/i.test(ref) ? ref.toLowerCase() : ref
  );
  if (refs.length === 0) fail(location, "must include at least one recoverable reference");
  if (new Set(refs).size !== refs.length) fail(location, "must not contain duplicate values");
  for (const [index, ref] of refs.entries()) {
    const isArtifactUri = /^artifact:\/\/[^/?#\s]+(?:\/[^\s?#]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?$/.test(ref);
    const isContentAddress = /^sha256:[0-9a-f]{64}$/i.test(ref);
    if (!isArtifactUri && !isContentAddress) {
      fail(`${location}[${index}]`, "must use artifact://... or sha256:<64-hex> format");
    }
  }
  return refs;
}

function timestamp(value: unknown, location: string): string {
  const parsed = nonEmptyString(value, location);
  if (!Number.isFinite(Date.parse(parsed))) fail(location, "must be an ISO-compatible timestamp");
  return parsed;
}

function sha256Value(value: unknown, location: string): string {
  const hash = nonEmptyString(value, location);
  if (!/^[0-9a-f]{64}$/i.test(hash)) fail(location, "must be a 64-character SHA-256 hex digest");
  return hash.toLowerCase();
}

function commitShaValue(value: unknown, location: string): string {
  const hash = nonEmptyString(value, location);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) {
    fail(location, "must be a full 40- or 64-character Git commit hash");
  }
  return hash.toLowerCase();
}

function tokenCost(value: unknown, location: string): TokenCost {
  const input = record(value, location);
  const measurement = input.measurement;
  if (measurement !== "measured" && measurement !== "not_applicable") {
    fail(`${location}.measurement`, "must be measured or not_applicable");
  }
  const source = input.source;
  if (
    !["codex_export", "provider_export", "worker_metrics", "worker_not_used"].includes(
      String(source)
    )
  ) {
    fail(`${location}.source`, "must identify a supported token source");
  }
  const result: TokenCost = {
    measurement,
    source: source as TokenSource,
    input_tokens: nonNegativeInteger(input.input_tokens, `${location}.input_tokens`),
    output_tokens: nonNegativeInteger(input.output_tokens, `${location}.output_tokens`),
    cached_input_tokens: nonNegativeInteger(input.cached_input_tokens, `${location}.cached_input_tokens`),
    cost_usd: nonNegativeNumber(input.cost_usd, `${location}.cost_usd`)
  };
  if (measurement === "measured" && result.source === "worker_not_used") {
    fail(`${location}.source`, "worker_not_used is only valid when measurement is not_applicable");
  }
  if (measurement === "measured") {
    result.source_record_sha256 = sha256Value(
      input.source_record_sha256,
      `${location}.source_record_sha256`
    );
    result.producer_version = nonEmptyString(input.producer_version, `${location}.producer_version`);
  } else if (input.source_record_sha256 !== undefined || input.producer_version !== undefined) {
    fail(location, "not_applicable usage must omit source_record_sha256 and producer_version");
  }
  if (input.reason !== undefined) result.reason = nonEmptyString(input.reason, `${location}.reason`);
  if (measurement === "not_applicable") {
    if (result.source !== "worker_not_used") {
      fail(`${location}.source`, "must be worker_not_used when measurement is not_applicable");
    }
    if (!result.reason) fail(`${location}.reason`, "is required when measurement is not_applicable");
    if (
      result.input_tokens !== 0 ||
      result.output_tokens !== 0 ||
      result.cached_input_tokens !== 0 ||
      result.cost_usd !== 0
    ) {
      fail(location, "not_applicable token/cost values must all be zero");
    }
  }
  return result;
}

/** Validate an untrusted JSON value against the versioned EvalSpan contract. */
export function validateEvalSpan(value: unknown, location = "EvalSpanV1"): EvalSpanV1 {
  const input = record(value, location);
  if (input.schema_version !== EVAL_SPAN_SCHEMA_VERSION) {
    fail(`${location}.schema_version`, `must equal ${EVAL_SPAN_SCHEMA_VERSION}`);
  }
  const arm = input.arm;
  if (arm !== "direct" && arm !== "worker") fail(`${location}.arm`, "must be direct or worker");

  const fingerprint = record(input.fingerprint, `${location}.fingerprint`);
  const cachePolicy = fingerprint.cache_policy;
  if (cachePolicy !== "disabled" && cachePolicy !== "isolated") {
    fail(`${location}.fingerprint.cache_policy`, "must be disabled or isolated");
  }
  const cacheNamespace =
    fingerprint.cache_namespace === undefined
      ? undefined
      : nonEmptyString(fingerprint.cache_namespace, `${location}.fingerprint.cache_namespace`);
  if (cachePolicy === "disabled" && cacheNamespace !== undefined) {
    fail(`${location}.fingerprint.cache_namespace`, "must be omitted when cache_policy is disabled");
  }
  if (cachePolicy === "isolated" && cacheNamespace === undefined) {
    fail(`${location}.fingerprint.cache_namespace`, "is required when cache_policy is isolated");
  }

  const usage = record(input.usage, `${location}.usage`);
  const timing = record(input.timing, `${location}.timing`);
  const routing = record(input.routing, `${location}.routing`);
  const acceptance = record(input.acceptance, `${location}.acceptance`);
  const premiumUsage = tokenCost(usage.premium, `${location}.usage.premium`);
  const workerUsage = tokenCost(usage.worker, `${location}.usage.worker`);
  if (premiumUsage.measurement !== "measured") {
    fail(`${location}.usage.premium`, "must be measured");
  }
  if (premiumUsage.source !== "codex_export" && premiumUsage.source !== "provider_export") {
    fail(`${location}.usage.premium.source`, "must come from a Codex or provider export");
  }
  const costSource = usage.cost_source;
  if (costSource !== "billing_export" && costSource !== "price_snapshot") {
    fail(`${location}.usage.cost_source`, "must be billing_export or price_snapshot");
  }
  const totalCostUsd = nonNegativeNumber(usage.total_cost_usd, `${location}.usage.total_cost_usd`);
  const componentCost = premiumUsage.cost_usd + workerUsage.cost_usd;
  if (Math.abs(totalCostUsd - componentCost) > 1e-9) {
    fail(`${location}.usage.total_cost_usd`, "must equal premium.cost_usd + worker.cost_usd");
  }
  const outcomeStatus = nonEmptyString(
    acceptance.outcome_status,
    `${location}.acceptance.outcome_status`
  );
  if (!OUTCOME_STATUSES.includes(outcomeStatus as OutcomeStatus)) {
    fail(`${location}.acceptance.outcome_status`, `must be one of ${OUTCOME_STATUSES.join(", ")}`);
  }
  const criticalDefects = nonNegativeInteger(
    acceptance.critical_defects,
    `${location}.acceptance.critical_defects`
  );
  const criticalDefectIds = uniqueStringArray(
    acceptance.critical_defect_ids,
    `${location}.acceptance.critical_defect_ids`
  );
  const majorDefects = nonNegativeInteger(acceptance.major_defects, `${location}.acceptance.major_defects`);
  const majorDefectIds = uniqueStringArray(
    acceptance.major_defect_ids,
    `${location}.acceptance.major_defect_ids`
  );
  if (criticalDefects !== criticalDefectIds.length || majorDefects !== majorDefectIds.length) {
    fail(`${location}.acceptance`, "defect counts must equal their defect ID list lengths");
  }
  const passed = booleanValue(acceptance.pass, `${location}.acceptance.pass`);
  if (passed && (criticalDefects > 0 || majorDefects > 0)) {
    fail(`${location}.acceptance.pass`, "cannot be true when major or critical defects are present");
  }
  const startedAt = timestamp(timing.started_at, `${location}.timing.started_at`);
  const endedAt = timestamp(timing.ended_at, `${location}.timing.ended_at`);
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (elapsedMs < 0) {
    fail(`${location}.timing.ended_at`, "must not precede started_at");
  }
  const e2eMs = nonNegativeInteger(timing.e2e_ms, `${location}.timing.e2e_ms`);
  const queueWaitMs = nonNegativeInteger(timing.queue_wait_ms, `${location}.timing.queue_wait_ms`);
  if (queueWaitMs > e2eMs) {
    fail(`${location}.timing.queue_wait_ms`, "must not exceed e2e_ms");
  }
  // Wall-clock timestamps and monotonic duration measurements can differ slightly.
  // Allow 1% of timestamp elapsed time, with a 100 ms floor and a 1 s hard cap.
  const timingToleranceMs = Math.min(1_000, Math.max(100, Math.ceil(elapsedMs * 0.01)));
  if (Math.abs(e2eMs - elapsedMs) > timingToleranceMs) {
    fail(
      `${location}.timing.e2e_ms`,
      `must match ended_at - started_at within ${timingToleranceMs} ms`
    );
  }
  const reasonCodes = stringArray(routing.reason_codes, `${location}.routing.reason_codes`);
  if (arm === "direct" && workerUsage.measurement !== "not_applicable") {
    fail(`${location}.usage.worker`, "direct arm worker usage must be not_applicable");
  }
  if (arm === "worker") {
    if (workerUsage.measurement !== "measured") {
      fail(`${location}.usage.worker`, "worker arm worker usage must be measured");
    }
    const workerTokenTotal =
      workerUsage.input_tokens + workerUsage.output_tokens + workerUsage.cached_input_tokens;
    if (workerTokenTotal === 0) {
      if (
        workerUsage.source !== "worker_metrics" ||
        workerUsage.cost_usd !== 0 ||
        !reasonCodes.includes("zero_llm")
      ) {
        fail(
          `${location}.usage.worker`,
          "zero usage requires source worker_metrics, zero cost, and routing reason zero_llm"
        );
      }
    } else {
      if (workerUsage.source !== "provider_export") {
        fail(`${location}.usage.worker.source`, "non-zero worker usage must come from a provider export");
      }
      if (reasonCodes.includes("zero_llm")) {
        fail(`${location}.routing.reason_codes`, "zero_llm is only valid when worker token usage is zero");
      }
    }
  }

  return {
    schema_version: EVAL_SPAN_SCHEMA_VERSION,
    suite_id: nonEmptyString(input.suite_id, `${location}.suite_id`),
    task_id: nonEmptyString(input.task_id, `${location}.task_id`),
    run_id: nonEmptyString(input.run_id, `${location}.run_id`),
    span_id: nonEmptyString(input.span_id, `${location}.span_id`),
    arm,
    fingerprint: {
      commit_sha: commitShaValue(fingerprint.commit_sha, `${location}.fingerprint.commit_sha`),
      workspace_fingerprint: nonEmptyString(
        fingerprint.workspace_fingerprint,
        `${location}.fingerprint.workspace_fingerprint`
      ),
      task_spec_sha256: sha256Value(fingerprint.task_spec_sha256, `${location}.fingerprint.task_spec_sha256`),
      prompt_sha256: sha256Value(fingerprint.prompt_sha256, `${location}.fingerprint.prompt_sha256`),
      premium_model: nonEmptyString(fingerprint.premium_model, `${location}.fingerprint.premium_model`),
      permission_profile: nonEmptyString(
        fingerprint.permission_profile,
        `${location}.fingerprint.permission_profile`
      ),
      deadline_ms: nonNegativeInteger(fingerprint.deadline_ms, `${location}.fingerprint.deadline_ms`),
      cache_policy: cachePolicy,
      ...(cacheNamespace === undefined ? {} : { cache_namespace: cacheNamespace })
    },
    usage: {
      premium: premiumUsage,
      worker: workerUsage,
      cost_source: costSource,
      price_snapshot_id: nonEmptyString(usage.price_snapshot_id, `${location}.usage.price_snapshot_id`),
      price_snapshot_sha256: sha256Value(
        usage.price_snapshot_sha256,
        `${location}.usage.price_snapshot_sha256`
      ),
      total_cost_usd: totalCostUsd
    },
    timing: {
      started_at: startedAt,
      ended_at: endedAt,
      e2e_ms: e2eMs,
      queue_wait_ms: queueWaitMs
    },
    routing: {
      lane: nonEmptyString(routing.lane, `${location}.routing.lane`),
      reason_codes: reasonCodes,
      route_error_count: nonNegativeInteger(
        routing.route_error_count,
        `${location}.routing.route_error_count`
      ),
      fallback_count: nonNegativeInteger(routing.fallback_count, `${location}.routing.fallback_count`)
    },
    acceptance: {
      outcome_status: outcomeStatus as OutcomeStatus,
      pass: passed,
      evidence_complete: booleanValue(
        acceptance.evidence_complete,
        `${location}.acceptance.evidence_complete`
      ),
      critical_defects: criticalDefects,
      critical_defect_ids: criticalDefectIds,
      major_defects: majorDefects,
      major_defect_ids: majorDefectIds,
      evaluator_version: nonEmptyString(
        acceptance.evaluator_version,
        `${location}.acceptance.evaluator_version`
      ),
      artifact_refs: artifactRefs(acceptance.artifact_refs, `${location}.acceptance.artifact_refs`)
    }
  };
}

/** Parse JSONL without skipping malformed records. Blank lines are ignored. */
export function parseEvalSpanJsonl(text: string, source = "EvalSpan JSONL"): EvalSpanV1[] {
  const spans: EvalSpanV1[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`${source}:${index + 1}`, "invalid JSON");
    }
    spans.push(validateEvalSpan(value, `${source}:${index + 1}`));
  }
  return spans;
}

function evalSpanFile(file?: string): string {
  const configured = file ?? process.env.WORKER_EVAL_SPAN_FILE;
  if (!configured?.trim()) {
    fail("WORKER_EVAL_SPAN_FILE", "must be set when no output file is supplied");
  }
  const resolved = path.resolve(configured);
  const metricsFile = process.env.WORKER_METRICS_FILE?.trim();
  if (metricsFile && path.resolve(metricsFile) === resolved) {
    fail("WORKER_EVAL_SPAN_FILE", "must not point to WORKER_METRICS_FILE");
  }
  return resolved;
}

export function readEvalSpanJsonl(file: string): EvalSpanV1[] {
  const resolved = path.resolve(file);
  return parseEvalSpanJsonl(fs.readFileSync(resolved, "utf8"), resolved);
}

/** Validate the complete batch before appending any bytes to the target JSONL. */
export function appendEvalSpans(spans: readonly unknown[], file?: string): number {
  const validated = spans.map((span, index) => validateEvalSpan(span, `EvalSpan batch[${index}]`));
  if (validated.length === 0) return 0;
  const target = evalSpanFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${validated.map((span) => JSON.stringify(span)).join("\n")}\n`, "utf8");
  return validated.length;
}

export function appendEvalSpan(span: unknown, file?: string): void {
  appendEvalSpans([span], file);
}

/** Import a producer export only after every JSONL record passes the v1 contract. */
export function importEvalSpanJsonl(sourceFile: string, outputFile?: string): number {
  const source = path.resolve(sourceFile);
  const output = evalSpanFile(outputFile);
  if (source === output) fail("EvalSpan import", "source and output files must differ");
  const spans = readEvalSpanJsonl(source);
  return appendEvalSpans(spans, output);
}

function pairKey(span: EvalSpanV1): string {
  return JSON.stringify([span.suite_id, span.task_id, span.run_id]);
}

const FAIRNESS_FIELDS = [
  "commit_sha",
  "workspace_fingerprint",
  "task_spec_sha256",
  "prompt_sha256",
  "premium_model",
  "permission_profile",
  "deadline_ms",
  "cache_policy"
] as const;

function assertFairPair(pair: EvalPairV1): void {
  for (const field of FAIRNESS_FIELDS) {
    if (pair.direct.fingerprint[field] !== pair.worker.fingerprint[field]) {
      fail(`Eval pair ${pair.key}.fingerprint.${field}`, "must match across arms");
    }
  }

  if (pair.direct.usage.price_snapshot_id !== pair.worker.usage.price_snapshot_id) {
    fail(`Eval pair ${pair.key}.usage.price_snapshot_id`, "must match across arms");
  }
  if (
    pair.direct.usage.price_snapshot_sha256 !== pair.worker.usage.price_snapshot_sha256 ||
    pair.direct.usage.cost_source !== pair.worker.usage.cost_source
  ) {
    fail(`Eval pair ${pair.key}.usage`, "cost source and price snapshot hash must match across arms");
  }
  if (pair.direct.acceptance.evaluator_version !== pair.worker.acceptance.evaluator_version) {
    fail(`Eval pair ${pair.key}.acceptance.evaluator_version`, "must match across arms");
  }
  for (const span of [pair.direct, pair.worker]) {
    if (!span.acceptance.evidence_complete) {
      fail(`Eval pair ${pair.key}.${span.arm}.acceptance.evidence_complete`, "must be true for a completed pair");
    }
    if (span.acceptance.outcome_status === "running") {
      fail(`Eval pair ${pair.key}.${span.arm}.acceptance.outcome_status`, "must be terminal for a completed pair");
    }
  }

  const cachePolicy = pair.direct.fingerprint.cache_policy;
  if (
    cachePolicy === "isolated" &&
    pair.direct.fingerprint.cache_namespace === pair.worker.fingerprint.cache_namespace
  ) {
    fail(`Eval pair ${pair.key}.fingerprint`, "isolated cache namespaces must differ across arms");
  }

  if (pair.direct.usage.premium.measurement !== "measured") {
    fail(`Eval pair ${pair.key}.direct.usage.premium`, "must be measured");
  }
  if (pair.worker.usage.premium.measurement !== "measured") {
    fail(`Eval pair ${pair.key}.worker.usage.premium`, "must be measured");
  }
  for (const [location, usage] of [
    ["direct.usage.premium", pair.direct.usage.premium],
    ["worker.usage.premium", pair.worker.usage.premium]
  ] as const) {
    if (usage.input_tokens + usage.output_tokens === 0) {
      fail(`Eval pair ${pair.key}.${location}`, "measured token usage must not be empty");
    }
  }
}

function buildPairs(spans: EvalSpanV1[]): EvalPairV1[] {
  const byKey = new Map<string, EvalSpanV1[]>();
  const spanIds = new Set<string>();
  for (const span of spans) {
    if (spanIds.has(span.span_id)) fail(`EvalSpan ${span.span_id}`, "span_id must be globally unique");
    spanIds.add(span.span_id);
    const key = pairKey(span);
    const group = byKey.get(key) || [];
    group.push(span);
    byKey.set(key, group);
  }

  const pairs: EvalPairV1[] = [];
  for (const [key, group] of byKey) {
    const direct = group.filter((span) => span.arm === "direct");
    const worker = group.filter((span) => span.arm === "worker");
    if (group.length !== 2 || direct.length !== 1 || worker.length !== 1) {
      fail(`Eval pair ${key}`, "must contain exactly one direct and one worker arm");
    }
    const pair = { key, direct: direct[0], worker: worker[0] };
    assertFairPair(pair);
    pairs.push(pair);
  }
  const cacheNamespaces = new Set<string>();
  for (const span of spans) {
    if (span.fingerprint.cache_policy !== "isolated") continue;
    const namespace = span.fingerprint.cache_namespace as string;
    if (cacheNamespaces.has(namespace)) {
      fail(`EvalSpan ${span.span_id}.fingerprint.cache_namespace`, "must be unique for every isolated span");
    }
    cacheNamespaces.add(namespace);
  }
  return pairs;
}

/** Fail-closed paired-run gate. Pilot mode adds the operational 10-pair policy. */
export function gateEvalSpans(
  values: readonly unknown[],
  options: { mode?: "paired" | "pilot" } = {}
): EvalGateSummary {
  const mode = options.mode || "paired";
  if (mode !== "paired" && mode !== "pilot") fail("EvalSpan gate mode", "must be paired or pilot");
  const spans = values.map((span, index) => validateEvalSpan(span, `EvalSpan[${index}]`));
  if (spans.length === 0) fail("EvalSpan gate", "must include at least one pair");
  const pairs = buildPairs(spans);

  if (mode === "pilot") validatePilot(pairs, spans);

  return {
    mode,
    span_count: spans.length,
    pair_count: pairs.length,
    suite_ids: [...new Set(spans.map((span) => span.suite_id))].sort()
  };
}

function validatePilot(pairs: EvalPairV1[], spans: EvalSpanV1[]): void {
  if (pairs.length !== 10 || spans.length !== 20) {
    fail("EvalSpan pilot", "must contain exactly 10 pairs and 20 spans");
  }
  const suiteIds = new Set(spans.map((span) => span.suite_id));
  if (suiteIds.size !== 1) fail("EvalSpan pilot", "must contain exactly one suite_id");
  const taskIds = new Set(pairs.map((pair) => pair.direct.task_id));
  if (taskIds.size !== 10) fail("EvalSpan pilot", "must contain 10 distinct task_id values");

  for (const span of spans) {
    if (!span.acceptance.evidence_complete || span.acceptance.artifact_refs.length === 0) {
      fail(`EvalSpan pilot ${span.span_id}`, "evidence must be complete and include artifact_refs");
    }
    const premium = span.usage.premium;
    if (premium.input_tokens + premium.output_tokens === 0) {
      fail(`EvalSpan pilot ${span.span_id}.usage.premium`, "measured token usage must not be empty");
    }
  }

  for (const pair of pairs) {
    const directCriticalIds = new Set(pair.direct.acceptance.critical_defect_ids);
    if (pair.worker.acceptance.critical_defect_ids.some((id) => !directCriticalIds.has(id))) {
      fail(`EvalSpan pilot ${pair.key}`, "routed-only critical defect is not allowed");
    }
  }
}
