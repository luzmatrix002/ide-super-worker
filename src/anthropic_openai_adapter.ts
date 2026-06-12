import * as http from "node:http";
import {
  fallbackConfigured,
  getClaudeCliModel,
  getFallbackApiKey,
  getFallbackBaseUrl,
  getFallbackModel,
  getGatewayApiKey,
  getGatewayBaseUrl,
  getModelName
} from "./config.js";
import { appendMetrics, pickCacheTokens } from "./metrics.js";
import { redactSecrets } from "./redact.js";

interface AdapterHandle {
  baseUrl: string;
  port: number;
  targetModel: string;
}

const adapterPromises = new Map<string, Promise<AdapterHandle>>();

// --- Extended-thinking support -------------------------------------------------
// Qwen (and most OpenAI-compatible gateways) return chain-of-thought separately
// from the answer via `reasoning_content` (some use `reasoning`). We surface that
// as a first-class Anthropic `thinking` block instead of dropping it or polluting
// the visible answer. This is the core of the "deepen thinking" upgrade.
export type ThinkingMode = "block" | "inline" | "off";

const THINKING_SIGNATURE = "qwen-adapter-unsigned";

export function resolveThinkingMode(): ThinkingMode {
  const raw = (process.env.ADAPTER_THINKING_MODE || "").trim().toLowerCase();
  if (raw === "block" || raw === "inline" || raw === "off") return raw;
  // Backward compatibility with the legacy flag.
  if (process.env.ADAPTER_INCLUDE_REASONING === "1") return "inline";
  return "block";
}

// enable_thinking on the gateway. Default ON whenever we surface reasoning;
// ADAPTER_ENABLE_THINKING=0 forces it off, =1 forces it on.
export function thinkingEnabledForGateway(): boolean {
  if (resolveThinkingMode() === "off") return process.env.ADAPTER_ENABLE_THINKING === "1";
  return process.env.ADAPTER_ENABLE_THINKING !== "0";
}

function reasoningFrom(source: any): string {
  if (typeof source?.reasoning_content === "string") return source.reasoning_content;
  if (typeof source?.reasoning === "string") return source.reasoning;
  return "";
}

// Build the thinking + text portion of an Anthropic `content` array, routing
// reasoning to a thinking block (block mode) or into the text (inline mode).
// When `suppressEmpty` is true (tool calls accompany the turn) we omit an empty
// text block; otherwise we guarantee a non-empty visible body so Claude Code's
// stream-json detection never sees a blank reply.
export function buildAnthropicContent(
  reasoning: string,
  text: string,
  mode: ThinkingMode,
  suppressEmpty = false
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const hasReasoning = reasoning.trim().length > 0;

  if (mode === "block" && hasReasoning) {
    blocks.push({ type: "thinking", thinking: reasoning, signature: THINKING_SIGNATURE });
  }

  let visible = typeof text === "string" ? text : "";
  if (mode === "inline" && hasReasoning) {
    visible = visible.trim() ? `${reasoning}\n\n${visible}` : reasoning;
  }
  // Reliability guard: an empty visible body breaks Claude Code's stream-json
  // detection. If the model only produced reasoning, surface it as the answer.
  if (!visible.trim() && hasReasoning && !suppressEmpty) {
    visible = reasoning;
  }

  if (visible.trim() || !suppressEmpty) {
    blocks.push({ type: "text", text: visible });
  }
  return blocks;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number): number => Math.min(2000, 200 * 2 ** attempt);
const MAX_RETRY_AFTER_MS = 30_000;

