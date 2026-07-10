#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return "Usage: node scripts/eval_formal.mjs --input <spans.jsonl> --manifest <manifest.json>";
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--input" || arg === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.input || !args.manifest)) {
    throw new Error("--input and --manifest are required");
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const evaluationModule = path.resolve("dist/evaluation.js");
  const formalModule = path.resolve("dist/formal_evaluation.js");
  if (!fs.existsSync(evaluationModule) || !fs.existsSync(formalModule)) {
    throw new Error("compiled evaluation modules are missing; run npm run build first");
  }
  const evaluation = await import(pathToFileURL(evaluationModule).href);
  const formal = await import(pathToFileURL(formalModule).href);
  const spans = evaluation.readEvalSpanJsonl(path.resolve(args.input));
  const manifest = formal.readFormalEvalManifest(path.resolve(args.manifest));
  const summary = formal.evaluateFormalEval(spans, manifest);
  console.log(JSON.stringify(summary));

  if (summary.status === "failed") process.exit(2);
  if (summary.status === "needs_more_tasks") process.exit(3);
  if (summary.status === "inconclusive") process.exit(4);
} catch (error) {
  console.error(`[eval:formal] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exit(2);
}
