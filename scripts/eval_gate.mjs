#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FROZEN_PILOT_CORPUS_SHA256 = "304e3579327015a4c14e90054a91400b68640c30d7c7e236aa183b814b58ad9f";

function usage() {
  return [
    "Usage:",
    "  node scripts/eval_gate.mjs --input <eval-spans.jsonl> [--mode paired|pilot] [--corpus <pilot.json>]",
    "  node scripts/eval_gate.mjs --import <producer.jsonl> [--out <eval-spans.jsonl>]",
    "",
    "--out defaults to WORKER_EVAL_SPAN_FILE. Import validates the complete source before append."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { mode: "paired", corpus: path.resolve("eval/fixtures/pilot-v1.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (["--input", "--import", "--out", "--mode", "--corpus"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (args.mode !== "paired" && args.mode !== "pilot") throw new Error("--mode must be paired or pilot");
  if (Boolean(args.input) === Boolean(args.import)) throw new Error("provide exactly one of --input or --import");
  if (args.input && args.out) throw new Error("--out is only valid with --import");
  if (args.import && argv.includes("--corpus")) throw new Error("--corpus is only valid with --input");
  return args;
}

function validatePilotCorpus(spans, corpusFile) {
  const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8").replace(/^\uFEFF/, ""));
  if (corpus.schema_version !== 1 || corpus.corpus_sha256 !== FROZEN_PILOT_CORPUS_SHA256) {
    throw new Error("pilot corpus is not the frozen pilot-v1 fixture");
  }
  const materialFile = path.resolve(corpus.material_file);
  const materialBytes = fs.readFileSync(materialFile);
  const materialSha256 = crypto.createHash("sha256").update(materialBytes).digest("hex");
  if (materialSha256 !== corpus.material_sha256) throw new Error("pilot material hash does not match corpus");
  const tasks = new Map(corpus.tasks.map((task) => [task.task_id, task]));
  if (tasks.size !== 10) throw new Error("pilot corpus must contain exactly 10 distinct tasks");
  for (const span of spans) {
    if (span.suite_id !== corpus.suite_id) throw new Error(`${span.span_id}: suite_id does not match pilot corpus`);
    const task = tasks.get(span.task_id);
    if (!task) throw new Error(`${span.span_id}: task_id is not in the frozen pilot corpus`);
    const promptSha256 = crypto.createHash("sha256").update(task.prompt, "utf8").digest("hex");
    if (promptSha256 !== task.prompt_sha256 || span.fingerprint.prompt_sha256 !== task.prompt_sha256) {
      throw new Error(`${span.span_id}: prompt_sha256 does not match the frozen pilot prompt`);
    }
    if (span.fingerprint.task_spec_sha256 !== task.task_spec_sha256) {
      throw new Error(`${span.span_id}: task_spec_sha256 does not match the frozen pilot corpus`);
    }
  }
  for (const field of ["commit_sha", "premium_model", "permission_profile", "deadline_ms"]) {
    if (new Set(spans.map((span) => span.fingerprint[field])).size !== 1) {
      throw new Error(`pilot spans must use one shared fingerprint.${field}`);
    }
  }
  for (const [label, values] of [
    ["price_snapshot_id", spans.map((span) => span.usage.price_snapshot_id)],
    ["evaluator_version", spans.map((span) => span.acceptance.evaluator_version)]
  ]) {
    if (new Set(values).size !== 1) throw new Error(`pilot spans must use one shared ${label}`);
  }
  return { suite_id: corpus.suite_id, corpus_sha256: corpus.corpus_sha256 };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const compiledModule = path.resolve("dist/evaluation.js");
  if (!fs.existsSync(compiledModule)) throw new Error("dist/evaluation.js is missing; run npm run build first");
  const evaluation = await import(pathToFileURL(compiledModule).href);

  if (args.import) {
    const output = args.out || process.env.WORKER_EVAL_SPAN_FILE;
    const imported = evaluation.importEvalSpanJsonl(path.resolve(args.import), output);
    console.log(
      JSON.stringify({
        status: "imported",
        imported_spans: imported,
        output: path.resolve(output)
      })
    );
  } else {
    const input = path.resolve(args.input);
    const spans = evaluation.readEvalSpanJsonl(input);
    const summary = evaluation.gateEvalSpans(spans, { mode: args.mode });
    const corpus = args.mode === "pilot" ? validatePilotCorpus(spans, path.resolve(args.corpus)) : undefined;
    console.log(JSON.stringify({ status: "ok", input, ...summary, ...(corpus ? { corpus } : {}) }));
  }
} catch (error) {
  console.error(`[eval:gate] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exit(2);
}
