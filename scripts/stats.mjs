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

loadDotEnv();

const cliArgs = process.argv.slice(2);
const gateEnabled = cliArgs.includes("--gate") || process.env.WORKER_RATIO_GATE === "1";
const inferLegacyAudit = cliArgs.includes("--infer-legacy") || process.env.WORKER_STATS_INFER_LEGACY === "1";
const sinceArg = cliArgs.filter((arg) => arg.startsWith("--since-minutes=")).slice(-1)[0];
const sinceMinutes = sinceArg
  ? Number(sinceArg.split("=", 2)[1])
  : Number(process.env.WORKER_STATS_SINCE_MINUTES || "");
const sinceMs = Number.isFinite(sinceMinutes) && sinceMinutes > 0 ? Date.now() - sinceMinutes * 60_000 : undefined;
const fileArg = cliArgs.find((arg) => !arg.startsWith("--"));
const file = fileArg || process.env.WORKER_METRICS_FILE;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

const numberEnv = (name) => {
  const value = Number(process.env[name]);
  return process.env[name] === undefined || process.env[name] === "" || !Number.isFinite(value) ? undefined : value;
};
const defaultInputPrice = numberEnv("WORKER_PRICE_INPUT");
const defaultOutputPrice = numberEnv("WORKER_PRICE_OUTPUT");
const defaultCachePrice = numberEnv("WORKER_PRICE_CACHE") ?? (defaultInputPrice === undefined ? undefined : defaultInputPrice * 0.1);
let priceTable = {};
try {
  priceTable = process.env.WORKER_PRICE_TABLE ? JSON.parse(process.env.WORKER_PRICE_TABLE) : {};
} catch {
  console.error("[warn] WORKER_PRICE_TABLE is not valid JSON; model overrides ignored");
}
const warnedModels = new Set();

function priceForModel(model) {
  const override = priceTable[model] && typeof priceTable[model] === "object" ? priceTable[model] : {};
  const input = override.input === undefined ? defaultInputPrice : Number(override.input);
  const output = override.output === undefined ? defaultOutputPrice : Number(override.output);
  const cache = override.cache === undefined ? defaultCachePrice ?? (Number.isFinite(input) ? input * 0.1 : undefined) : Number(override.cache);
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    if (!warnedModels.has(model)) {
      console.error(`[warn] no price for ${model}, cost_usd omitted`);
      warnedModels.add(model);
    }
    return undefined;
  }
  return { input, output, cache: Number.isFinite(cache) ? cache : input * 0.1 };
}

function costForGroup(group) {
  const price = priceForModel(group.model);
  if (!price) return undefined;
  const cachedInput = group.cacheHit;
  const regularInput = group.cacheMiss > 0 ? group.cacheMiss : Math.max(group.prompt - cachedInput, 0);
  return (regularInput * price.input + cachedInput * price.cache + group.completion * price.output) / TOKENS_PER_PRICE_UNIT;
}

function formatUsd(value) {
  return value === undefined ? "n/a" : value.toFixed(6);
}

function formatPct(value) {
  return value === undefined ? "n/a" : `${value.toFixed(1)}%`;
}

if (!file) {
  console.error("Usage: npm run stats -- <metrics.jsonl> or set WORKER_METRICS_FILE");
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`Metrics file not found: ${file}`);
  process.exit(1);
}

const dir = file.includes("/") || file.includes("\\") ? file.replace(/[\\/][^\\/]+$/, "") || "." : ".";
const base = file.replace(/^.*[\\/]/, "");
const metricFiles = [file];
for (const candidate of fs.readdirSync(dir)) {
  const full = `${dir}/${candidate}`;
  if (candidate.startsWith(`${base}.`) && fs.statSync(full).isFile()) {
    metricFiles.push(full);
  }
}

const groups = new Map();
const toolGroups = new Map();
const toolTotals = { worker: 0, main: 0, other: 0 };
const toolErrorSamples = [];
const receiptTotals = {
  rows: 0,
  inputBytes: 0,
  outputBytes: 0,
  summaryBytes: 0,
  artifactRows: 0,
  abnormal: { accept: 0, repair: 0, escalate: 0, reject: 0 },
  largeWithoutArtifact: []
};
const receiptArtifactMinBytes = Number.isFinite(Number(process.env.WORKER_RECEIPT_ARTIFACT_MIN_BYTES))
  ? Number(process.env.WORKER_RECEIPT_ARTIFACT_MIN_BYTES)
  : 32_000;
