#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_CATEGORIES = {
  search_read: 2,
  analyze_diagnosis: 2,
  review: 2,
  bugfix: 2,
  small_feature_refactor: 1,
  test_log: 1
};
const FROZEN_PILOT_CORPUS_SHA256 = "304e3579327015a4c14e90054a91400b68640c30d7c7e236aa183b814b58ad9f";

function parseArgs(argv) {
  const args = { input: path.resolve("eval/fixtures/pilot-v1.json"), printHashes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value) throw new Error("--input requires a file path");
      args.input = path.resolve(value);
      index += 1;
    } else if (arg === "--print-hashes") {
      args.printHashes = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function withoutKey(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function requireNonEmptyString(value, location) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
}

function validateTaskShape(task, index) {
  const location = `tasks[${index}]`;
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`${location} must be an object`);
  for (const field of [
    "task_id",
    "category",
    "source",
    "prompt",
    "prompt_sha256",
    "fixture_ref",
    "task_spec_sha256"
  ]) {
    requireNonEmptyString(task[field], `${location}.${field}`);
  }
  for (const field of ["rubric", "required_artifacts", "expected_fact_ids"]) {
    if (!Array.isArray(task[field]) || task[field].length === 0) throw new Error(`${location}.${field} must be non-empty`);
    task[field].forEach((item, itemIndex) => requireNonEmptyString(item, `${location}.${field}[${itemIndex}]`));
  }
}

function computedHashes(corpus) {
  const tasks = corpus.tasks.map((task) => ({
    task_id: task.task_id,
    prompt_sha256: sha256Text(task.prompt),
    task_spec_sha256: sha256({
      ...withoutKey(task, "task_spec_sha256"),
      prompt_sha256: sha256Text(task.prompt)
    })
  }));
  const taskHashes = new Map(tasks.map((task) => [task.task_id, task]));
  const corpusForHash = withoutKey(corpus, "corpus_sha256");
  corpusForHash.tasks = corpus.tasks.map((task) => ({
    ...task,
    prompt_sha256: taskHashes.get(task.task_id).prompt_sha256,
    task_spec_sha256: taskHashes.get(task.task_id).task_spec_sha256
  }));
  return { tasks, corpus_sha256: sha256(corpusForHash) };
}

function validateCorpus(corpus) {
  if (!corpus || typeof corpus !== "object" || Array.isArray(corpus)) throw new Error("pilot corpus must be an object");
  if (corpus.schema_version !== 1) throw new Error("schema_version must equal 1");
  requireNonEmptyString(corpus.suite_id, "suite_id");
  requireNonEmptyString(corpus.description, "description");
  requireNonEmptyString(corpus.material_file, "material_file");
  requireNonEmptyString(corpus.material_sha256, "material_sha256");
  requireNonEmptyString(corpus.runner_protocol, "runner_protocol");
  requireNonEmptyString(corpus.corpus_sha256, "corpus_sha256");
  if (!Array.isArray(corpus.tasks) || corpus.tasks.length !== 10) throw new Error("pilot corpus must contain exactly 10 tasks");

  const taskIds = new Set();
  const categories = {};
  corpus.tasks.forEach((task, index) => {
    validateTaskShape(task, index);
    if (taskIds.has(task.task_id)) throw new Error(`duplicate task_id: ${task.task_id}`);
    taskIds.add(task.task_id);
    categories[task.category] = (categories[task.category] || 0) + 1;
  });
  if (
    Object.keys(categories).some((category) => !(category in EXPECTED_CATEGORIES)) ||
    Object.entries(EXPECTED_CATEGORIES).some(([category, count]) => categories[category] !== count)
  ) {
    throw new Error(`category quotas mismatch: ${JSON.stringify(categories)}`);
  }

  const hashes = computedHashes(corpus);
  for (const expected of hashes.tasks) {
    const task = corpus.tasks.find((candidate) => candidate.task_id === expected.task_id);
    if (task.prompt_sha256 !== expected.prompt_sha256) {
      throw new Error(`${task.task_id}.prompt_sha256 mismatch: expected ${expected.prompt_sha256}`);
    }
    if (task.task_spec_sha256 !== expected.task_spec_sha256) {
      throw new Error(`${task.task_id}.task_spec_sha256 mismatch: expected ${expected.task_spec_sha256}`);
    }
  }
  if (corpus.corpus_sha256 !== hashes.corpus_sha256) {
    throw new Error(`corpus_sha256 mismatch: expected ${hashes.corpus_sha256}`);
  }
  if (corpus.corpus_sha256 !== FROZEN_PILOT_CORPUS_SHA256) {
    throw new Error(`corpus is not the frozen pilot-v1 fixture: expected ${FROZEN_PILOT_CORPUS_SHA256}`);
  }
  const materialFile = path.resolve(corpus.material_file);
  const materialBytes = fs.readFileSync(materialFile);
  const materialSha256 = crypto.createHash("sha256").update(materialBytes).digest("hex");
  if (materialSha256 !== corpus.material_sha256) {
    throw new Error(`material_sha256 mismatch: expected ${materialSha256}`);
  }
  const material = JSON.parse(materialBytes.toString("utf8").replace(/^\uFEFF/, ""));
  for (const task of corpus.tasks) {
    const sectionName = task.fixture_ref.split("#")[1];
    const section = material.sections?.[sectionName];
    if (!section) throw new Error(`${task.task_id}.fixture_ref does not name a material section`);
    for (const factId of task.expected_fact_ids) {
      if (typeof section.facts?.[factId] !== "string") {
        throw new Error(`${task.task_id}.expected_fact_ids contains unknown fact ${factId}`);
      }
    }
  }
  return hashes;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(fs.readFileSync(args.input, "utf8").replace(/^\uFEFF/, ""));
  const hashes = computedHashes(corpus);
  if (args.printHashes) {
    console.log(JSON.stringify(hashes, null, 2));
  } else {
    validateCorpus(corpus);
    console.log(
      JSON.stringify({
        status: "ok",
        suite_id: corpus.suite_id,
        tasks: corpus.tasks.length,
        category_counts: EXPECTED_CATEGORIES,
        corpus_sha256: corpus.corpus_sha256
      })
    );
  }
} catch (error) {
  console.error(`[eval:fixtures] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
