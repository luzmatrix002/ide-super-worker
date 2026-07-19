import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type RoutingEligibility = "eligible" | "ineligible" | "unknown";
export type RoutingSelection = "worker" | "main" | "unknown";
export type WorkerAcceptance = "accepted" | "rejected" | "not_applicable";

export interface RoutingObservationV1 {
  schema_version: 1;
  event: "routing_observation";
  scope: "hook_observable";
  phase: "pre" | "post";
  operation_id: string;
  policy_version: "routing-policy-v1";
  category: string;
  eligibility: RoutingEligibility;
  eligibility_reason_code: string;
  selected_route: RoutingSelection;
  worker_acceptance?: WorkerAcceptance;
  worker_execution_result?: "ok" | "infra_error" | "timeout" | "cancelled" | "not_attempted" | "unknown";
  workload_result?: "passed" | "failed" | "not_applicable" | "unknown";
  failure_class?: string;
  ts: string;
}

export interface HookInputV1 {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export interface RoutingCoverageV1 {
  scope: "hook_observable";
  eligible_total: number;
  worker_selected: number;
  worker_accepted: number;
  main_direct: number;
  worker_rejected: number;
  unknown: number;
  worker_selected_rate: number | null;
  effective_worker_coverage: number | null;
  main_direct_rate: number | null;
  routing_rejection_rate: number | null;
  unknown_rate: number | null;
}

function boundedString(value: unknown, max = 80): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function hash(value: string, secret?: string): string {
  return secret
    ? createHmac("sha256", secret).update(value).digest("hex")
    : createHash("sha256").update(value).digest("hex");
}

export function operationId(input: HookInputV1, secret = process.env.WORKER_ROUTING_HASH_KEY): string {
  const material = [input.session_id, input.turn_id, input.tool_use_id].map((item) => boundedString(item, 160) || "-").join("\0");
  return `${secret ? "hmac" : "correlation"}:${hash(material, secret).slice(0, 32)}`;
}

function commandFromInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const input = value as Record<string, unknown>;
  return typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
}

export function describeHookOperation(input: HookInputV1): Pick<RoutingObservationV1,
  "category" | "eligibility" | "eligibility_reason_code" | "selected_route"> {
  const tool = (boundedString(input.tool_name, 200) || "").toLowerCase();
  if (!tool) {
    return { category: "unknown", eligibility: "unknown", eligibility_reason_code: "tool_name_missing", selected_route: "unknown" };
  }
  if (tool.includes("codex_async_worker")) {
    const suffix = tool.split("__").at(-1) || "unknown";
    const category = suffix === "shell" ? "command_digest" : suffix === "read_pack" ? "context_pack" : suffix;
    return { category, eligibility: "eligible", eligibility_reason_code: "worker_tool", selected_route: "worker" };
  }
  if (/exec_command|bash|shell/.test(tool)) {
    const command = commandFromInput(input.tool_input);
    if (/\b(rg|git\s+diff|npm\s+(?:run\s+)?(?:test|build|lint|typecheck)|tsc|pytest|cargo\s+test)\b/i.test(command)) {
      const category = /\brg\b/i.test(command) ? "search" : /git\s+diff/i.test(command) ? "diff_digest" : "command_digest";
      return { category, eligibility: "eligible", eligibility_reason_code: "routable_main_command", selected_route: "main" };
    }
    return { category: "command", eligibility: "unknown", eligibility_reason_code: "command_scope_ambiguous", selected_route: "main" };
  }
  if (/apply_patch|write|edit/.test(tool)) {
    return { category: "mechanical_edit", eligibility: "unknown", eligibility_reason_code: "edit_scope_ambiguous", selected_route: "main" };
  }
  if (/read|search|grep/.test(tool)) {
    return { category: "context_pack", eligibility: "unknown", eligibility_reason_code: "read_scope_ambiguous", selected_route: "main" };
  }
  return { category: "unsupported", eligibility: "ineligible", eligibility_reason_code: "unsupported_tool", selected_route: "main" };
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function routingObservationFromHook(input: HookInputV1, now = new Date()): RoutingObservationV1 {
  const observed = describeHookOperation(input);
  const phase = /post/i.test(input.hook_event_name || "") || input.tool_response !== undefined ? "post" : "pre";
  const response = responseObject(input.tool_response);
  const status = boundedString(response?.status, 40);
  const isWorker = observed.selected_route === "worker";
  return {
    schema_version: 1,
    event: "routing_observation",
    scope: "hook_observable",
    phase,
    operation_id: operationId(input),
    policy_version: "routing-policy-v1",
    ...observed,
    ...(phase === "post" && isWorker
      ? {
          worker_acceptance: status === "rejected" ? "rejected" as const : "accepted" as const,
          worker_execution_result: status === "rejected" ? "not_attempted" as const : "unknown" as const,
          workload_result: status === "rejected" ? "not_applicable" as const : "unknown" as const,
          ...(status === "rejected" ? { failure_class: "request_rejected" } : {})
        }
      : {}),
    ts: now.toISOString()
  };
}

export function appendRoutingObservation(
  row: RoutingObservationV1,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const raw = env.WORKER_ROUTING_EVENTS_FILE?.trim();
  if (!raw) return false;
  try {
    fs.appendFileSync(path.resolve(raw), `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function routingCoverage(rows: readonly RoutingObservationV1[]): RoutingCoverageV1 {
  const posts = rows.filter((row) => row.phase === "post");
  const eligible = posts.filter((row) => row.eligibility === "eligible");
  const workerSelected = eligible.filter((row) => row.selected_route === "worker");
  const workerAccepted = workerSelected.filter((row) => row.worker_acceptance === "accepted");
  const workerRejected = workerSelected.filter((row) => row.worker_acceptance === "rejected");
  const mainDirect = eligible.filter((row) => row.selected_route === "main");
  const unknown = eligible.filter(
    (row) => row.selected_route === "unknown" || (row.selected_route === "worker" && row.worker_acceptance === undefined)
  );
  return {
    scope: "hook_observable",
    eligible_total: eligible.length,
    worker_selected: workerSelected.length,
    worker_accepted: workerAccepted.length,
    main_direct: mainDirect.length,
    worker_rejected: workerRejected.length,
    unknown: unknown.length,
    worker_selected_rate: ratio(workerSelected.length, eligible.length),
    effective_worker_coverage: ratio(workerAccepted.length, eligible.length),
    main_direct_rate: ratio(mainDirect.length, eligible.length),
    routing_rejection_rate: ratio(workerRejected.length, workerSelected.length),
    unknown_rate: ratio(unknown.length, eligible.length)
  };
}
