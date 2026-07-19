#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateGuardHealth } from "../dist/guard_health.js";
import { routingCoverage } from "../dist/routing_observation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const dryRun = args.has("--dry-run");
const minCalls = 10;

function runStrictCheck(script, scriptArgs) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...scriptArgs], {
    cwd: root, encoding: "utf8", windowsHide: true, env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return typeof result.status === "number" ? result.status : 2;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* malformed telemetry is counted by the caller through completeness */ }
  }
  return rows;
}

function timestamp(row) {
  const value = Date.parse(String(row.ts || row.timestamp || ""));
  return Number.isFinite(value) ? value : 0;
}

function breach(key, scope, calls, errors, threshold) {
  const rate = calls > 0 ? errors / calls * 100 : 0;
  return calls >= minCalls && rate > threshold
    ? { key, scope, calls, errors, rate_pct: Number(rate.toFixed(2)), threshold_pct: threshold }
    : undefined;
}

function windowSnapshot(rows, minutes, now = Date.now()) {
  const since = now - minutes * 60_000;
  const calls = rows.filter((row) => row.event === "tool_call" && row.status !== "rejected" && timestamp(row) >= since);
  const errors = calls.filter((row) => row.status === "error");
  const breaches = [];
  const overall = breach("overall", "overall", calls.length, errors.length, 5);
  if (overall) breaches.push(overall);
  for (const [field, scope, threshold] of [["category", "category", 5], ["tool", "tool", 3]]) {
    const values = new Set(calls.map((row) => row[field]).filter((value) => typeof value === "string"));
    for (const value of values) {
      const scoped = calls.filter((row) => row[field] === value);
      const item = breach(`${scope}:${value}`, scope, scoped.length, scoped.filter((row) => row.status === "error").length, threshold);
      if (item) breaches.push(item);
    }
  }
  const oldest = rows.reduce((value, row) => Math.min(value, timestamp(row) || value), now);
  return { minutes, calls: calls.length, errors: errors.length, breaches, complete: rows.length === 0 || oldest <= since };
}

function loadStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function saveStatus(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("canary timeout")), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function canaryOnce() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    cwd: root,
    env: { ...process.env, WORKER_IDLE_EXIT_MS: "0", WORKER_TOOL_REVIEW_DISABLED: "1" },
    stderr: "pipe"
  });
  const client = new Client({ name: "codex-guard", version: "1" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), 10_000);
    const listed = await withTimeout(client.listTools(), 10_000);
    if (!Array.isArray(listed.tools) || listed.tools.length === 0) throw new Error("tools/list returned no tools");
    return { ok: true, tool_count: listed.tools.length };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 240) };
  } finally {
    try { await client.close(); } catch { /* already closed */ }
  }
}

async function canary() {
  const first = await canaryOnce();
  if (first.ok) return { ...first, attempts: 1 };
  const second = await canaryOnce();
  return { ...second, attempts: 2, first_error: first.error };
}

function eventLog(level, message) {
  if (process.platform !== "win32" || dryRun) return true;
  const type = level === "Error" ? "ERROR" : level === "Warning" ? "WARNING" : "INFORMATION";
  const result = spawnSync("eventcreate.exe", ["/L", "APPLICATION", "/SO", "IDE Super Worker", "/T", type, "/ID", "1001", "/D", message.slice(0, 1000)], {
    windowsHide: true, stdio: "ignore"
  });
  return result.status === 0;
}

async function runWatch() {
  const metricsFile = path.resolve(process.env.WORKER_METRICS_FILE || path.join(root, "worker-metrics.jsonl"));
  const routingFile = path.resolve(process.env.WORKER_ROUTING_EVENTS_FILE || path.join(root, "routing-observations.jsonl"));
  const statusFile = path.resolve(process.env.WORKER_GUARD_STATUS_FILE || path.join(path.dirname(metricsFile), "codex-guard-status.json"));
  const metrics = readJsonl(metricsFile);
  const routing = readJsonl(routingFile).filter((row) => row?.event === "routing_observation");
  const coverage = routingCoverage(routing);
  const workerSelectedOperations = new Set(routing.filter((row) => row.selected_route === "worker").map((row) => row.operation_id));
  const postIds = new Set(routing.filter((row) => row.phase === "post").map((row) => row.operation_id));
  const fiveMinutesAgo = Date.now() - 5 * 60_000;
  const missingPost = routing.filter((row) => row.phase === "pre" && row.selected_route === "worker" && timestamp(row) < fiveMinutesAgo && !postIds.has(row.operation_id)).length;
  const workerMetrics = metrics.filter((row) => row.event === "tool_call" && row.route === "worker" && timestamp(row) >= Date.now() - 24 * 60 * 60_000);
  const latestWorkerSelection = routing
    .filter((row) => row.selected_route === "worker")
    .reduce((latest, row) => Math.max(latest, timestamp(row)), 0);
  const latestWorkerMetric = workerMetrics.reduce((latest, row) => Math.max(latest, timestamp(row)), 0);
  const workerMetricAdvanced = latestWorkerSelection === 0 || latestWorkerMetric >= latestWorkerSelection - 5 * 60_000;
  const probe = await canary();
  const previous = loadStatus(statusFile);
  const input = {
    windows: {
      one_hour: windowSnapshot(metrics, 60),
      one_day: windowSnapshot(metrics, 1440),
      seven_days: windowSnapshot(metrics, 10080)
    },
    eligible_total: coverage.eligible_total,
    worker_selected: workerSelectedOperations.size,
    worker_metric_count: workerMetricAdvanced ? workerMetrics.length : 0,
    missing_post_count: missingPost,
    canary_ok: probe.ok,
    canary_error: probe.error
  };
  const evaluation = evaluateGuardHealth(input, previous);
  const fingerprint = `${evaluation.state}:${evaluation.consecutive_key || evaluation.reason}`;
  const shouldNotify = evaluation.alert && previous?.last_alert_fingerprint !== fingerprint;
  const now = new Date().toISOString();
  const status = {
    schema_version: 1,
    ...evaluation,
    evaluated_at: now,
    windows: input.windows,
    coverage,
    canary: probe,
    last_opportunity_at: routing.reduce((latest, row) => Math.max(latest, timestamp(row)), 0) || null,
    last_worker_metric_at: latestWorkerMetric || null,
    last_alert_fingerprint: shouldNotify ? fingerprint : previous?.last_alert_fingerprint,
    last_alert_at: shouldNotify ? now : previous?.last_alert_at,
    last_recovery_at: evaluation.state === "HEALTHY" && evaluation.alert_level === "Information" ? now : previous?.last_recovery_at
  };
  saveStatus(statusFile, status);
  if (shouldNotify && !eventLog(evaluation.alert_level || "Warning", `Codex worker ${evaluation.state}: ${evaluation.reason}`)) {
    status.event_log_error = true;
    saveStatus(statusFile, status);
    process.stderr.write("[guard] Windows Event Log write failed; status file contains the authoritative transition.\n");
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = evaluation.state === "DEGRADED" ? 1 : ["UNAVAILABLE", "TELEMETRY_FAULT"].includes(evaluation.state) ? 2 : 0;
}

try {
  if (watch) {
    await runWatch();
  } else {
    const auditCode = runStrictCheck("scripts/codex_audit.mjs", ["--since-minutes=60"]);
    const statsCode = runStrictCheck("scripts/stats.mjs", ["--gate", "--since-minutes=60"]);
    process.exitCode = auditCode === 0 && statsCode === 0 ? 0 : Math.max(auditCode, statsCode, 1);
  }
} catch (error) {
  process.stderr.write(`[guard] internal failure: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