function upstreamTimeoutMs(): number {
  const raw = Number(process.env.ADAPTER_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

function maxUpstreamRetries(): number {
  const raw = Number(process.env.ADAPTER_MAX_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return 2;
  return Math.min(5, Math.trunc(raw));
}

function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS) || fallbackMs;
  }

  return fallbackMs;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function anthropicError(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, {
    type: "error",
    error: {
      type: status >= 500 ? "api_error" : "invalid_request_error",
      message: redactSecrets(message)
    }
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// An upstream the adapter can forward to. `primary` is the configured gateway;
// `fallback` is an optional second gateway (e.g. official DeepSeek) tried when
// the primary is unreachable or returns an error.
export interface UpstreamTarget {
  baseUrl: string;
  apiKey?: string;
  label: "primary" | "fallback";
}

export function primaryTarget(): UpstreamTarget {
  const baseUrl = getGatewayBaseUrl();
  if (!baseUrl) {
    throw new Error("ONEAPI_BASE_URL or ANTHROPIC_BASE_URL is required for adapter mode");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: getGatewayApiKey(), label: "primary" };
}

export function fallbackTarget(): UpstreamTarget | undefined {
  if (!fallbackConfigured()) return undefined;
  return { baseUrl: getFallbackBaseUrl()!.replace(/\/+$/, ""), apiKey: getFallbackApiKey(), label: "fallback" };
}

// Choose the model name for a fallback request. A model that already looks like
// a fallback-provider model (e.g. an escalated "deepseek-v4-pro") is preserved;
// otherwise we use FALLBACK_MODEL so a Qwen/primary-only name never leaks to the
// fallback provider.
function pickFallbackModel(requested: unknown): string {
  const name = typeof requested === "string" ? requested.trim() : "";
  if (name.toLowerCase().startsWith("deepseek")) return name;
  return getFallbackModel() || name || "deepseek-v4-flash";
}

function textFromAnthropicContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content
    .map((item: any) => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      if (item?.type === "tool_result") {
        return typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
      }
      if (item?.type === "image") return "[image omitted by local adapter]";
      // Thinking blocks we previously emitted must never be stringified back into
      // the prompt on later turns; drop them so they don't pollute the request.
      if (item?.type === "thinking" || item?.type === "redacted_thinking") return "";
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

function systemText(system: unknown): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return textFromAnthropicContent(system);
}

function mapMessages(body: any): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const sys = systemText(body.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const content = message?.content;
    if (message?.role === "assistant" && Array.isArray(content)) {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const item of content) {
        if (item?.type === "tool_use") {
          toolCalls.push({
            id: String(item.id || `tool_${toolCalls.length}`),
            type: "function",
            function: {
              name: String(item.name || "tool"),
              arguments: JSON.stringify(item.input || {})
            }
          });
        } else {
          const text = textFromAnthropicContent([item]);
          if (text) textParts.push(text);
        }
      }
      const mapped: Record<string, unknown> = { role: "assistant", content: textParts.join("\n") };
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      messages.push(mapped);
      continue;
    }

    if (message?.role !== "assistant" && Array.isArray(content)) {
      let textParts: string[] = [];
      const flushText = () => {
        const text = textParts.join("\n").trim();
        if (text) messages.push({ role: "user", content: text });
        textParts = [];
      };

      for (const item of content) {
        if (item?.type === "tool_result") {
          flushText();
          messages.push({
            role: "tool",
            tool_call_id: String(item.tool_use_id || item.id || "tool_call"),
            content: textFromAnthropicContent(item.content)
          });
        } else {
          const text = textFromAnthropicContent([item]);
          if (text) textParts.push(text);
        }
      }
      flushText();
      continue;
    }

    const role = message?.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: textFromAnthropicContent(content) });
  }
  return messages;
}

function finishReason(reason: unknown): string {
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

function mapTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool: any) => typeof tool?.name === "string")
    .map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
  return mapped.length > 0 ? mapped : undefined;
}

function mapToolChoice(toolChoice: any): unknown {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

// Some local/gguf gateways (llama.cpp, vLLM) reject or silently truncate when
// Claude Code asks for more output tokens than the server context allows. Mirror
// claude-code-router's `maxtoken` transformer: clamp to ADAPTER_MAX_TOKENS when set.
export function clampMaxTokens(value: unknown): number | undefined {
  const limit = Number(process.env.ADAPTER_MAX_TOKENS);
  const requested = Number(value);
  const hasRequested = Number.isFinite(requested) && requested > 0;
  if (Number.isFinite(limit) && limit > 0) {
    if (!hasRequested) return Math.trunc(limit);
    return Math.min(Math.trunc(requested), Math.trunc(limit));
  }
  return hasRequested ? Math.trunc(requested) : undefined;
}

// When the gateway ignores `enable_thinking=false`, Qwen leaks `<think>...</think>`
// into the visible content and Claude Code shows reasoning as the answer. Strip it
// by default unless the caller explicitly opted into reasoning/thinking.
export function thinkStripEnabled(): boolean {
  if (process.env.ADAPTER_STRIP_THINK === "1") return true;
  if (process.env.ADAPTER_STRIP_THINK === "0") return false;
  if (process.env.ADAPTER_INCLUDE_REASONING === "1") return false;
  if (process.env.ADAPTER_ENABLE_THINKING === "1") return false;
  return true;
}

export function stripThinkBlocks(text: string): string {
  if (!text || !thinkStripEnabled()) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*<\/?think>\s*/i, "");
}

