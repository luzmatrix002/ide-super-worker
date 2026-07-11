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

// Show the 36 "unknown" entries (those with no error_class field)
const unknownErrors = searchErrors.filter((r) => !r.error_class && !r.failure_kind);
console.log("=== Unknown error entries (no error_class/failure_kind) ===");
console.log("Count:", unknownErrors.length);
for (const e of unknownErrors.slice(-10)) {
  // Print all keys to understand the structure
  console.log(JSON.stringify(e, null, 0));
}

// Also check if these have a 'receipt' or other nested error info
console.log("\n=== All keys in unknown error entries ===");
if (unknownErrors.length > 0) {
  const allKeys = new Set();
  for (const e of unknownErrors) {
    for (const k of Object.keys(e)) allKeys.add(k);
  }
  console.log([...allKeys].join(", "));
}
