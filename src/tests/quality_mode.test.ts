import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality-mode-test-"));
const coordination = path.join(root, "coordination");
const metrics = path.join(root, "metrics.jsonl");
const targetsFile = path.join(root, "quality-targets.json");
const sourceFile = path.join(root, "source.ts");
fs.writeFileSync(sourceFile, "export const answer = 42;\n", "utf8");

process.env.SANDBOX_ROOT = root;
process.env.WORKER_FANOUT_ENABLED = "1";
process.env.WORKER_FANOUT_MAX_ACTIVE = "1";
process.env.WORKER_LITE_MAX_CONCURRENCY = "3";
process.env.WORKER_GLOBAL_LITE_MAX = "3";
process.env.WORKER_GLOBAL_LITE_QUEUE_MAX = "6";
process.env.WORKER_GLOBAL_COORDINATION_DIR = coordination;
process.env.WORKER_GLOBAL_ACQUIRE_TIMEOUT_MS = "15000";
process.env.WORKER_LITE_CACHE_DIR = path.join(root, "cache");
process.env.WORKER_METRICS_FILE = metrics;
process.env.WORKER_QUALITY_TARGETS_FILE = targetsFile;
for (const name of ["QUALITY_KEY_A", "QUALITY_KEY_B", "QUALITY_KEY_C", "QUALITY_REVIEW_KEY"]) process.env[name] = `secret-${name}`;

fs.writeFileSync(
  targetsFile,
  JSON.stringify({
    version: 1,
    branches: [
      { id: "primary", base_url: "https://a.test/v1", api_key_env: "QUALITY_KEY_A", model: "model-a", thinking: "on" },
      { id: "independent", base_url: "https://b.test/v1", api_key_env: "QUALITY_KEY_B", model: "model-b", thinking: "on" },
      { id: "red_team", base_url: "https://c.test/v1", api_key_env: "QUALITY_KEY_C", model: "model-c", thinking: "on" }
    ],
    reviewer: {
      base_url: "https://review.test/v1",
      api_key_env: "QUALITY_REVIEW_KEY",
      model: "model-review",
      thinking: "on"
    }
  }),
  "utf8"
);

const originalFetch = globalThis.fetch;
const quality = await import("../quality_mode.js");
const lite = await import("../lite.js");

let calls = 0;
let missingThinkingHost = "";
let lengthHost = "";
let reviewerApprovesSevere = false;
const requestBodies: any[] = [];

function hostModel(url: string): string {
  if (url.includes("a.test")) return "model-a";
  if (url.includes("b.test")) return "model-b";
  if (url.includes("c.test")) return "model-c";
  return "model-review";
}

function branchId(url: string): string {
  if (url.includes("a.test")) return "primary";
  if (url.includes("b.test")) return "independent";
  return "red_team";
}

function completion(model: string, content: string, reasoning = "private reasoning", finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      model,
      usage: { prompt_tokens: 20, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: reasoning ? 5 : 0 } },
      choices: [{ finish_reason: finishReason, message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls += 1;
  const url = String(input);
  const body = JSON.parse(String(init?.body));
  requestBodies.push(body);
  const model = hostModel(url);
  const reasoning = missingThinkingHost && url.includes(missingThinkingHost) ? "" : "private reasoning";
  const finishReason = lengthHost && url.includes(lengthHost) ? "length" : "stop";
  if (url.includes("review.test")) {
    const severe = reviewerApprovesSevere;
    const isReview = String(body.messages?.[0]?.content ?? "").includes("# KIND\nreview");
    return completion(
      model,
      JSON.stringify({
        result: severe
          ? { verdict: "approve", issues: [], summary: "incorrect approval" }
          : isReview
            ? { verdict: "approve", issues: [], summary: "clean review" }
            : "final analyzed answer",
        claims: [{ claim: "the source declares answer", citations: [{ file: sourceFile, line: 1, claim: "source declaration" }] }],
        resolutions: ["primary", "independent", "red_team"].map((id) => ({
          branch_id: id,
          claim_id: `claim-${id}`,
          status: "accepted",
          reason: "supported by source",
          citations: [{ file: sourceFile, line: 1, claim: "source declaration" }]
        })),
        unresolved_disagreements: []
      }),
      reasoning,
      finishReason
    );
  }
  const id = branchId(url);
  return completion(
    model,
    JSON.stringify({
      summary: `${id} summary`,
      verdict: "approve",
      claims: [
        {
          id: `claim-${id}`,
          claim: "the source declares answer",
          severity: reviewerApprovesSevere && id === "red_team" ? "critical" : "low",
          citations: [{ file: sourceFile, line: 1, claim: "source declaration" }]
        }
      ]
    }),
    reasoning,
    finishReason
  );
}) as typeof fetch;