// Longest suffix of `text` that is a prefix of `tag`. Used so a tag split across
// streaming chunks (e.g. "<thi" then "nk>") is never emitted prematurely.
function danglingPrefixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.slice(text.length - len) === tag.slice(0, len)) return len;
  }
  return 0;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Streaming-safe `<think>` remover. Buffers across deltas and only releases text
// that is provably outside a think block and not a partial open/close tag.
export class ThinkFilter {
  private buffer = "";
  private inThink = false;
  private readonly enabled: boolean;

  constructor(enabled: boolean = thinkStripEnabled()) {
    this.enabled = enabled;
  }

  push(chunk: string): string {
    if (!this.enabled) return chunk;
    this.buffer += chunk;
    let out = "";

    for (;;) {
      if (!this.inThink) {
        const open = this.buffer.indexOf(THINK_OPEN);
        if (open >= 0) {
          out += this.buffer.slice(0, open);
          this.buffer = this.buffer.slice(open + THINK_OPEN.length);
          this.inThink = true;
          continue;
        }
        const keep = danglingPrefixLength(this.buffer, THINK_OPEN);
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      }

      const close = this.buffer.indexOf(THINK_CLOSE);
      if (close >= 0) {
        this.buffer = this.buffer.slice(close + THINK_CLOSE.length);
        this.inThink = false;
        continue;
      }
      const keep = danglingPrefixLength(this.buffer, THINK_CLOSE);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return out;
    }
  }

  flush(): string {
    if (!this.enabled || this.inThink) {
      this.buffer = "";
      return "";
    }
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

function toOpenAIRequest(body: any, stream: boolean, targetModel: string): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: process.env.ADAPTER_FORWARD_MODEL === "1" ? body.model || targetModel : targetModel,
    messages: mapMessages(body),
    max_tokens: clampMaxTokens(body.max_tokens),
    temperature: body.temperature,
    top_p: body.top_p,
    stream,
    chat_template_kwargs: { enable_thinking: thinkingEnabledForGateway() }
  };

  const tools = mapTools(body.tools);
  if (tools) {
    request.tools = tools;
    request.tool_choice = mapToolChoice(body.tool_choice) || "auto";
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences;
  }

  if (stream) {
    request.stream_options = { include_usage: true };
  }

  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key];
  }
  return request;
}

async function callOpenAI(path: string, init: RequestInit, target: UpstreamTarget): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);

  return fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers
  });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// Retry the upstream call on transient failures (network errors, 5xx, connect
// timeout) with exponential backoff. The per-attempt timeout only covers the
// connect/headers phase: it is cleared once the response headers arrive, so a
// long-running (deeply thinking) body stream is never cut off. Retries happen
// before any bytes are written to the client, so they are safe for streaming too.
export async function callOpenAIWithRetry(
  path: string,
  init: RequestInit,
  externalSignal?: AbortSignal,
  target: UpstreamTarget = primaryTarget()
): Promise<Response> {
  const retries = maxUpstreamRetries();
  const timeout = upstreamTimeoutMs();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (externalSignal?.aborted) throw new Error("client disconnected before upstream request");

    const timeoutController = timeout > 0 ? new AbortController() : undefined;
    const timer = timeoutController ? setTimeout(() => timeoutController.abort(), timeout) : undefined;
    timer?.unref?.();

    try {
      const response = await callOpenAI(path, {
        ...init,
        signal: combineSignals(externalSignal, timeoutController?.signal)
      }, target);

      const retryable = response.status >= 500 || response.status === 429;
      if (retryable && attempt < retries) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new Error(`upstream returned ${response.status}`);
        if (timer) clearTimeout(timer);
        await sleep(retryAfterMs(response.headers.get("retry-after"), backoffMs(attempt)));
        continue;
      }

      if (timer) clearTimeout(timer);
      return response;
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (externalSignal?.aborted) throw error; // client gone: do not retry
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("upstream request failed");
}

