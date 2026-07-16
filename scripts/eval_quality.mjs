#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return "Usage: node scripts/eval_quality.mjs --input <quality-pairs.jsonl>";
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value) throw new Error("--input requires a value");
      args.input = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && !args.input) throw new Error("--input is required");
  return args;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`input does not exist: ${file}`);
  const rows = [];
  for (const [index, raw] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`input line ${index + 1} is not valid JSON`);
    }
  }
  if (rows.length === 0) throw new Error("input contains no quality pairs");
  return rows;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const modulePath = path.resolve("dist/quality_evaluation.js");
  if (!fs.existsSync(modulePath)) throw new Error("compiled quality evaluation module is missing; run npm run build first");
  const quality = await import(pathToFileURL(modulePath).href);
  const summary = quality.evaluateQualityTrials(readJsonl(path.resolve(args.input)));
  console.log(JSON.stringify(summary));
  if (summary.status === "failed") process.exit(2);
  if (summary.status === "inconclusive") process.exit(4);
} catch (error) {
  console.error(`[eval:quality] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exit(2);
}