try {
  const evidence = lite.buildEvidencePack([sourceFile]);
  const first = await quality.runHighQualityAnalyze({
    prompt: "What does the source declare?",
    evidenceContent: evidence.content,
    evidenceTruncated: evidence.truncated
  });
  assert.equal(first.status, "qualified", JSON.stringify(first));
  assert.equal(first.contract_version, "quality.v1");
  assert.equal(first.result, "final analyzed answer");
  assert.equal(first.execution.branches_completed, 3);
  assert.deepEqual(first.execution.branch_models, ["model-a", "model-b", "model-c"]);
  assert.equal(first.execution.reviewer_model, "model-review");
  assert.match(first.execution.config_fingerprint || "", /^[a-f0-9]{64}$/);
  assert(first.execution.thinking_requested.every(Boolean));
  assert(first.execution.thinking_observed.every(Boolean));
  assert(first.evidence.complete);
  assert(first.evidence.citations.length > 0);
  assert.equal(calls, 4, "high analyze must make three branches plus one reviewer call");
  assert(requestBodies.every((body) => body.chat_template_kwargs?.enable_thinking === true));

  await quality.runHighQualityAnalyze({
    prompt: "What does the source declare?",
    evidenceContent: evidence.content,
    evidenceTruncated: evidence.truncated
  });
  assert.equal(calls, 8, "high mode must bypass the Lite cache");

  missingThinkingHost = "b.test";
  const noThinking = await quality.runHighQualityAnalyze({
    prompt: "thinking required",
    evidenceContent: evidence.content,
    evidenceTruncated: false
  });
  assert.equal(noThinking.status, "needs_direct_review");
  assert(noThinking.reason_codes.includes("thinking_not_observed"));
  missingThinkingHost = "";

  lengthHost = "c.test";
  const truncated = await quality.runHighQualityAnalyze({
    prompt: "do not accept truncation",
    evidenceContent: evidence.content,
    evidenceTruncated: false
  });
  assert.equal(truncated.status, "needs_direct_review");
  assert(truncated.reason_codes.includes("output_truncated"));
  lengthHost = "";

  const beforeEvidenceReject = calls;
  const rejectedEvidence = await quality.runHighQualityAnalyze({
    prompt: "truncated evidence",
    evidenceContent: evidence.content,
    evidenceTruncated: true
  });
  assert.equal(rejectedEvidence.status, "needs_direct_review");
  assert(rejectedEvidence.reason_codes.includes("evidence_truncated"));
  assert.equal(calls, beforeEvidenceReject, "truncated evidence must fail before any model call");

  const cleanReview = await quality.runHighQualityReview({
    task: "Review the source",
    evidenceContent: evidence.content,
    evidenceTruncated: false
  });
  assert.equal(cleanReview.status, "qualified", JSON.stringify(cleanReview));
  assert.equal(typeof cleanReview.result === "string" ? "" : cleanReview.result?.verdict, "approve");

  reviewerApprovesSevere = true;
  const maskedCritical = await quality.runHighQualityReview({
    task: "Review the source",
    evidenceContent: evidence.content,
    evidenceTruncated: false
  });
  assert.equal(maskedCritical.status, "needs_direct_review");
  assert(maskedCritical.reason_codes.includes("quality_synthesis_unparsed_or_incomplete"));

  reviewerApprovesSevere = false;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createCodexWorkerServer } = await import("../server.js");
  const server = createCodexWorkerServer();
  const client = new Client({ name: "quality-mode-contract-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    for (const name of ["analyze", "review"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert(tool, `missing ${name} tool`);
      const property = (tool.inputSchema as any).properties?.quality_mode;
      assert.deepEqual(property?.enum, ["standard", "high"]);
    }
    const response = await client.callTool({
      name: "analyze",
      arguments: { prompt: "MCP high mode", files: [sourceFile], quality_mode: "high" }
    });
    const text = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
    assert(text);
    const payload = JSON.parse(text);
    assert.equal(payload.contract_version, "quality.v1");
    assert.equal(payload.status, "qualified");

    const invalidResponse = await client.callTool({
      name: "analyze",
      arguments: { prompt: "invalid path", files: [path.join(root, "missing.ts")] }
    });
    const invalidText = (invalidResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
    assert(invalidText);
    const invalidPayload = JSON.parse(invalidText);
    assert.equal(invalidPayload.status, "rejected");
  } finally {
    await client.close();
    await server.close();
  }

  const metricText = fs.readFileSync(metrics, "utf8");
  const metricRows = metricText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert(
    metricRows.some((row) => row.event === "tool_call" && row.tool === "analyze" && row.status === "rejected"),
    "invalid analyze paths must be audited as rejected caller input"
  );
  assert(
    !metricRows.some((row) => row.event === "tool_call" && row.tool === "analyze" && row.status === "error" && /missing\.ts/.test(row.error_message || "")),
    "invalid analyze paths must not inflate tool execution error rate"
  );
  for (const secretName of ["QUALITY_KEY_A", "QUALITY_KEY_B", "QUALITY_KEY_C", "QUALITY_REVIEW_KEY"]) {
    assert(!metricText.includes(String(process.env[secretName])), "metrics must not contain quality API keys");
  }
  assert(!metricText.includes("private reasoning"), "metrics must not contain hidden reasoning content");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("quality mode tests passed");
