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

const file = process.argv[2] || process.env.WORKER_METRICS_FILE;
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
let rows = 0;

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
    rows += 1;
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

if (fallbackRatio > 10) {
  console.error(`[warn] fallback ratio ${fallbackRatio.toFixed(1)}% exceeds 10%`);
}