const LARGE_WITHOUT_ARTIFACT_SAMPLE_MAX = 50;
const artifactRequiredCategories = new Set(["context_pack", "diff_digest", "command_digest"]);
let rows = 0;

function recordToolAudit({ category, tool, route = "worker", status = "ok", redTeam = false }) {
  const safeRoute = route === "worker" || route === "main" ? route : "other";
  const key = [category || "unknown", tool || "unknown"].join("\t");
  const group =
    toolGroups.get(key) ||
    {
      category: category || "unknown",
      tool: tool || "unknown",
      worker: 0,
      main: 0,
      other: 0,
      ok: 0,
      error: 0,
      rejected: 0,
      redTeam: 0
    };
  group[safeRoute] += 1;
  if (status === "error") group.error += 1;
  else if (status === "rejected") group.rejected += 1;
  else group.ok += 1;
  if (redTeam) group.redTeam += 1;
  toolTotals[safeRoute] += 1;
  toolGroups.set(key, group);
}

function legacyAudit(row) {
  const tool = String(row.tool || "");
  const route = String(row.route || "");
  if (route === "shell" && tool === "shell") {
    return {
      category: "command_digest",
      tool: "shell"
    };
  }
  if (tool === "failure_digest") return { category: "command_digest", tool };
  if (tool === "review") return { category: "review", tool };
  if (["analyze", "extract", "summarize", "classify", "translate", "rewrite"].includes(tool)) {
    return { category: "analysis", tool };
  }
  if (tool === "adapter" && route !== "cache") return { category: "implementation", tool: "start" };
  return undefined;
}

function receiptFrom(row) {
  return row.receipt && typeof row.receipt === "object" ? row.receipt : undefined;
}

function artifactRefs(receipt) {
  return Array.isArray(receipt?.artifact_refs) ? receipt.artifact_refs : [];
}

for (const metricFile of metricFiles) {
  for (const rawLine of fs.readFileSync(metricFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs !== undefined) {
      const ts = Date.parse(String(row.ts || ""));
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
    }
    rows += 1;
    if (row.event === "tool_call") {
      const receipt = receiptFrom(row);
      if (receipt) {
        const category = String(receipt.category || row.category || "unknown");
        const outputBytes = Number(receipt.output_bytes) || 0;
        const refs = artifactRefs(receipt);
        receiptTotals.rows += 1;
        receiptTotals.inputBytes += Number(receipt.input_bytes) || 0;
        receiptTotals.outputBytes += outputBytes;
        receiptTotals.summaryBytes += Number(receipt.summary_bytes) || 0;
        if (refs.length > 0) receiptTotals.artifactRows += 1;
        const abnormalVerdict = String(receipt.abnormal?.verdict || "");
        if (abnormalVerdict in receiptTotals.abnormal) receiptTotals.abnormal[abnormalVerdict] += 1;
        if (
          artifactRequiredCategories.has(category) &&
          outputBytes > receiptArtifactMinBytes &&
          refs.length === 0 &&
          receiptTotals.largeWithoutArtifact.length < LARGE_WITHOUT_ARTIFACT_SAMPLE_MAX
        ) {
          receiptTotals.largeWithoutArtifact.push({
            category,
            tool: row.tool || receipt.tool || "unknown",
            outputBytes
          });
        }
      }
      if (row.status === "error" && toolErrorSamples.length < 12) {
        toolErrorSamples.push({
          ts: row.ts,
          category: row.category || "unknown",
          tool: row.tool || "unknown",
          error_class: row.error_class || "",
          error_message: row.error_message || ""
        });
      }
      recordToolAudit({
        category: row.category || "unknown",
        tool: row.tool || "unknown",
        route: row.route === "worker" || row.route === "main" ? row.route : "other",
        status: row.status === "error" || row.status === "rejected" ? row.status : "ok",
        redTeam: row.red_team === true
      });
      continue;
    }
    if (inferLegacyAudit) {
      const inferred = legacyAudit(row);
      if (inferred) recordToolAudit(inferred);
    }
    const key = [row.route || "unknown", row.tool || "adapter", row.model || "unknown"].join("\t");
    const group =
      groups.get(key) ||
      {
        route: row.route || "unknown",
        tool: row.tool || "adapter",
        model: row.model || "unknown",
        calls: 0,
        prompt: 0,
        completion: 0,
        cacheHit: 0,
        cacheMiss: 0
      };
    group.calls += 1;
    group.prompt += Number(row.prompt_tokens) || 0;
    group.completion += Number(row.completion_tokens) || 0;
    group.cacheHit += Number(row.cache_hit_tokens) || 0;
    group.cacheMiss += Number(row.cache_miss_tokens) || 0;
    groups.set(key, group);
  }
}

