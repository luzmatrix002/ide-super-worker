import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { MAX_REVISE_PASSES } from "./config.js";
import { appendMetrics, type WorkerCategory } from "./metrics.js";
import type { StartJobInput } from "./types.js";

type MetricStatus = "ok" | "error" | "rejected";
export type ToolErrorClass =
  | "upstream_404"
  | "upstream_error"
  | "shell_mismatch"
  | "search_timeout"
  | "timeout"
  | "missing_command"
  | "missing_path"
  | "permission_denied"
  | "dependency_missing"
  | "unknown_failure";

export interface ToolErrorThresholds {
  overallMaxPct: number;
  singleToolMaxPct: number;
  categoryMaxPct: number;
  minCalls: number;
}

export interface ToolErrorGateBreach {
  scope: "overall" | "category" | "tool";
  category?: string;
  tool?: string;
  calls: number;
  errors: number;
  errorRate: number;
  maxPct: number;
}

export interface ToolErrorReview {
  status: "ok" | "breach" | "skipped";
  reason?: string;
  metricsFile?: string;
  sinceIso?: string;
  totalCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  thresholds: ToolErrorThresholds;
  breaches: ToolErrorGateBreach[];
}

export interface ToolErrorEscalation {
  active: true;
  triggeredAt: string;
  reason: "error_rate_breach" | "review_overdue";
  details: string[];
  startDefaults: Partial<StartJobInput>;
}

export interface ToolControlDecision {
  action: "allow" | "reject" | "degrade";
  reason: string;
  requiredAction: string;
  alternatives: string[];
  tool: string;
  category: string;
  errorClass?: ToolErrorClass;
  circuitKey?: string;
  expiresAt?: string;
}

interface ToolControlEvent {
  ts: number;
  tool: string;
  category: string;
  status: MetricStatus;
  errorClass?: ToolErrorClass;
}

interface ToolCircuit {
  key: string;
  tool: string;
  category: string;
  errorClass?: ToolErrorClass;
  openedAt: number;
  expiresAt: number;
  reason: string;
  requiredAction: string;
  alternatives: string[];
}

interface PersistedToolCircuitState {
  version: 1 | 2;
  savedAt: string;
  circuits: ToolCircuit[];
  events?: ToolControlEvent[];
  checksum?: string;
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
let activeEscalation: ToolErrorEscalation | undefined;
let reviewTimer: NodeJS.Timeout | undefined;
let nextReviewDueAt = 0;
const toolControlEvents: ToolControlEvent[] = [];
const openCircuits = new Map<string, ToolCircuit>();
let circuitStateLoaded = false;
let lastCircuitStateSaveAt = 0;
let lastCircuitStateSnapshot: string | undefined;

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = numberEnv(name);
  if (parsed === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function pctEnv(name: string, fallback: number): number {
  const parsed = numberEnv(name);
  return parsed === undefined || parsed < 0 ? fallback : parsed;
}

export function readToolErrorThresholds(): ToolErrorThresholds {
  return {
    overallMaxPct: pctEnv("WORKER_OVERALL_TOOL_ERROR_MAX_PCT", 5),
    singleToolMaxPct: pctEnv("WORKER_SINGLE_TOOL_ERROR_MAX_PCT", 3),
    categoryMaxPct: pctEnv("WORKER_CATEGORY_ERROR_MAX_PCT", pctEnv("WORKER_TOOL_ERROR_MAX_PCT", 5)),
    minCalls: boundedIntegerEnv("WORKER_TOOL_ERROR_MIN_CALLS", 10, 1, 1_000_000)
  };
}

function reviewIntervalMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_REVIEW_INTERVAL_MS", THREE_HOURS_MS, 60_000, 24 * 60 * 60 * 1000);
}

function reviewGraceMs(intervalMs: number): number {
  return boundedIntegerEnv("WORKER_TOOL_REVIEW_GRACE_MS", 5 * 60 * 1000, 0, intervalMs);
}

function reviewSinceMs(now: number): number | undefined {
  const sinceMinutes = boundedIntegerEnv("WORKER_TOOL_REVIEW_SINCE_MINUTES", 180, 1, 7 * 24 * 60);
  return now - sinceMinutes * 60_000;
}

function circuitEnabled(): boolean {
  return process.env.WORKER_TOOL_CIRCUIT_BREAKER !== "0" && process.env.WORKER_TOOL_CIRCUIT_DISABLED !== "1";
}

function circuitWindowMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_WINDOW_MS", 15 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000);
}

function circuitOpenMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_OPEN_MS", 5 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000);
}

function circuitMinCalls(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_MIN_CALLS", 3, 1, 1_000_000);
}

function circuitMinErrors(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_MIN_ERRORS", 2, 1, 1_000_000);
}

function errorClassCircuitMinErrors(): number {
  return boundedIntegerEnv("WORKER_TOOL_ERROR_CLASS_CIRCUIT_MIN_ERRORS", 2, 1, 1_000_000);
}

function immediateCircuitClasses(): Set<ToolErrorClass> {
  const raw = process.env.WORKER_TOOL_CIRCUIT_IMMEDIATE_CLASSES || "upstream_404,shell_mismatch";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean) as ToolErrorClass[]
  );
}

function circuitEarlyCloseMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_EARLY_CLOSE_MS", 30_000, 0, 60 * 60 * 1000);
}

function circuitStateEventMax(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_STATE_EVENT_MAX", 200, 0, 10_000);
}

function circuitStateSaveMinMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_STATE_SAVE_MIN_MS", 30_000, 0, 60 * 60 * 1000);
}

function circuitStateLockStaleMs(): number {
  return boundedIntegerEnv("WORKER_TOOL_CIRCUIT_STATE_LOCK_STALE_MS", 30_000, 1_000, 60 * 60 * 1000);
}

export function toolCircuitStateFile(): string | undefined {
  const explicit = process.env.WORKER_TOOL_CIRCUIT_STATE_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  const metricsFile = process.env.WORKER_METRICS_FILE?.trim();
  if (!metricsFile) return undefined;
  return path.resolve(`${metricsFile}.state.json`);
}

function isToolCircuit(value: unknown): value is ToolCircuit {
  const item = value as Partial<ToolCircuit>;
  return (
    Boolean(item) &&
    typeof item.key === "string" &&
    typeof item.tool === "string" &&
    typeof item.category === "string" &&
    typeof item.openedAt === "number" &&
    typeof item.expiresAt === "number" &&
    typeof item.reason === "string" &&
    typeof item.requiredAction === "string" &&
    Array.isArray(item.alternatives)
  );
}

function isToolControlEvent(value: unknown): value is ToolControlEvent {
  const item = value as Partial<ToolControlEvent>;
  return (
    Boolean(item) &&
    typeof item.ts === "number" &&
    typeof item.tool === "string" &&
    typeof item.category === "string" &&
    (item.status === "ok" || item.status === "error" || item.status === "rejected")
  );
}

