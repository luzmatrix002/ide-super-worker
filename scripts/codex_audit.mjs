import * as fs from "node:fs";
import * as path from "node:path";

function loadDotEnv(file = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function numberArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).filter((item) => item.startsWith(prefix)).slice(-1)[0];
  const value = Number(arg ? arg.slice(prefix.length) : process.env[`CODEX_AUDIT_${name.toUpperCase().replace(/-/g, "_")}`]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).filter((item) => item.startsWith(prefix)).slice(-1)[0];
  const raw = arg ? arg.slice(prefix.length) : process.env[`CODEX_AUDIT_${name.toUpperCase().replace(/-/g, "_")}`];
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRows(file, sinceMs) {
  const dir = file.includes("/") || file.includes("\\") ? file.replace(/[\\/][^\\/]+$/, "") || "." : ".";
  const base = file.replace(/^.*[\\/]/, "");
  const files = [file];
  for (const candidate of fs.readdirSync(dir)) {
    const full = path.join(dir, candidate);
    if (candidate.startsWith(`${base}.`) && fs.statSync(full).isFile()) files.push(full);
  }

  const rows = [];
  for (const metricFile of files) {
    for (const rawLine of fs.readFileSync(metricFile, "utf8").split(/\r?\n/)) {
      const line = rawLine.replace(/^\uFEFF/, "");
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const ts = Date.parse(String(row.ts || ""));
        if (Number.isFinite(ts) && ts >= sinceMs) rows.push(row);
      } catch {
        // Ignore corrupt metric rows; stats.mjs does the same.
      }
    }
  }
  return rows;
}

function pct(numerator, denominator) {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "n/a";
}

loadDotEnv();

const sinceMinutes = numberArg("since-minutes", 60);
const requiredCategories = listArg("required-categories", [
  "search",
  "context_pack",
  "command_digest",
  "diff_digest",
  "analysis",
  "review"
]);
const metricsFile = process.argv.slice(2).find((item) => !item.startsWith("--")) || process.env.WORKER_METRICS_FILE;
const failures = [];
const warnings = [];

if (!metricsFile) {
  failures.push("WORKER_METRICS_FILE is not set");
} else if (!fs.existsSync(metricsFile)) {
  failures.push(`metrics file not found: ${metricsFile}`);
}

const agentsPath = path.resolve(process.cwd(), "AGENTS.md");
if (!fs.existsSync(agentsPath)) {
  warnings.push("AGENTS.md is missing; worker routing rules are not persisted in this repository");
} else {
  const agents = fs.readFileSync(agentsPath, "utf8");
  if (!agents.includes("mcp__codex_async_worker")) {
    warnings.push("AGENTS.md does not mention mcp__codex_async_worker routing");
  }
}

let rows = [];
if (failures.length === 0) {
  rows = readRows(metricsFile, Date.now() - sinceMinutes * 60_000);
}

const toolRows = rows.filter((row) => row.event === "tool_call");
const upstreamRows = rows.filter((row) => row.event !== "tool_call");
const workerToolRows = toolRows.filter((row) => row.route === "worker");
const mainToolRows = toolRows.filter((row) => row.route === "main");
const fallbackRows = upstreamRows.filter((row) => row.route === "fallback");
const startRows = workerToolRows.filter((row) => row.tool === "start");
const promptTokens = upstreamRows.reduce((sum, row) => sum + (Number(row.prompt_tokens) || 0), 0);
const completionTokens = upstreamRows.reduce((sum, row) => sum + (Number(row.completion_tokens) || 0), 0);
const receiptArtifactMinBytes = numberArg("receipt-artifact-min-bytes", 32_000);
const artifactRequiredCategories = new Set(["context_pack", "diff_digest", "command_digest"]);

