#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const compiledTest = path.resolve("dist/tests/evaluation.test.js");

if (!fs.existsSync(compiledTest)) {
  console.error("[eval:contracts] dist/tests/evaluation.test.js is missing; run npm run build first");
  process.exit(2);
}

try {
  await import(pathToFileURL(compiledTest).href);
  console.log("[eval:contracts] EvalSpan v1 contract passed");
} catch (error) {
  console.error(`[eval:contracts] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(2);
}