function stateChecksum(payload: Omit<PersistedToolCircuitState, "checksum">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function acquireCircuitStateLock(file: string, now: number): { fd: number; file: string } | undefined {
  const lockFile = `${file}.lock`;
  let fd: number | undefined;
  try {
    try {
      const stat = fs.statSync(lockFile);
      if (now - stat.mtimeMs > circuitStateLockStaleMs()) fs.unlinkSync(lockFile);
    } catch {
      // Missing lock is the common path.
    }
    fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${new Date(now).toISOString()}\n`, "utf8");
    return { fd, file: lockFile };
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
    appendMetrics({
      event: "tool_circuit_state_save",
      route: "worker",
      status: "rejected",
      state_file: file,
      reason: "state_lock_busy"
    });
    return undefined;
  }
}

function releaseCircuitStateLock(lock: { fd: number; file: string } | undefined): void {
  if (!lock) return;
  try {
    fs.closeSync(lock.fd);
  } catch {
    // Best-effort cleanup only.
  }
  try {
    fs.unlinkSync(lock.file);
  } catch {
    // A stale lock will be cleaned up by a later writer.
  }
}

function liveToolControlEvents(now: number): ToolControlEvent[] {
  const oldest = now - circuitWindowMs();
  const maxEvents = circuitStateEventMax();
  if (maxEvents === 0) return [];
  return toolControlEvents
    .filter((event) => event.ts >= oldest)
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxEvents);
}

function ensureCircuitStateParentDir(file: string): void {
  const dir = path.dirname(file);
  if (dir === path.parse(dir).root) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persistToolCircuitState(now = Date.now(), options: { force?: boolean; reason?: string } = {}): void {
  const file = toolCircuitStateFile();
  if (!file) return;
  if (!options.force && now - lastCircuitStateSaveAt < circuitStateSaveMinMs()) return;
  try {
    ensureCircuitStateParentDir(file);
    const liveCircuits = [...openCircuits.values()].filter((circuit) => circuit.expiresAt > now);
    const payloadBody: Omit<PersistedToolCircuitState, "checksum"> = {
      version: 2,
      savedAt: new Date(now).toISOString(),
      circuits: liveCircuits,
      events: liveToolControlEvents(now)
    };
    const payload: PersistedToolCircuitState = { ...payloadBody, checksum: stateChecksum(payloadBody) };
    const snapshot = JSON.stringify(payload, null, 2);
    if (!options.force && snapshot === lastCircuitStateSnapshot) return;
    const lock = acquireCircuitStateLock(file, now);
    if (!lock) return;
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, snapshot, "utf8");
      fs.renameSync(temp, file);
    } finally {
      releaseCircuitStateLock(lock);
    }
    lastCircuitStateSaveAt = now;
    lastCircuitStateSnapshot = snapshot;
    appendMetrics({
      event: "tool_circuit_state_save",
      route: "worker",
      status: "ok",
      circuit_count: liveCircuits.length,
      event_count: payload.events?.length || 0,
      reason: options.reason,
      state_file: file
    });
  } catch (error) {
    appendMetrics({
      event: "tool_circuit_state_save",
      route: "worker",
      status: "error",
      state_file: file,
      error_message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function loadToolCircuitState(options: { force?: boolean; now?: number } = {}): number {
  if (circuitStateLoaded && !options.force) return openCircuits.size;
  circuitStateLoaded = true;
  const file = toolCircuitStateFile();
  if (!file || !fs.existsSync(file)) return openCircuits.size;
  const now = options.now ?? Date.now();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedToolCircuitState>;
    if (parsed.checksum) {
      const checksumBody = { version: parsed.version, savedAt: parsed.savedAt, circuits: parsed.circuits || [], events: parsed.events || [] };
      if (parsed.checksum !== stateChecksum(checksumBody as Omit<PersistedToolCircuitState, "checksum">)) {
        throw new Error("tool circuit state checksum mismatch");
      }
    }
    const circuits = Array.isArray(parsed.circuits) ? parsed.circuits.filter(isToolCircuit) : [];
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isToolControlEvent) : [];
    let restored = 0;
    let expired = 0;
    for (const circuit of circuits) {
      if (circuit.expiresAt <= now) {
        expired += 1;
        continue;
      }
      openCircuits.set(circuit.key, circuit);
      restored += 1;
    }
    const oldest = now - circuitWindowMs();
    const eventLimit = circuitStateEventMax();
    const restoredEvents =
      eventLimit === 0
        ? []
        : events
            .filter((event) => event.ts >= oldest)
            .sort((a, b) => a.ts - b.ts)
            .slice(-eventLimit);
    if (restoredEvents.length > 0) {
      toolControlEvents.length = 0;
      toolControlEvents.push(...restoredEvents);
    }
    if (expired > 0 || restored !== circuits.length || restoredEvents.length !== events.length) {
      persistToolCircuitState(now, { force: true, reason: "state_load_cleanup" });
    }
    appendMetrics({
      event: "tool_circuit_state_load",
      route: "worker",
      status: "ok",
      restored,
      expired,
      restored_events: restoredEvents.length,
      state_file: file
    });
    return restored;
  } catch (error) {
    openCircuits.clear();
    toolControlEvents.length = 0;
    persistToolCircuitState(now, { force: true, reason: "state_load_error" });
    appendMetrics({
      event: "tool_circuit_state_load",
      route: "worker",
      status: "error",
      state_file: file,
      error_message: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }
}

function pruneToolControl(now = Date.now()): void {
  loadToolCircuitState({ now });
  const oldest = now - circuitWindowMs();
  let eventChanged = false;
  while (toolControlEvents.length > 0 && toolControlEvents[0].ts < oldest) {
    toolControlEvents.shift();
    eventChanged = true;
  }
  const maxEvents = circuitStateEventMax();
  while (maxEvents > 0 && toolControlEvents.length > maxEvents) {
    toolControlEvents.shift();
    eventChanged = true;
  }
  let changed = false;
  for (const [key, circuit] of openCircuits.entries()) {
    if (circuit.expiresAt <= now) {
      openCircuits.delete(key);
      changed = true;
    }
  }
  if (changed || eventChanged) persistToolCircuitState(now, { reason: "prune" });
}

function compactMessage(extra: Record<string, unknown>): string {
  return [
    extra.error_class,
    extra.error_message,
    extra.failure_kind,
    extra.command_status,
    extra.required_action,
    extra.job_status
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join("\n");
}

export function detectToolErrorClass(
  tool: string,
  category: string,
  extra: Record<string, unknown> = {}
): ToolErrorClass {
  const explicit = String(extra.failure_kind || "").trim();
  if (explicit === "shell_mismatch") return "shell_mismatch";
  if (explicit === "timeout") return tool === "search" ? "search_timeout" : "timeout";
  if (explicit === "missing_command") return "missing_command";
  if (explicit === "dependency_missing") return "dependency_missing";
  if (explicit === "permission_denied") return "permission_denied";

  const message = compactMessage(extra).toLowerCase();
  if (message.includes("upstream returned 404") || /\b404\b/.test(message)) return "upstream_404";
  if (message.includes("upstream_error") || message.includes("upstream returned") || /\b5\d\d\b/.test(message)) return "upstream_error";
  if (message.includes("spawnsync rg etimedout") || (tool === "search" && message.includes("timeout"))) return "search_timeout";
  if (message.includes("timed out") || message.includes("timeout") || message.includes("etimedout")) return "timeout";
  if (message.includes("not recognized") || message.includes("command not found") || message.includes("executable file not found")) {
    return category === "command_digest" ? "shell_mismatch" : "missing_command";
  }
  if (message.includes("path does not exist") || message.includes("cannot be accessed") || message.includes("missing file")) {
    return "missing_path";
  }
  if (message.includes("permission denied") || message.includes("access is denied") || message.includes("eperm")) {
    return "permission_denied";
  }
  if (message.includes("cannot find module") || message.includes("module_not_found")) return "dependency_missing";
  return "unknown_failure";
}

function alternativesFor(tool: string, category: string, errorClass?: ToolErrorClass): string[] {
  if (tool === "review") return ["diff_digest", "read_pack", "get"];
  if (tool === "analyze") return ["read_pack", "search"];
  if (tool === "search") return ["read_pack", "shell"];
  if (tool === "shell") return errorClass === "shell_mismatch" ? ["shell", "read_pack"] : ["read_pack", "diff_digest"];
  if (category === "job_control") return ["get", "wait", "tail", "start"];
  return ["read_pack", "diff_digest", "shell"];
}

function actionFor(tool: string): ToolControlDecision["action"] {
  return tool === "review" || tool === "analyze" ? "degrade" : "reject";
}

function requiredActionFor(tool: string, errorClass?: ToolErrorClass): string {
  switch (errorClass) {
    case "upstream_404":
    case "upstream_error":
      return "Use deterministic local evidence while the LLM route is unhealthy; check gateway/model routing before retrying this tool.";
    case "shell_mismatch":
      return "Use the auto-rerouted PowerShell path or rewrite the command for the active shell before retrying.";
    case "search_timeout":
      return "Narrow search dirs/glob/max_results or use read_pack on known paths until the search circuit closes.";
    case "missing_path":
      return "Correct the path inside SANDBOX_ROOT before retrying.";
    case "missing_command":
    case "dependency_missing":
      return "Verify the executable or dependency exists before retrying this tool.";
    default:
      return `Use ${alternativesFor(tool, "unknown").join("/")} while this tool circuit is open; inspect metrics before retrying.`;
  }
}

function circuitKey(tool: string, errorClass?: ToolErrorClass): string {
  return errorClass ? `${tool}:${errorClass}` : tool;
}

function openCircuit(tool: string, category: string, reason: string, errorClass: ToolErrorClass | undefined, now: number): ToolCircuit {
  const key = circuitKey(tool, errorClass);
  const existing = openCircuits.get(key);
  if (existing && existing.expiresAt > now) return existing;
  const circuit: ToolCircuit = {
    key,
    tool,
    category,
    errorClass,
    openedAt: now,
    expiresAt: now + circuitOpenMs(),
    reason,
    requiredAction: requiredActionFor(tool, errorClass),
    alternatives: alternativesFor(tool, category, errorClass)
  };
  openCircuits.set(key, circuit);
  persistToolCircuitState(now, { force: true, reason: "circuit_open" });
  appendMetrics({
    event: "tool_circuit_open",
    route: "worker",
    tool,
    category,
    error_class: errorClass,
    reason,
    expires_at: new Date(circuit.expiresAt).toISOString()
  });
  return circuit;
}

function maybeOpenCircuit(tool: string, category: string, errorClass: ToolErrorClass | undefined, now: number): ToolCircuit | undefined {
  if (!circuitEnabled() || !errorClass) return undefined;
  const recent = toolControlEvents.filter((event) => event.tool === tool);
  const errors = recent.filter((event) => event.status === "error");
  const classErrors = errors.filter((event) => event.errorClass === errorClass);
  const errorRate = recent.length > 0 ? (errors.length / recent.length) * 100 : 0;
  const threshold = readToolErrorThresholds().singleToolMaxPct;

  if (immediateCircuitClasses().has(errorClass) && classErrors.length >= errorClassCircuitMinErrors()) {
    return openCircuit(tool, category, `${tool}/${errorClass} hit immediate circuit policy`, errorClass, now);
  }
  if (classErrors.length >= errorClassCircuitMinErrors() && classErrors.length >= circuitMinErrors()) {
    return openCircuit(tool, category, `${tool}/${errorClass} repeated ${classErrors.length} errors`, errorClass, now);
  }
  if (recent.length >= circuitMinCalls() && errors.length >= circuitMinErrors() && errorRate >= threshold) {
    return openCircuit(tool, category, `${tool} error rate ${errorRate.toFixed(1)}% >= ${threshold}%`, undefined, now);
  }
  return undefined;
}

function maybeCloseCircuit(tool: string, now: number): boolean {
  if (!circuitEnabled()) return false;
  const earlyCloseMs = circuitEarlyCloseMs();
  let closed = false;
  for (const [key, circuit] of openCircuits.entries()) {
    if (circuit.tool !== tool) continue;
    if (now - circuit.openedAt < earlyCloseMs) continue;
    openCircuits.delete(key);
    closed = true;
    appendMetrics({
      event: "tool_circuit_close",
      route: "worker",
      tool,
      circuit_key: key,
      reason: "successful_call_after_early_close_window",
      opened_at: new Date(circuit.openedAt).toISOString(),
      closed_at: new Date(now).toISOString()
    });
  }
  if (closed) persistToolCircuitState(now, { force: true, reason: "circuit_early_close" });
  return closed;
}

export function recordToolControlOutcome(
  tool: string,
  category: WorkerCategory | string,
  status: MetricStatus,
  extra: Record<string, unknown> = {},
  now = Date.now()
): { errorClass?: ToolErrorClass; circuitOpened?: boolean; circuitClosed?: boolean } {
  pruneToolControl(now);
  if (!circuitEnabled()) return {};
  if (status === "rejected") return {};
  const errorClass = status === "error" ? detectToolErrorClass(tool, String(category), extra) : undefined;
  toolControlEvents.push({ ts: now, tool, category: String(category), status, errorClass });
  const circuit = status === "error" ? maybeOpenCircuit(tool, String(category), errorClass, now) : undefined;
  const circuitClosed = status === "ok" ? maybeCloseCircuit(tool, now) : false;
  persistToolCircuitState(now, { force: status === "error" || circuitClosed, reason: status === "error" ? "tool_error" : circuitClosed ? "circuit_early_close" : "tool_outcome" });
  return { errorClass, circuitOpened: Boolean(circuit), circuitClosed };
}

export function getToolControlDecision(
  tool: string,
  category: WorkerCategory | string,
  now = Date.now()
): ToolControlDecision | undefined {
  pruneToolControl(now);
  if (!circuitEnabled()) return undefined;
  const circuit =
    openCircuits.get(tool) ||
    [...openCircuits.values()]
      .filter((item) => item.tool === tool)
      .sort((a, b) => a.expiresAt - b.expiresAt)[0];
  if (!circuit || circuit.expiresAt <= now) return undefined;
  return {
    action: actionFor(tool),
    reason: circuit.reason,
    requiredAction: circuit.requiredAction,
    alternatives: circuit.alternatives,
    tool,
    category: String(category),
    errorClass: circuit.errorClass,
    circuitKey: circuit.key,
    expiresAt: new Date(circuit.expiresAt).toISOString()
  };
}

export function recordToolControlIntercept(decision: ToolControlDecision): void {
  appendMetrics({
    event: "tool_circuit_intercept",
    route: "worker",
    tool: decision.tool,
    category: decision.category,
    action: decision.action,
    error_class: decision.errorClass,
    circuit_key: decision.circuitKey,
    reason: decision.reason,
    expires_at: decision.expiresAt
  });
}

function metricFiles(baseFile: string): string[] {
  const dir = baseFile.includes("/") || baseFile.includes("\\") ? path.dirname(baseFile) : ".";
  const base = path.basename(baseFile);
  const files = [baseFile];
  if (!fs.existsSync(dir)) return files;
  for (const candidate of fs.readdirSync(dir)) {
    const full = path.join(dir, candidate);
    if (candidate.startsWith(`${base}.`) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      files.push(full);
    }
  }
  return files;
}

function rate(errors: number, calls: number): number {
  return calls > 0 ? (errors / calls) * 100 : 0;
}

function groupKey(category: string, tool?: string): string {
  return tool === undefined ? category : `${category}\t${tool}`;
}

function addGroup(groups: Map<string, { category: string; tool?: string; calls: number; errors: number }>, category: string, tool: string | undefined, status: MetricStatus) {
  const key = groupKey(category, tool);
  const group = groups.get(key) || { category, tool, calls: 0, errors: 0 };
  group.calls += 1;
  if (status === "error") group.errors += 1;
  groups.set(key, group);
}

export function reviewToolErrorRates(options: { metricsFile?: string; now?: Date; sinceMs?: number } = {}): ToolErrorReview {
  const metricsFile = options.metricsFile || process.env.WORKER_METRICS_FILE;
  const thresholds = readToolErrorThresholds();
  const nowMs = (options.now || new Date()).getTime();
  const sinceMs = options.sinceMs ?? reviewSinceMs(nowMs);
  const sinceIso = sinceMs === undefined ? undefined : new Date(sinceMs).toISOString();

  if (!metricsFile) {
    return {
      status: "skipped",
      reason: "WORKER_METRICS_FILE is not set",
      sinceIso,
      totalCalls: 0,
      totalErrors: 0,
      overallErrorRate: 0,
      thresholds,
      breaches: []
    };
  }
  if (!fs.existsSync(metricsFile)) {
    return {
      status: "skipped",
      reason: `metrics file not found: ${metricsFile}`,
      metricsFile,
      sinceIso,
      totalCalls: 0,
      totalErrors: 0,
      overallErrorRate: 0,
      thresholds,
      breaches: []
    };
  }

  const categoryGroups = new Map<string, { category: string; calls: number; errors: number }>();
  const toolGroups = new Map<string, { category: string; tool?: string; calls: number; errors: number }>();
  let totalCalls = 0;
  let totalErrors = 0;

  for (const file of metricFiles(metricsFile)) {
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(rawLine.replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
      if (row.event !== "tool_call") continue;
      if (sinceMs !== undefined) {
        const ts = Date.parse(String(row.ts || ""));
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
      }

      const category = String(row.category || "unknown");
      const tool = String(row.tool || "unknown");
      const status: MetricStatus = row.status === "error" || row.status === "rejected" ? row.status : "ok";
      totalCalls += 1;
      if (status === "error") totalErrors += 1;

      const categoryGroup = categoryGroups.get(category) || { category, calls: 0, errors: 0 };
      categoryGroup.calls += 1;
      if (status === "error") categoryGroup.errors += 1;
      categoryGroups.set(category, categoryGroup);
      addGroup(toolGroups, category, tool, status);
    }
  }

  if (totalCalls === 0) {
    return {
      status: "skipped",
      reason: "no worker tool_call audit rows found in the review window",
      metricsFile,
      sinceIso,
      totalCalls,
      totalErrors,
      overallErrorRate: 0,
      thresholds,
      breaches: []
    };
  }

  const breaches: ToolErrorGateBreach[] = [];
  const overallErrorRate = rate(totalErrors, totalCalls);
  if (totalCalls >= thresholds.minCalls && overallErrorRate >= thresholds.overallMaxPct) {
    breaches.push({
      scope: "overall",
      calls: totalCalls,
      errors: totalErrors,
      errorRate: overallErrorRate,
      maxPct: thresholds.overallMaxPct
    });
  }

  for (const group of categoryGroups.values()) {
    const errorRate = rate(group.errors, group.calls);
    if (group.calls >= thresholds.minCalls && errorRate >= thresholds.categoryMaxPct) {
      breaches.push({
        scope: "category",
        category: group.category,
        calls: group.calls,
        errors: group.errors,
        errorRate,
        maxPct: thresholds.categoryMaxPct
      });
    }
  }

  for (const group of toolGroups.values()) {
    const errorRate = rate(group.errors, group.calls);
    if (group.calls >= thresholds.minCalls && errorRate >= thresholds.singleToolMaxPct) {
      breaches.push({
        scope: "tool",
        category: group.category,
        tool: group.tool,
        calls: group.calls,
        errors: group.errors,
        errorRate,
        maxPct: thresholds.singleToolMaxPct
      });
    }
  }

  return {
    status: breaches.length > 0 ? "breach" : "ok",
    metricsFile,
    sinceIso,
    totalCalls,
    totalErrors,
    overallErrorRate,
    thresholds,
    breaches
  };
}

function breachSummary(breach: ToolErrorGateBreach): string {
  const label =
    breach.scope === "overall"
      ? "overall"
      : breach.scope === "category"
        ? `category ${breach.category}`
        : `tool ${breach.category}/${breach.tool}`;
  return `${label} error rate ${breach.errorRate.toFixed(1)}% >= ${breach.maxPct}% (${breach.errors}/${breach.calls})`;
}

export function triggerToolErrorSelfHeal(reason: ToolErrorEscalation["reason"], details: string[], now = new Date()): ToolErrorEscalation {
  activeEscalation = {
    active: true,
    triggeredAt: now.toISOString(),
    reason,
    details,
    startDefaults: {
      reliability_tier: "strict",
      blocking_policy: "warn",
      semantic_gate: "warn",
      auto_revise: true,
      max_revise_passes: Math.max(1, MAX_REVISE_PASSES)
    }
  };
  console.error(`[warn][tool-error-control] escalation self-heal enabled: ${details.join("; ")}`);
  return activeEscalation;
}

export function getToolErrorEscalation(): ToolErrorEscalation | undefined {
  return activeEscalation;
}

export function clearToolErrorEscalation(): void {
  activeEscalation = undefined;
}

export function resetToolControlState(options: { persist?: boolean } = {}): void {
  clearToolErrorEscalation();
  toolControlEvents.length = 0;
  openCircuits.clear();
  circuitStateLoaded = false;
  lastCircuitStateSaveAt = 0;
  lastCircuitStateSnapshot = undefined;
  if (options.persist !== false) persistToolCircuitState(Date.now(), { force: true, reason: "reset" });
}

export function getToolErrorControlStartDefaults(): Partial<StartJobInput> {
  return activeEscalation?.startDefaults || {};
}

export function runToolErrorReview(options: { metricsFile?: string; now?: Date; expectedAtMs?: number } = {}): ToolErrorReview {
  const now = options.now || new Date();
  const expectedAtMs = options.expectedAtMs;
  const intervalMs = reviewIntervalMs();
  if (expectedAtMs !== undefined) {
    const overdueMs = now.getTime() - expectedAtMs;
    if (overdueMs > reviewGraceMs(intervalMs)) {
      triggerToolErrorSelfHeal("review_overdue", [`tool error review overdue by ${overdueMs}ms`], now);
    }
  }

  const review = reviewToolErrorRates({ metricsFile: options.metricsFile, now });
  if (review.status === "breach") {
    triggerToolErrorSelfHeal("error_rate_breach", review.breaches.map(breachSummary), now);
    for (const breach of review.breaches) {
      if (breach.scope === "tool" && breach.tool && breach.category) {
        openCircuit(breach.tool, breach.category, breachSummary(breach), undefined, now.getTime());
      }
    }
  }

  appendMetrics({
    event: "tool_error_review",
    route: "worker",
    status: review.status,
    metrics_file: review.metricsFile,
    since: review.sinceIso,
    total_calls: review.totalCalls,
    total_errors: review.totalErrors,
    overall_error_rate: Number(review.overallErrorRate.toFixed(2)),
    breach_count: review.breaches.length,
    reason: review.reason,
    escalation_active: Boolean(activeEscalation)
  });

  if (review.status === "skipped") {
    console.error(`[warn][tool-error-control] review skipped: ${review.reason}`);
  }
  return review;
}

export function startToolErrorReviewLoop(): NodeJS.Timeout | undefined {
  if (reviewTimer || process.env.WORKER_TOOL_REVIEW_DISABLED === "1") return reviewTimer;
  loadToolCircuitState();
  const intervalMs = reviewIntervalMs();
  nextReviewDueAt = Date.now() + intervalMs;
  reviewTimer = setInterval(() => {
    const now = new Date();
    runToolErrorReview({ now, expectedAtMs: nextReviewDueAt });
    nextReviewDueAt = now.getTime() + intervalMs;
  }, intervalMs);
  reviewTimer.unref?.();
  return reviewTimer;
}

export function stopToolErrorReviewLoop(): void {
  if (!reviewTimer) return;
  clearInterval(reviewTimer);
  reviewTimer = undefined;
  nextReviewDueAt = 0;
}