// Call /chat/completions on the primary gateway, and if it is unreachable or
// returns an error response (after its own retries), transparently fail over to
// the configured fallback gateway (e.g. official DeepSeek). The failover happens
// before any bytes are streamed to the client, so it is safe for streaming too.
// The fallback request reuses the same payload but swaps in a fallback-provider
// model name.
async function callChatCompletions(
  openAIRequest: Record<string, unknown>,
  externalSignal?: AbortSignal
): Promise<{ response: Response; target: UpstreamTarget }> {
  const primary = primaryTarget();
  const fallback = fallbackTarget();

  try {
    const response = await callOpenAIWithRetry(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(openAIRequest) },
      externalSignal,
      primary
    );
    if (response.ok || !fallback) return { response, target: primary };
    // Primary returned a non-OK status and a fallback exists: drain and fail over.
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (!fallback || externalSignal?.aborted) throw error;
  }

  // Reaching here means the primary failed and a fallback exists (otherwise the
  // try block returned or rethrew). Assert non-null for the type checker.
  const target = fallback as UpstreamTarget;
  const fallbackRequest = { ...openAIRequest, model: pickFallbackModel(openAIRequest.model) };
  const response = await callOpenAIWithRetry(
    "/chat/completions",
    { method: "POST", body: JSON.stringify(fallbackRequest) },
    externalSignal,
    target
  );
  return { response, target };
}

function modelObject(id: string): Record<string, unknown> {
  return {
    id,
    object: "model",
    type: "model",
    display_name: id,
    created: 0,
    created_at: "2026-01-01T00:00:00Z"
  };
}

function adapterModelIds(targetModel: string): string[] {
  return Array.from(
    new Set([
      getClaudeCliModel(),
      "sonnet",
      "opus",
      "haiku",
      targetModel
    ].filter(Boolean))
  );
}

async function handleModels(res: http.ServerResponse, targetModel: string, id?: string): Promise<void> {
  if (id) {
    json(res, 200, modelObject(decodeURIComponent(id)));
    return;
  }

  const data = adapterModelIds(targetModel).map(modelObject);
  json(res, 200, {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id,
    last_id: data.at(-1)?.id
  });
}

