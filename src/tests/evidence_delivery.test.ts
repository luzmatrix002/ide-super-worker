import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-delivery-test-"));
const project = path.join(root, "project");
const srcDir = path.join(project, "src");
fs.mkdirSync(srcDir, { recursive: true });

process.env.SANDBOX_ROOT = root;
process.env.ONEAPI_API_KEY = "unit-test-api-key";
process.env.WORKER_LITE_CACHE_DIR = "";
process.env.WORKER_METRICS_FILE = "";

const workerTools = await import("../worker_tools.js");
const artifacts = await import("../artifacts.js");

function gitStatus(): string {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function readArtifact(ref: string): string {
  let offset = 0;
  let text = "";
  while (true) {
    const slice = artifacts.getArtifactSlice({ artifact_ref: ref, offset, limit: 64_000 }) as any;
    text += String(slice.text);
    if (!slice.truncated) return text;
    offset += slice.limit;
  }
}

for (const args of [["init"], ["config", "user.email", "test@example.test"], ["config", "user.name", "Evidence Test"]]) {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

const smallFile = path.join(srcDir, "small.ts");
fs.writeFileSync(smallFile, "export const needle = 'small';\n", "utf8");
const smallBefore = gitStatus();
const smallPack = workerTools.buildContextPack({
  task: "find needle",
  paths: ["src/small.ts"],
  base_dir: project
}) as any;
assert.equal(smallPack.task, "find needle");
assert.equal(smallPack.mode, "zero_llm_symbol_slices");
assert.equal(smallPack.file_count, 1);
assert.equal(smallPack.files[0].file, "src/small.ts");
assert(String(smallPack.files[0].slices[0].text).includes("small"));
assert.equal(smallPack.truncated, false);
assert(smallPack.receipt.summary_bytes <= 16_000);
assert.equal(smallPack.receipt.artifact_refs.length, 1);
assert.equal(smallPack.receipt.abnormal.verdict, "accept");
assert.equal(gitStatus(), smallBefore, "read_pack must not modify the workspace");

const emptyFile = path.join(srcDir, "empty.ts");
const largeFile = path.join(srcDir, "large.ts");
fs.writeFileSync(emptyFile, "", "utf8");
const largeLines = [
  "export const evidenceNeedleHead = 'HEAD-MARKER unit-test-api-key Bearer abcdefghijklmnop sk-live-test-secret-123456';",
  ...Array.from(
    { length: 180 },
    (_, index) => `export const evidenceNeedle${index} = "中文证据-${index}-${"x".repeat(160)}";`
  ),
  "export const evidenceNeedleTail = 'TAIL-MARKER';"
];
fs.writeFileSync(largeFile, `${largeLines.join("\n")}\n`, "utf8");

const largePack = workerTools.buildContextPack({
  task: "find evidenceNeedle",
  paths: ["src/empty.ts", "src/large.ts", "src/small.ts"],
  base_dir: project,
  max_bytes_per_file: 120_000,
  window_lines: 4
}) as any;
assert.equal(largePack.file_count, 3);
assert.deepEqual(
  largePack.files.map((file: any) => file.file),
  ["src/empty.ts", "src/large.ts", "src/small.ts"]
);
assert.equal(largePack.truncated, true);
assert(largePack.receipt.summary_bytes <= 16_000, `summary was ${largePack.receipt.summary_bytes} bytes`);
assert.equal(largePack.receipt.artifact_refs.length, 1);
assert.equal(largePack.receipt.abnormal.verdict, "accept");

const inlineText = JSON.stringify(largePack);
assert(!inlineText.includes("unit-test-api-key"));
assert(!inlineText.includes("abcdefghijklm"));
assert(!inlineText.includes("sk-live-test-secret-123456"));

const fullArtifact = readArtifact(largePack.receipt.artifact_refs[0]);
assert(fullArtifact.includes("HEAD-MARKER"));
assert(fullArtifact.includes("TAIL-MARKER"));
assert(fullArtifact.includes("中文证据"));
assert(!fullArtifact.includes("unit-test-api-key"));
assert(!fullArtifact.includes("abcdefghijklm"));
assert(!fullArtifact.includes("sk-live-test-secret-123456"));

const capFiles: string[] = [];
for (let index = 0; index < 6; index += 1) {
  const file = path.join(srcDir, `cap-${index}.ts`);
  fs.writeFileSync(file, `export const capNeedle${index} = "${"z".repeat(105_000)}";\n`, "utf8");
  capFiles.push(path.relative(project, file).replace(/\\/g, "/"));
}
const cappedPack = workerTools.buildContextPack({
  task: "find capNeedle",
  paths: capFiles,
  base_dir: project,
  max_files: 10,
  max_bytes_per_file: 120_000,
  window_lines: 1
}) as any;
assert.equal(cappedPack.truncated, true);
assert(cappedPack.packed_bytes <= 500_000);
assert(cappedPack.receipt.summary_bytes <= 16_000);
assert.equal(cappedPack.receipt.artifact_refs.length, 1);

console.log("evidence delivery tests passed");
