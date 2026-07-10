import {
  fallbackConfigured,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getGatewayApiKey,
  getGatewayBaseUrl
} from "./config.js";
import { appendMetrics, pickCacheTokens } from "./metrics.js";
import type { SemanticReviewEvidenceV1, SemanticReviewIssueV1 } from "./outcome.js";
import { redactSecrets } from "./redact.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_TOKENS = 1_200;

export type { SemanticReviewEvidenceV1, SemanticReviewIssueV1 } from "./outcome.js";
export type SemanticReviewVerdict = SemanticReviewEvidenceV1["verdict"];
export type SemanticReviewSeverity = SemanticReviewIssueV1["severity"];
export type SemanticReviewRoute = "primary" | "fallback";

export interface SemanticReviewInput {
  task: string;
  policy: unknown;
  result?: unknown;
  diff?: string;
  checks?: readonly unknown[];
  truncated?: boolean;
}

export type SemanticReviewReasonCode =
  | "semantic_review_model_missing"
  | "semantic_review_gateway_missing"
  | "review_input_truncated"
  | "semantic_review_input_missing"
  | "semantic_review_input_invalid"
  | "semantic_review_response_unparsed"
  | "semantic_review_upstream_unavailable"
  | "semantic_review_timeout";

export type SemanticReviewResult =
  | {
      status: "reviewed";
      route: SemanticReviewRoute;
      evidence: SemanticReviewEvidenceV1;
    }
  | {
      status: "unavailable" | "inconclusive";
      reason_code: SemanticReviewReasonCode;
      retryable: boolean;
      duration_ms: number;
      model?: string;
      route?: SemanticReviewRoute;
    };

interface ReviewTarget {
  baseUrl: string;
  apiKey?: string;
  model: string;
  route: SemanticReviewRoute;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function reviewerTimeoutMs(): number {
  const raw = process.env.WORKER_SEMANTIC_REVIEW_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.trunc(parsed)));
}

function reviewerTarget(model: string): ReviewTarget | undefined {
  // Outcome v1 permits exactly one upstream review request. Select fallback
  // only when no primary route is configured; never fail over after a call.
  const primaryBaseUrl = getGatewayBaseUrl()?.trim();
  if (primaryBaseUrl) {
    return {
      baseUrl: primaryBaseUrl.replace(/\/+$/, ""),
      apiKey: getGatewayApiKey(),
      model,
      route: "primary"
    };
  }
  if (fallbackConfigured()) {
    return {
      baseUrl: getFallbackBaseUrl()!.replace(/\/+$/, ""),
      apiKey: getFallbackApiKey(),
      model,
      route: "fallback"
    };
  }
  return undefined;
}

function serializeEvidence(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return typeof serialized === "string" ? serialized : undefined;
}

function buildReviewPrompt(input: SemanticReviewInput): string | undefined {
  const task = input.task.trim();
  if (!task || (input.result === undefined && !input.diff)) return undefined;

  const policy = serializeEvidence(input.policy);
  const result = serializeEvidence(input.result);
  const checks = serializeEvidence(input.checks ?? []);
  if (!policy || checks === undefined) return undefined;

  return [
    "Return ONLY JSON with this exact shape:",
    '{"verdict":"approve|needs_changes|risky","issues":[{"severity":"low|medium|high|critical","path":"optional/path","line":1,"message":"short finding"}]}',
    "Use only the supplied evidence. Do not execute tools, edit files, or propose an automatic revision.",
    `\n# TASK\n${task}`,
    `\n# POLICY\n${policy}`,
    result !== undefined ? `\n# RESULT\n${result}` : "",
    input.diff ? `\n# DIFF\n${input.diff}` : "",
    `\n# CHECKS\n${checks}`
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): SemanticReviewIssueV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (!(["low", "medium", "high", "critical"] as unknown[]).includes(value.severity)) return undefined;
  if (typeof value.message !== "string" || !value.message.trim()) return undefined;
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.trim())) return undefined;
  if (value.line !== undefined && (!Number.isInteger(value.line) || Number(value.line) < 1)) return undefined;

  return {
    severity: value.severity as SemanticReviewSeverity,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    message: value.message
  };
}