const totals = { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };
const data = Array.from(groups.values()).sort((a, b) => b.prompt + b.completion - (a.prompt + a.completion));
let knownCostTotal = 0;

for (const group of data) {
  group.cost = costForGroup(group);
  if (group.cost !== undefined) knownCostTotal += group.cost;
}

console.log(`Rows: ${rows}`);
console.log("route\ttool\tmodel\tcalls\tprompt\tcompletion\tcache_hit\tcache_miss\tcache_hit_rate\tcost_usd\tcost_pct");
for (const group of data) {
  totals.calls += group.calls;
  totals.prompt += group.prompt;
  totals.completion += group.completion;
  totals.cacheHit += group.cacheHit;
  totals.cacheMiss += group.cacheMiss;
  const cacheTotal = group.cacheHit + group.cacheMiss;
  const cacheRate = cacheTotal > 0 ? `${((group.cacheHit / cacheTotal) * 100).toFixed(1)}%` : "n/a";
  console.log(
    [
      group.route,
      group.tool,
      group.model,
      group.calls,
      group.prompt,
      group.completion,
      group.cacheHit,
      group.cacheMiss,
      cacheRate,
      formatUsd(group.cost),
      formatPct(group.cost !== undefined && knownCostTotal > 0 ? (group.cost / knownCostTotal) * 100 : undefined)
    ].join("\t")
  );
}

const totalCache = totals.cacheHit + totals.cacheMiss;
const totalRate = totalCache > 0 ? `${((totals.cacheHit / totalCache) * 100).toFixed(1)}%` : "n/a";
console.log(
  [
    "TOTAL",
    "-",
    "-",
    totals.calls,
    totals.prompt,
    totals.completion,
    totals.cacheHit,
    totals.cacheMiss,
    totalRate,
    formatUsd(knownCostTotal > 0 ? knownCostTotal : undefined),
    knownCostTotal > 0 ? "100.0%" : "n/a"
  ].join("\t")
);

const fallbackCalls = data.filter((group) => group.route === "fallback").reduce((sum, group) => sum + group.calls, 0);
const fallbackRatio = totals.calls > 0 ? (fallbackCalls / totals.calls) * 100 : 0;
const escalateCalls = data
  .filter((group) => group.route === "primary" && /-(pro|plus)(?:$|[-_.])/i.test(group.model))
  .reduce((sum, group) => sum + group.calls, 0);

console.log(`fallback_ratio\t${fallbackRatio.toFixed(1)}%`);
console.log(`escalate_calls\t${escalateCalls}`);
console.log(`cache_hit_rate\t${totalRate}`);

if (receiptTotals.rows > 0) {
  const artifactRate = (receiptTotals.artifactRows / receiptTotals.rows) * 100;
  console.log("");
  console.log("Receipt Audit");
  console.log(
    "receipt_rows\tinput_bytes\toutput_bytes\tsummary_bytes\tartifact_rows\tartifact_usage_rate\tabnormal_accept_rows\tabnormal_repair_rows\tabnormal_escalate_rows\tabnormal_reject_rows"
  );
  console.log(
    [
      receiptTotals.rows,
      receiptTotals.inputBytes,
      receiptTotals.outputBytes,
      receiptTotals.summaryBytes,
      receiptTotals.artifactRows,
      `${artifactRate.toFixed(1)}%`,
      receiptTotals.abnormal.accept,
      receiptTotals.abnormal.repair,
      receiptTotals.abnormal.escalate,
      receiptTotals.abnormal.reject
    ].join("\t")
  );
}

const gateFailures = [];

if (fallbackRatio > 10) {
  console.error(`[warn] fallback ratio ${fallbackRatio.toFixed(1)}% exceeds 10%`);
  if (gateEnabled) gateFailures.push(`fallback_ratio ${fallbackRatio.toFixed(1)}% exceeds 10%`);
}