const categories = new Map();
const toolErrorSamples = [];
const receiptTotals = {
  rows: 0,
  outputBytes: 0,
  summaryBytes: 0,
  artifactRows: 0,
  abnormal: { accept: 0, repair: 0, escalate: 0, reject: 0 }
};
for (const row of toolRows) {
  const category = String(row.category || "unknown");
  const receipt = row.receipt && typeof row.receipt === "object" ? row.receipt : undefined;
  if (receipt) {
    const receiptCategory = String(receipt.category || category);
    const outputBytes = Number(receipt.output_bytes) || 0;
    const artifactRefs = Array.isArray(receipt.artifact_refs) ? receipt.artifact_refs : [];
    receiptTotals.rows += 1;
    receiptTotals.outputBytes += outputBytes;
    receiptTotals.summaryBytes += Number(receipt.summary_bytes) || 0;
    if (artifactRefs.length > 0) receiptTotals.artifactRows += 1;
    const abnormalVerdict = String(receipt.abnormal?.verdict || "");
    if (abnormalVerdict in receiptTotals.abnormal) receiptTotals.abnormal[abnormalVerdict] += 1;
    if (row.route === "worker" && artifactRequiredCategories.has(receiptCategory) && outputBytes > receiptArtifactMinBytes && artifactRefs.length === 0) {
      failures.push(`${receiptCategory}/${row.tool || receipt.tool || "unknown"} receipt output ${outputBytes} bytes exceeds ${receiptArtifactMinBytes} without artifact_ref`);
    }
  }
  const current = categories.get(category) || { worker: 0, main: 0, other: 0, error: 0, rejected: 0 };
  if (row.route === "worker") current.worker += 1;
  else if (row.route === "main") current.main += 1;
  else current.other += 1;
  if (row.status === "error") current.error += 1;
  if (row.status === "rejected") current.rejected += 1;
  if (row.status === "error" && toolErrorSamples.length < 12) {
    toolErrorSamples.push({
      ts: row.ts,
      category,
      tool: row.tool || "unknown",
      error_class: row.error_class || "",
      error_message: row.error_message || ""
    });
  }
  categories.set(category, current);
}

if (rows.length === 0 && failures.length === 0) {
  warnings.push(`no metrics rows in the last ${sinceMinutes} minutes`);
}
if (rows.length > 0 && workerToolRows.length === 0) {
  failures.push("recent metrics exist but no worker tool_call rows were recorded");
}
if (mainToolRows.length > 0) {
  failures.push(`${mainToolRows.length} main-route tool_call row(s) were recorded`);
}
if (fallbackRows.length > 0 && fallbackRows.length / Math.max(1, upstreamRows.length) > 0.1) {
  failures.push(`fallback ratio ${pct(fallbackRows.length, upstreamRows.length)} exceeds 10%`);
}
if (startRows.length > 0 && startRows.length / Math.max(1, workerToolRows.length) > 0.3) {
  warnings.push(`start worker call ratio ${pct(startRows.length, workerToolRows.length)} exceeds 30%; use finer worker tools for non-implementation work`);
}
for (const category of requiredCategories) {
  if (!categories.has(category)) warnings.push(`no recent worker audit evidence for category: ${category}`);
}

console.log(`IDE Super Worker audit window: ${sinceMinutes} minutes`);
console.log(`metrics_file: ${metricsFile || "(missing)"}`);
console.log(`rows: ${rows.length}`);
console.log(`upstream_calls: ${upstreamRows.length}`);
console.log(`prompt_tokens: ${promptTokens}`);
console.log(`completion_tokens: ${completionTokens}`);
console.log(`worker_tool_calls: ${workerToolRows.length}`);
console.log(`main_tool_calls: ${mainToolRows.length}`);
console.log(`fallback_ratio: ${pct(fallbackRows.length, upstreamRows.length)}`);
console.log(`start_worker_call_ratio: ${pct(startRows.length, workerToolRows.length)}`);
console.log(`receipt_rows: ${receiptTotals.rows}`);
console.log(`receipt_output_bytes: ${receiptTotals.outputBytes}`);
console.log(`receipt_summary_bytes: ${receiptTotals.summaryBytes}`);
console.log(`receipt_artifact_usage: ${pct(receiptTotals.artifactRows, receiptTotals.rows)}`);
console.log(`abnormal_accept_rows: ${receiptTotals.abnormal.accept}`);
console.log(`abnormal_repair_rows: ${receiptTotals.abnormal.repair}`);
console.log(`abnormal_escalate_rows: ${receiptTotals.abnormal.escalate}`);
console.log(`abnormal_reject_rows: ${receiptTotals.abnormal.reject}`);

if (categories.size > 0) {
  console.log("");
  console.log("category\tworker\tmain\tother\terror\trejected");
  for (const [category, counts] of [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log([category, counts.worker, counts.main, counts.other, counts.error, counts.rejected].join("\t"));
  }
}

if (toolErrorSamples.length > 0) {
  console.log("");
  console.log("tool_error_samples:");
  for (const sample of toolErrorSamples) {
    console.log(`- ${sample.ts || ""} ${sample.category}/${sample.tool} ${sample.error_class}: ${sample.error_message}`);
  }
}

console.log("");
console.log("blind_spot: worker metrics do not record direct main-thread shell output, full-file reads, chat context, or pasted prompts.");

for (const warning of warnings) console.error(`[warn] ${warning}`);
for (const failure of failures) console.error(`[fail] ${failure}`);

if (failures.length > 0) process.exit(2);