function approximateTokens(body: any): number {
  const text = [systemText(body.system), ...mapMessages(body).map((message) => message.content)].filter(Boolean).join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

async function handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  json(res, 200, { input_tokens: approximateTokens(body) });
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, targetModel: string): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  const stream = body.stream === true;
  const openAIRequest = toOpenAIRequest(body, stream, targetModel);

  // Abort the upstream request if Claude Code disconnects (e.g. job cancelled),
  // so we don't keep draining tokens from the gateway for a dead client.
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const { response: upstream, target } = await callChatCompletions(openAIRequest, controller.signal);

  if (!upstream.ok) {
    const errorText = await upstream.text();
    anthropicError(res, upstream.status, errorText || `OpenAI-compatible upstream returned ${upstream.status}`);
    return;
  }

  if (stream) {
    await streamOpenAIAsAnthropic(body, upstream, res, target.label);
    return;
  }

  const data = await upstream.json();
  const choices = Array.isArray(data.choices) ? data.choices : [];
  if (choices.length === 0) {
    anthropicError(res, 502, "OpenAI-compatible upstream returned no choices");
    return;
  }

  const choice = choices[0] || {};
  const message = choice.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  // Route chain-of-thought to a native thinking block (or inline/off per mode) and
  // keep any assistant text alongside tool calls; Qwen frequently emits a short
  // rationale plus a tool call in the same turn, and dropping the text confuses
  // Claude Code's transcript.
  const reasoning = reasoningFrom(message);
  const visible = stripThinkBlocks(typeof message.content === "string" ? message.content : "");
  const content: Array<Record<string, unknown>> = buildAnthropicContent(
    reasoning,
    visible,
    resolveThinkingMode(),
    toolCalls.length > 0
  );

  for (const toolCall of toolCalls) {
    content.push({
      type: "tool_use",
      id: String(toolCall.id || `tool_${Date.now().toString(36)}`),
      name: String(toolCall.function?.name || "tool"),
      input: parseToolArguments(toolCall.function?.arguments)
    });
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  appendMetrics({
    route: target.label,
    stream: false,
    model: data.model || openAIRequest.model,
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    cache_hit_tokens: pickCacheTokens(data.usage),
    cache_miss_tokens: data.usage?.prompt_cache_miss_tokens ?? null
  });

  json(res, 200, {
    id: data.id || `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: data.model || body.model,
    content,
    stop_reason: toolCalls.length > 0 ? "tool_use" : finishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0
    }
  });
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    // Preserve malformed arguments instead of silently dropping them, so a buggy
    // tool call surfaces in the worker log rather than turning into an empty {}.
    return { _raw_arguments: value };
  }
}

function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAIAsAnthropic(
  body: any,
  upstream: Response,
  res: http.ServerResponse,
  routeLabel: "primary" | "fallback" = "primary"
): Promise<void> {
  // Acquire the reader before writing headers so a missing body becomes a clean
  // error response instead of crashing after status 200 is already committed.
  const reader = upstream.body?.getReader();
  if (!reader) {
    anthropicError(res, 502, "OpenAI-compatible upstream did not return a readable stream");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  const messageId = `msg_${Date.now().toString(36)}`;
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  // Anthropic's real API emits periodic `event: ping` during generation. Mirror it
  // so Claude Code and any intermediate proxy keep the connection alive while Qwen
  // prefills/thinks before the first visible token.
  const heartbeatMs = Math.max(1000, Number(process.env.ADAPTER_HEARTBEAT_MS) || 15000);
  writeSse(res, "ping", { type: "ping" });
  const heartbeat = setInterval(() => writeSse(res, "ping", { type: "ping" }), heartbeatMs);
  heartbeat.unref?.();

  const decoder = new TextDecoder();
  const thinkFilter = new ThinkFilter();
  const thinkingMode = resolveThinkingMode();
  let buffer = "";
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  let nextBlockIndex = 0;
  let textBlockIndex: number | undefined;
  let thinkingBlockIndex: number | undefined;
  let sawVisibleText = false;
  let reasoningBuffer = "";
  const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string }>();

  const ensureTextBlock = (): number => {
    if (textBlockIndex === undefined) {
      textBlockIndex = nextBlockIndex++;
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: textBlockIndex,
        content_block: { type: "text", text: "" }
      });
    }
    return textBlockIndex;
  };

  const ensureThinkingBlock = (): number => {
    if (thinkingBlockIndex === undefined) {
      thinkingBlockIndex = nextBlockIndex++;
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" }
      });
    }
    return thinkingBlockIndex;
  };

  const emitThinking = (raw: string): void => {
    if (!raw) return;
    reasoningBuffer += raw;
    const index = ensureThinkingBlock();
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: raw }
    });
  };

  const ensureToolBlock = (toolIndex: number, id?: string, name?: string): { blockIndex: number; id: string; name: string } => {
    const existing = toolBlocks.get(toolIndex);
    if (existing) return existing;
    const block = {
      blockIndex: nextBlockIndex++,
      id: id || `tool_${Date.now().toString(36)}_${toolIndex}`,
      name: name || "tool"
    };
    toolBlocks.set(toolIndex, block);
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: block.blockIndex,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
    });
    return block;
  };

  const emitText = (raw: string): void => {
    const text = thinkFilter.push(raw);
    if (!text) return;
    const index = ensureTextBlock();
    sawVisibleText = true;
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text }
    });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const part of parts) {
        const line = part
          .split(/\r?\n/)
          .find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // A single malformed SSE frame must not tear down the whole stream.
          continue;
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || inputTokens;
          outputTokens = chunk.usage.completion_tokens || outputTokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          stopReason = finishReason(choice.finish_reason);
        }

        const delta = choice.delta || {};
        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            const toolIndex = Number.isFinite(toolCall.index) ? toolCall.index : 0;
            const block = ensureToolBlock(toolIndex, toolCall.id, toolCall.function?.name);
            const partialJson = toolCall.function?.arguments;
            if (typeof partialJson === "string" && partialJson.length > 0) {
              writeSse(res, "content_block_delta", {
                type: "content_block_delta",
                index: block.blockIndex,
                delta: { type: "input_json_delta", partial_json: partialJson }
              });
            }
          }
        }

        // Route chain-of-thought to its own channel: a native thinking block
        // (block mode), inline into the visible text (inline mode), or dropped
        // (off mode). Keeping it separate is what lets us enable deep thinking on
        // the gateway without polluting the answer.
        const reasoningDelta =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoningDelta) {
          if (thinkingMode === "block") emitThinking(reasoningDelta);
          else if (thinkingMode === "inline") emitText(reasoningDelta);
        }

        if (typeof delta.content === "string" && delta.content) emitText(delta.content);
      }
    }

    const tail = thinkFilter.flush();
    if (tail) {
      const index = ensureTextBlock();
      sawVisibleText = true;
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: tail }
      });
    }
  } catch (error: any) {
    // Headers are already committed, so surface failures as an Anthropic SSE error
    // event rather than crashing the adapter mid-stream.
    writeSse(res, "error", {
      type: "error",
      error: { type: "api_error", message: redactSecrets(error?.message || String(error)) }
    });
  } finally {
    clearInterval(heartbeat);
    try {
      await reader.cancel();
    } catch {
      // Upstream already closed.
    }
  }

  // Reliability guard: if the model produced only reasoning and no visible answer
  // (and no tool call), surface the reasoning as the body so Claude Code never
  // sees an empty reply and treats the turn as a failure.
  if (!sawVisibleText && toolBlocks.size === 0 && reasoningBuffer.trim()) {
    const index = ensureTextBlock();
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: reasoningBuffer }
    });
  }

  const openIndexes = [
    ...(thinkingBlockIndex === undefined ? [] : [thinkingBlockIndex]),
    ...(textBlockIndex === undefined ? [] : [textBlockIndex]),
    ...Array.from(toolBlocks.values()).map((block) => block.blockIndex)
  ].sort((a, b) => a - b);
  for (const index of openIndexes) {
    // Anthropic closes a thinking block with a signature_delta before the stop.
    if (index === thinkingBlockIndex) {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: THINKING_SIGNATURE }
      });
    }
    writeSse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  if (!res.writableEnded) res.end();

  appendMetrics({
    route: routeLabel,
    stream: true,
    model: body.model,
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, targetModel: string): Promise<void> {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = (url.pathname.replace(/^\/v1\/v1(?=\/|$)/, "/v1").replace(/\/+$/, "") || "/");

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      await handleModels(res, targetModel);
      return;
    }

    const modelMatch = pathname.match(/^\/(?:v1\/)?models\/(.+)$/);
    if (req.method === "GET" && modelMatch) {
      await handleModels(res, targetModel, modelMatch[1]);
      return;
    }

    if (req.method === "POST" && (pathname === "/v1/messages/count_tokens" || pathname === "/messages/count_tokens")) {
      await handleCountTokens(req, res);
      return;
    }

    if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
      await handleMessages(req, res, targetModel);
      return;
    }

    anthropicError(res, 404, `Adapter route not found: ${req.method} ${pathname}`);
  } catch (error: any) {
    anthropicError(res, 500, error.message || String(error));
  }
}

export function shouldUseOpenAIAdapter(): boolean {
  if (process.env.USE_OPENAI_ADAPTER === "0") return false;
  if (process.env.USE_OPENAI_ADAPTER === "1") return true;
  const baseUrl = getGatewayBaseUrl() || "";
  return !baseUrl.includes("anthropic.com");
}

export function ensureAnthropicOpenAIAdapter(targetModel = getModelName()): Promise<AdapterHandle> {
  const model = targetModel.trim() || getModelName();
  const existing = adapterPromises.get(model);
  if (existing) return existing;

  const adapterPromise = new Promise<AdapterHandle>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res, model);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind local adapter"));
        return;
      }
      server.unref();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        targetModel: model
      });
    });
  });

  adapterPromises.set(model, adapterPromise);
  adapterPromise.catch(() => adapterPromises.delete(model));
  return adapterPromise;
}