const categoryTargets = {
  search: { min: 80, note: "file locating/search should be worker zero-LLM" },
  context_pack: { min: 70, note: "bulk file reading should use read_pack" },
  command_digest: { min: 70, note: "tests/build/lint output should use shell digest" },
  diff_digest: { min: 60, note: "diff review intake should use diff_digest/review" },
  review: { min: 60, note: "routine review should use cheap review lane" },
  mechanical_edit: { min: 50, note: "deterministic replacements should use apply_edits" },
  history: { min: 60, note: "git archaeology should use history" },
  draft: { min: 80, note: "commit/PR/changelog drafts should use draft" },
  analysis: { min: 60, note: "read-only explanations should use analyze/read_pack" }
};

const parseListEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};
const requiredCategories = parseListEnv("WORKER_RATIO_REQUIRED_CATEGORIES", []);
const maxCategoryErrorRate = Number.isFinite(Number(process.env.WORKER_CATEGORY_ERROR_MAX_PCT))
  ? Number(process.env.WORKER_CATEGORY_ERROR_MAX_PCT)
  : Number.isFinite(Number(process.env.WORKER_TOOL_ERROR_MAX_PCT))
  ? Number(process.env.WORKER_TOOL_ERROR_MAX_PCT)
  : 5;
const maxOverallToolErrorRate = Number.isFinite(Number(process.env.WORKER_OVERALL_TOOL_ERROR_MAX_PCT))
  ? Number(process.env.WORKER_OVERALL_TOOL_ERROR_MAX_PCT)
  : 5;
const maxSingleToolErrorRate = Number.isFinite(Number(process.env.WORKER_SINGLE_TOOL_ERROR_MAX_PCT))
  ? Number(process.env.WORKER_SINGLE_TOOL_ERROR_MAX_PCT)
  : 3;
const minToolErrorGateCalls = Number.isFinite(Number(process.env.WORKER_TOOL_ERROR_MIN_CALLS))
  ? Number(process.env.WORKER_TOOL_ERROR_MIN_CALLS)
  : 10;
const redTeamMinRatio = Number.isFinite(Number(process.env.WORKER_RED_TEAM_MIN_RATIO))
  ? Number(process.env.WORKER_RED_TEAM_MIN_RATIO)
  : 30;
const categoryTotals = new Map();

