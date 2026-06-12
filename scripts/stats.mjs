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

console.log(`Rows: ${rows}`);
console.log("route\ttool\tmodel\tcalls\tprompt\tcompletion\tcache_hit\tcache_miss\tcache_hit_rate");
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
      cacheRate
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
    totalRate
  ].join("\t")
);
