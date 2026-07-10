import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-review-"));
const previousSandboxRoot = process.env.SANDBOX_ROOT;
const previousLiteCacheDir = process.env.WORKER_LITE_CACHE_DIR;
process.env.SANDBOX_ROOT = root;
delete process.env.WORKER_LITE_CACHE_DIR;
const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_BASE_URL;
process.env.ONEAPI_BASE_URL = "https://primary.example.test/v1";
process.env.ONEAPI_API_KEY = "primary-test-key";
process.env.FALLBACK_BASE_URL = "https://fallback.example.test/v1";
process.env.FALLBACK_API_KEY = "fallback-test-key";
process.env.WORKER_SEMANTIC_REVIEW_TIMEOUT_MS = "1000";

const { runSemanticReview } = await import("../semantic_review.js");

const originalFetch = globalThis.fetch;

function reviewInput(overrides: Record<string, unknown> = {}) {
  return {
    task: "Fix the parser without changing public behavior.",
    policy: { version: 1, task_kind: "modifying" as const },
    diff: "diff --git a/src/a.ts b/src/a.ts\n-old\n+new",
    checks: [{ command: "npm test", exit_code: 0, duration_ms: 12 }],
    ...overrides
  };
}

function completion(content: string, model = "reviewer-returned-model"): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 20, completion_tokens: 8 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

try {
  {
    delete process.env.WORKER_SEMANTIC_REVIEW_MODEL;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return completion('{"verdict":"approve","issues":[]}');
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason_code, "semantic_review_model_missing");
    assert.equal(result.retryable, false);
    assert.equal(calls, 0, "missing reviewer model must fail closed without an upstream call");
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return completion('{"verdict":"approve","issues":[]}');
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput({ truncated: true }));
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reason_code, "review_input_truncated");
    assert.equal(result.retryable, false);
    assert.equal(calls, 0, "truncated evidence must never be sent to the reviewer");
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    const requests: Array<{ url: string; body: any; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers
      });
      return completion(
        '{"verdict":"approve","issues":[{"severity":"medium","path":"src/a.ts","line":7,"message":"Check this edge case"}]}'
      );
    }) as typeof fetch;

    const first = await runSemanticReview(reviewInput());
    const second = await runSemanticReview(reviewInput());
    assert.equal(first.status, "reviewed");
    assert.equal(second.status, "reviewed");
    assert.equal(requests.length, 2, "semantic review v1 must not cache identical requests");
    assert.equal(requests[0].url, "https://primary.example.test/v1/chat/completions");
    assert.equal(requests[0].body.model, "dedicated-reviewer");
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.messages[0].role, "system");
    assert.match(requests[0].body.messages[1].content, /# TASK/);
    assert.match(requests[0].body.messages[1].content, /# POLICY/);
    assert.match(requests[0].body.messages[1].content, /# DIFF/);
    assert.match(requests[0].body.messages[1].content, /# CHECKS/);
    if (first.status === "reviewed") {
      assert.equal(first.route, "primary");
      assert.equal(first.evidence.model, "reviewer-returned-model");
      assert.equal(first.evidence.verdict, "approve");
      assert.equal(first.evidence.evidence_complete, true);
      assert.equal(first.evidence.issues[0].severity, "medium");
      assert.equal(first.evidence.issues[0].path, "src/a.ts");
      assert.equal(first.evidence.issues[0].line, 7);
      assert.equal(first.evidence.issues[0].message, "Check this edge case");
      assert(first.evidence.duration_ms >= 0);
    }
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      hosts.push(url);
      return new Response("primary down", { status: 503 });
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason_code, "semantic_review_upstream_unavailable");
    assert.deepEqual(hosts, ["https://primary.example.test/v1/chat/completions"]);
  }

  {
    delete process.env.ONEAPI_BASE_URL;
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      hosts.push(String(input));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "dedicated-reviewer");
      return completion('{"verdict":"needs_changes","issues":[]}');
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "reviewed");
    if (result.status === "reviewed") {
      assert.equal(result.route, "fallback");
      assert.equal(result.evidence.verdict, "needs_changes");
    }
    assert.deepEqual(hosts, ["https://fallback.example.test/v1/chat/completions"]);
    process.env.ONEAPI_BASE_URL = "https://primary.example.test/v1";
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    globalThis.fetch = (async () =>
      completion(
        '{"verdict":"risky","issues":[{"severity":"critical","message":"Authorization behavior is not evidenced"}]}'
      )) as typeof fetch;

    const result = await runSemanticReview(reviewInput({ result: { summary: "implemented" }, diff: undefined }));
    assert.equal(result.status, "reviewed");
    if (result.status === "reviewed") {
      assert.equal(result.evidence.verdict, "risky", "the reviewer module must not rewrite policy verdicts");
      assert.equal(result.evidence.issues[0].severity, "critical");
    }
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return completion("not-json");
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "inconclusive");
    assert.equal(result.reason_code, "semantic_review_response_unparsed");
    assert.equal(result.retryable, false);
    assert.equal(calls, 1, "a successful but unparseable response must not double-bill via fallback");
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    delete process.env.FALLBACK_BASE_URL;
    delete process.env.FALLBACK_API_KEY;
    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason_code, "semantic_review_upstream_unavailable");
    assert.equal(result.retryable, true);
  }

  {
    process.env.WORKER_SEMANTIC_REVIEW_MODEL = "dedicated-reviewer";
    process.env.WORKER_SEMANTIC_REVIEW_TIMEOUT_MS = "10";
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as typeof fetch;

    const result = await runSemanticReview(reviewInput());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason_code, "semantic_review_timeout");
    assert.equal(result.retryable, true);
  }
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.WORKER_SEMANTIC_REVIEW_MODEL;
  delete process.env.WORKER_SEMANTIC_REVIEW_TIMEOUT_MS;
  delete process.env.ONEAPI_BASE_URL;
  delete process.env.ONEAPI_API_KEY;
  delete process.env.FALLBACK_BASE_URL;
  delete process.env.FALLBACK_API_KEY;
  if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
  if (previousLiteCacheDir === undefined) delete process.env.WORKER_LITE_CACHE_DIR;
  else process.env.WORKER_LITE_CACHE_DIR = previousLiteCacheDir;
  if (previousSandboxRoot === undefined) delete process.env.SANDBOX_ROOT;
  else process.env.SANDBOX_ROOT = previousSandboxRoot;
}

console.log("semantic review tests passed");
