import * as fs from "node:fs";

const metricsFile = "D:/.worker-metrics.jsonl";
if (!fs.existsSync(metricsFile)) {
  console.log("Metrics file not found:", metricsFile);
  process.exit(0);
}

const lines = fs.readFileSync(metricsFile, "utf8").split("\n").filter(Boolean);
const rows = [];
for (const line of lines) {
  try {
    rows.push(JSON.parse(line));
  } catch {
    // skip
  }
}

// Search tool calls
const searchCalls = rows.filter((r) => r.tool === "search" && r.event === "tool_call");
const searchErrors = searchCalls.filter((r) => r.status === "error");
const searchOk = searchCalls.filter((r) => r.status === "ok");

console.log("=== Search Tool Summary ===");
console.log("Total search calls:", searchCalls.length);
console.log("Search errors:", searchErrors.length);
console.log("Search ok:", searchOk.length);
console.log("Error rate:", searchCalls.length > 0 ? ((searchErrors.length / searchCalls.length) * 100).toFixed(1) + "%" : "N/A");

console.log("\n=== Search Error Details (last 30) ===");
for (const e of searchErrors.slice(-30)) {
  console.log(JSON.stringify({
    ts: e.ts,
    category: e.category,
    error_class: e.error_class,
    failure_kind: e.failure_kind,
    error_message: (e.error_message || "").slice(0, 300),
  }));
}

// Count by error_class
console.log("\n=== Error class distribution ===");
const byClass = {};
for (const e of searchErrors) {
  const cls = e.error_class || e.failure_kind || "unknown";
  byClass[cls] = (byClass[cls] || 0) + 1;
}
for (const [cls, count] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls}: ${count}`);
}

// Count by error message pattern
console.log("\n=== Error message patterns ===");
const byMsg = {};
for (const e of searchErrors) {
  const msg = (e.error_message || "").slice(0, 100);
  byMsg[msg] = (byMsg[msg] || 0) + 1;
}
for (const [msg, count] of Object.entries(byMsg).sort((a, b) => b[1] - a[1])) {
  console.log(`  [${count}] ${msg}`);
}

// Recent 48h
const now = Date.now();
const h48 = now - 48 * 60 * 60 * 1000;
const recentSearchCalls = searchCalls.filter((r) => {
  const ts = Date.parse(r.ts || "");
  return Number.isFinite(ts) && ts >= h48;
});
const recentSearchErrors = recentSearchCalls.filter((r) => r.status === "error");
console.log("\n=== Recent 48h ===");
console.log("Recent search calls:", recentSearchCalls.length);
console.log("Recent search errors:", recentSearchErrors.length);
console.log("Recent error rate:", recentSearchCalls.length > 0 ? ((recentSearchErrors.length / recentSearchCalls.length) * 100).toFixed(1) + "%" : "N/A");

for (const e of recentSearchErrors.slice(-20)) {
  console.log(JSON.stringify({
    ts: e.ts,
    error_class: e.error_class,
    failure_kind: e.failure_kind,
    error_message: (e.error_message || "").slice(0, 300),
  }));
}
