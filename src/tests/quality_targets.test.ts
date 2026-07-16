import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  getQualityTargetApiKey,
  loadQualityTargetsConfig,
  type QualityTargetsConfigV1
} from "../quality_targets.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-targets-test-"));
const file = path.join(root, "targets.json");

const validConfig = (): unknown => ({
  version: 1,
  branches: [
    {
      id: "primary",
      base_url: "https://provider-a.example/v1",
      api_key_env: "QUALITY_KEY_A",
      model: "model-a",
      thinking: "probe"
    },
    {
      id: "independent",
      base_url: "https://provider-b.example/v1",
      api_key_env: "QUALITY_KEY_B",
      model: "model-b",
      thinking: "on"
    },
    {
      id: "red_team",
      base_url: "https://provider-a.example/v1",
      api_key_env: "QUALITY_KEY_C",
      model: "model-c",
      thinking: "off"
    }
  ],
  reviewer: {
    base_url: "https://reviewer.example/v1",
    api_key_env: "QUALITY_REVIEW_KEY",
    model: "strong-reviewer",
    thinking: "probe"
  }
});

const secrets = {
  QUALITY_KEY_A: "secret-a",
  QUALITY_KEY_B: "secret-b",
  QUALITY_KEY_C: "secret-c",
  QUALITY_REVIEW_KEY: "secret-reviewer"
};

function write(value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function cloneConfig(): Record<string, any> {
  return JSON.parse(JSON.stringify(validConfig())) as Record<string, any>;
}

function expectConfigError(
  value: unknown,
  expected: RegExp,
  env: Readonly<Record<string, string | undefined>> = secrets
): void {
  write(value);
  assert.throws(() => loadQualityTargetsConfig({ filePath: file, env }), expected);
}

try {
  write(validConfig());
  const loaded = loadQualityTargetsConfig({ filePath: file, env: secrets });
  assert.equal(loaded.version, 1);
  assert.deepEqual(
    loaded.branches.map((target) => target.id),
    ["primary", "independent", "red_team"]
  );
  assert.equal(loaded.reviewer.model, "strong-reviewer");
  assert.equal(getQualityTargetApiKey(loaded.branches[0], secrets), "secret-a");
  assert.equal(getQualityTargetApiKey(loaded.reviewer, secrets), "secret-reviewer");

  const serialized = JSON.stringify(loaded);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false, "loaded config must not serialize API key values");
  }

  const fromEnv = loadQualityTargetsConfig({
    env: { WORKER_QUALITY_TARGETS_FILE: file, ...secrets }
  });
  assert.deepEqual(fromEnv, loaded);

  assert.throws(
    () => loadQualityTargetsConfig({ env: secrets }),
    /WORKER_QUALITY_TARGETS_FILE must be set/
  );
  assert.throws(
    () => loadQualityTargetsConfig({ filePath: path.join(root, "missing.json"), env: secrets }),
    /does not exist/
  );
  assert.throws(
    () => loadQualityTargetsConfig({ filePath: root, env: secrets }),
    /must be a regular file/
  );

  fs.writeFileSync(file, "{not-json", "utf8");
  assert.throws(
    () => loadQualityTargetsConfig({ filePath: file, env: secrets }),
    /must contain valid JSON/
  );

  expectConfigError([], /root must be an object/);

  const wrongVersion = cloneConfig();
  wrongVersion.version = 2;
  expectConfigError(wrongVersion, /version must equal 1/);

  const extraRoot = cloneConfig();
  extraRoot.api_key = "must-not-be-accepted";
  expectConfigError(extraRoot, /unknown field "api_key"/);

  const tooFewBranches = cloneConfig();
  tooFewBranches.branches.pop();
  expectConfigError(tooFewBranches, /branches must contain exactly 3 targets/);

  const duplicateIds = cloneConfig();
  duplicateIds.branches[1].id = "primary";
  expectConfigError(duplicateIds, /branch ids must be unique/);

  const invalidId = cloneConfig();
  invalidId.branches[0].id = "bad id";
  expectConfigError(invalidId, /branches\[0\]\.id must be a token/);

  const extraTargetField = cloneConfig();
  extraTargetField.branches[0].api_key = "inline-secret";
  expectConfigError(extraTargetField, /branches\[0\].*unknown field "api_key"/);

  const invalidUrl = cloneConfig();
  invalidUrl.branches[0].base_url = "provider-a.example/v1";
  expectConfigError(invalidUrl, /branches\[0\]\.base_url must be an absolute HTTP\(S\) URL/);

  const unsafeUrl = cloneConfig();
  unsafeUrl.branches[0].base_url = "https://user:password@provider-a.example/v1?secret=x";
  expectConfigError(unsafeUrl, /must not contain credentials, query, or fragment/);

  const invalidThinking = cloneConfig();
  invalidThinking.branches[0].thinking = "auto";
  expectConfigError(invalidThinking, /thinking must be one of probe, on, off/);

  const invalidEnvName = cloneConfig();
  invalidEnvName.branches[0].api_key_env = "BAD-KEY";
  expectConfigError(invalidEnvName, /api_key_env must be an environment variable name/);

  const oneDistinctPair = cloneConfig();
  oneDistinctPair.branches[1].base_url = oneDistinctPair.branches[0].base_url;
  oneDistinctPair.branches[1].model = oneDistinctPair.branches[0].model;
  oneDistinctPair.branches[2].base_url = oneDistinctPair.branches[0].base_url;
  oneDistinctPair.branches[2].model = oneDistinctPair.branches[0].model;
  expectConfigError(oneDistinctPair, /at least 2 distinct base_url \+ model pairs/);

  const reusedReviewer = cloneConfig();
  reusedReviewer.reviewer.base_url = reusedReviewer.branches[0].base_url;
  reusedReviewer.reviewer.model = reusedReviewer.branches[0].model;
  expectConfigError(reusedReviewer, /reviewer base_url \+ model pair must differ from every branch/);

  const missingKeyEnv = { ...secrets };
  delete (missingKeyEnv as Record<string, string | undefined>).QUALITY_KEY_B;
  expectConfigError(validConfig(), /QUALITY_KEY_B must contain a non-empty API key/, missingKeyEnv);

  const visibleSecret = "do-not-leak-this-value";
  const missingReviewerKey = {
    ...secrets,
    QUALITY_KEY_A: visibleSecret,
    QUALITY_REVIEW_KEY: "   "
  };
  let failure = "";
  try {
    loadQualityTargetsConfig({ filePath: file, env: missingReviewerKey });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  assert.match(failure, /QUALITY_REVIEW_KEY must contain a non-empty API key/);
  assert.equal(failure.includes(visibleSecret), false);

  const runtimeEnv = { QUALITY_KEY_A: visibleSecret };
  assert.equal(getQualityTargetApiKey(loaded.branches[0], runtimeEnv), visibleSecret);
  let runtimeFailure = "";
  try {
    getQualityTargetApiKey(loaded.branches[0], { QUALITY_KEY_A: " " });
  } catch (error) {
    runtimeFailure = error instanceof Error ? error.message : String(error);
  }
  assert.match(runtimeFailure, /QUALITY_KEY_A must contain a non-empty API key/);
  assert.equal(runtimeFailure.includes(visibleSecret), false);

  const typed: QualityTargetsConfigV1 = loaded;
  assert.equal(Object.prototype.hasOwnProperty.call(typed.branches[0], "apiKey"), false);

  console.log("quality targets tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