if (toolGroups.size > 0) {
  console.log("");
  console.log("Worker Tool Audit");
  console.log("category\ttool\tworker_calls\tmain_calls\tother_calls\tworker_ratio\ttarget\tstatus\terror_rate\trejected_calls");
  for (const group of toolGroups.values()) {
    const current = categoryTotals.get(group.category) || { worker: 0, main: 0, other: 0, ok: 0, error: 0, rejected: 0, redTeam: 0 };
    current.worker += group.worker;
    current.main += group.main;
    current.other += group.other;
    current.ok += group.ok;
    current.error += group.error;
    current.rejected += group.rejected;
    current.redTeam += group.redTeam;
    categoryTotals.set(group.category, current);
  }

  for (const [category, total] of [...categoryTotals.entries()].sort((a, b) => b[1].worker + b[1].main - (a[1].worker + a[1].main))) {
    const denominator = total.worker + total.main;
    const ratio = denominator > 0 ? (total.worker / denominator) * 100 : undefined;
    const target = categoryTargets[category]?.min;
    const status = target === undefined || ratio === undefined ? "observe" : ratio >= target ? "ok" : "below_target";
    const errorRate = total.worker + total.main + total.other > 0 ? (total.error / (total.worker + total.main + total.other)) * 100 : 0;
    console.log(
      [
        category,
        "(all)",
        total.worker,
        total.main,
        total.other,
        formatPct(ratio),
        target === undefined ? "n/a" : `${target}%`,
        status,
        `${errorRate.toFixed(1)}%`,
        total.rejected
      ].join("\t")
    );
    if (status === "below_target") {
      console.error(`[warn] ${category} worker ratio ${ratio.toFixed(1)}% is below target ${target}%: ${categoryTargets[category].note}`);
      if (gateEnabled) gateFailures.push(`${category} worker ratio ${ratio.toFixed(1)}% below target ${target}%`);
    }
    const errorGateCalls = total.worker + total.main + total.other;
    if (gateEnabled && errorGateCalls >= minToolErrorGateCalls && errorRate >= maxCategoryErrorRate) {
      gateFailures.push(`${category} error rate ${errorRate.toFixed(1)}% must stay below ${maxCategoryErrorRate}%`);
    }
  }

  for (const group of [...toolGroups.values()].sort((a, b) => b.worker + b.main - (a.worker + a.main))) {
    const denominator = group.worker + group.main;
    const ratio = denominator > 0 ? (group.worker / denominator) * 100 : undefined;
    const errorRate = group.worker + group.main + group.other > 0 ? (group.error / (group.worker + group.main + group.other)) * 100 : 0;
    console.log(
      [
        group.category,
        group.tool,
        group.worker,
        group.main,
        group.other,
        formatPct(ratio),
        "-",
        "detail",
        `${errorRate.toFixed(1)}%`,
        group.rejected
      ].join("\t")
    );
    const errorGateCalls = group.worker + group.main + group.other;
    if (gateEnabled && errorGateCalls >= minToolErrorGateCalls && errorRate >= maxSingleToolErrorRate) {
      gateFailures.push(`${group.category}/${group.tool} error rate ${errorRate.toFixed(1)}% must stay below ${maxSingleToolErrorRate}%`);
    }
  }

  const workerToolCalls = toolTotals.worker;
  const allToolCalls = [...toolGroups.values()].reduce((sum, group) => sum + group.worker + group.main + group.other, 0);
  const allToolErrors = [...toolGroups.values()].reduce((sum, group) => sum + group.error, 0);
  const overallToolErrorRate = allToolCalls > 0 ? (allToolErrors / allToolCalls) * 100 : 0;
  const startCalls = [...toolGroups.values()]
    .filter((group) => group.tool === "start")
    .reduce((sum, group) => sum + group.worker, 0);
  const startRatio = workerToolCalls > 0 ? (startCalls / workerToolCalls) * 100 : 0;
  console.log(`worker_tool_calls\t${workerToolCalls}`);
  console.log(`overall_tool_error_rate\t${overallToolErrorRate.toFixed(1)}%`);
  if (gateEnabled && allToolCalls >= minToolErrorGateCalls && overallToolErrorRate >= maxOverallToolErrorRate) {
    gateFailures.push(`overall tool error rate ${overallToolErrorRate.toFixed(1)}% must stay below ${maxOverallToolErrorRate}%`);
  }
  console.log(`start_worker_call_ratio\t${startRatio.toFixed(1)}%`);
  if (startRatio > 30) {
    console.error(`[warn] start worker call ratio ${startRatio.toFixed(1)}% exceeds 30%; use read_pack/diff_digest/shell/search for non-implementation work`);
    if (gateEnabled) gateFailures.push(`start worker call ratio ${startRatio.toFixed(1)}% exceeds 30%`);
  }
}

if (toolErrorSamples.length > 0) {
  console.log("");
  console.log("Tool Error Samples");
  console.log("ts\tcategory\ttool\terror_class\terror_message");
  for (const sample of toolErrorSamples) {
    console.log([sample.ts || "", sample.category, sample.tool, sample.error_class, sample.error_message].join("\t"));
  }
}

if (gateEnabled) {
  if (toolGroups.size === 0) {
    gateFailures.push("no worker tool_call audit rows found");
  }
  for (const category of requiredCategories) {
    if (!categoryTotals.has(category)) {
      gateFailures.push(`${category} has no audit evidence`);
    }
  }
  const diffDigestWorkerCalls = [...toolGroups.values()]
    .filter((group) => group.tool === "diff_digest")
    .reduce((sum, group) => sum + group.worker, 0);
  const diffDigestRedTeamCalls = [...toolGroups.values()]
    .filter((group) => group.tool === "diff_digest")
    .reduce((sum, group) => sum + group.redTeam, 0);
  const redTeamRatio = diffDigestWorkerCalls > 0 ? (diffDigestRedTeamCalls / diffDigestWorkerCalls) * 100 : 0;
  console.log(`diff_digest_red_team_ratio\t${redTeamRatio.toFixed(1)}%`);
  if (diffDigestWorkerCalls > 0 && redTeamRatio < redTeamMinRatio) {
    gateFailures.push(`diff_digest red-team ratio ${redTeamRatio.toFixed(1)}% below target ${redTeamMinRatio}%`);
  }
  for (const sample of receiptTotals.largeWithoutArtifact) {
    gateFailures.push(
      `${sample.category}/${sample.tool} receipt output ${sample.outputBytes} bytes exceeds ${receiptArtifactMinBytes} without artifact_ref`
    );
  }

  if (gateFailures.length > 0) {
    for (const failure of gateFailures) {
      console.error(`[gate] ${failure}`);
    }
    process.exit(2);
  }
  console.error("[gate] worker ratio gate passed");
}