function parseReviewEvidence(content: unknown, model: string, durationMs: number): SemanticReviewEvidenceV1 | undefined {
  if (typeof content !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactSecrets(content));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !(["approve", "needs_changes", "risky"] as unknown[]).includes(parsed.verdict)) {
    return undefined;
  }
  if (!Array.isArray(parsed.issues)) return undefined;
  const issues = parsed.issues.map(parseIssue);
  if (issues.some((issue) => issue === undefined)) return undefined;

  return {
    model,
    verdict: parsed.verdict as SemanticReviewVerdict,
    issues: issues as SemanticReviewIssueV1[],
    duration_ms: durationMs,
    evidence_complete: true
  };
}

/**
 * Run one independent, read-only semantic review. This path intentionally has
 * no cache and no revise loop: the caller alone decides how evidence affects
 * acceptance.
 */
export async function runSemanticReview(input: SemanticReviewInput): Promise<SemanticReviewResult> {
  const startedAt = Date.now();
  const model = process.env.WORKER_SEMANTIC_REVIEW_MODEL?.trim();
  if (!model) {
    return {
      status: "unavailable",
      reason_code: "semantic_review_model_missing",
      retryable: false,
      duration_ms: elapsedMs(startedAt)
    };
  }
  if (input.truncated) {
    return {
      status: "inconclusive",
      reason_code: "review_input_truncated",
      retryable: false,
      duration_ms: elapsedMs(startedAt),
      model
    };
  }

  let prompt: string | undefined;
  try {
    prompt = buildReviewPrompt(input);
  } catch {
    return {
      status: "inconclusive",
      reason_code: "semantic_review_input_invalid",
      retryable: false,
      duration_ms: elapsedMs(startedAt),
      model
    };
  }
  if (!prompt) {
    return {
      status: "inconclusive",
      reason_code: "semantic_review_input_missing",
      retryable: false,
      duration_ms: elapsedMs(startedAt),
      model
    };
  }

  const target = reviewerTarget(model);
  if (!target) {
    return {
      status: "unavailable",
      reason_code: "semantic_review_gateway_missing",
      retryable: false,
      duration_ms: elapsedMs(startedAt),
      model
    };
  }

  const deadline = startedAt + reviewerTimeoutMs();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return {
      status: "unavailable",
      reason_code: "semantic_review_timeout",
      retryable: true,
      duration_ms: elapsedMs(startedAt),
      model,
      route: target.route
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: target.model,
        messages: [
          {
            role: "system",
            content:
              "You are an independent semantic verifier. Judge whether the supplied evidence satisfies the declared task and policy."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: MAX_TOKENS,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        status: "unavailable",
        reason_code: "semantic_review_upstream_unavailable",
        retryable: true,
        duration_ms: elapsedMs(startedAt),
        model,
        route: target.route
      };
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      if (controller.signal.aborted || Date.now() >= deadline) {
        return {
          status: "unavailable",
          reason_code: "semantic_review_timeout",
          retryable: true,
          duration_ms: elapsedMs(startedAt),
          model,
          route: target.route
        };
      }
      return {
        status: "inconclusive",
        reason_code: "semantic_review_response_unparsed",
        retryable: false,
        duration_ms: elapsedMs(startedAt),
        model,
        route: target.route
      };
    }

    const returnedModel = typeof data?.model === "string" && data.model.trim() ? data.model.trim() : target.model;
    appendMetrics({
      route: target.route,
      tool: "semantic_review",
      model: returnedModel,
      prompt_tokens: data?.usage?.prompt_tokens ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
      cache_hit_tokens: pickCacheTokens(data?.usage),
      cache_miss_tokens: data?.usage?.prompt_cache_miss_tokens ?? null
    });

    const evidence = parseReviewEvidence(data?.choices?.[0]?.message?.content, returnedModel, elapsedMs(startedAt));
    if (!evidence) {
      return {
        status: "inconclusive",
        reason_code: "semantic_review_response_unparsed",
        retryable: false,
        duration_ms: elapsedMs(startedAt),
        model: returnedModel,
        route: target.route
      };
    }
    return { status: "reviewed", route: target.route, evidence };
  } catch {
    if (controller.signal.aborted || Date.now() >= deadline) {
      return {
        status: "unavailable",
        reason_code: "semantic_review_timeout",
        retryable: true,
        duration_ms: elapsedMs(startedAt),
        model,
        route: target.route
      };
    }
    return {
      status: "unavailable",
      reason_code: "semantic_review_upstream_unavailable",
      retryable: true,
      duration_ms: elapsedMs(startedAt),
      model,
      route: target.route
    };
  } finally {
    clearTimeout(timer);
  }
}
