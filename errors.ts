/**
 * Error handling and payload helpers for the seekai.cc gateway.
 *
 * Three jobs, all pure and unit-testable without a network:
 *
 *  1. **Error-body recovery.** The gateway is `new-api`, whose failure envelope
 *     is `{"code":…,"message":…}` for several statuses (401, 503, and its own 429)
 *     with **no `error` key**. The OpenAI SDK builds its message only from
 *     `error`, so it drops those bodies and pi sees `401 status code (no body)` /
 *     `503 status code (no body)` / `429 status code (no body)` — measured offline
 *     by driving pi-ai's real adapter with the recorded bodies (see
 *     `test/errors.test.ts`). `recoverErrorBody` re-emits a non-OK body as
 *     `text/plain` so the SDK falls back to raw text and the cause survives to
 *     `message_end`.
 *
 *  2. **Readable rewrites.** `clarifySeekaiError` turns the four measured shapes
 *     (401 invalid token, 403 pre-billing credit refusal, 503/404 model_not_found,
 *     429 rate limit) into actionable sentences. Every rewrite is idempotent and
 *     is proven, in `test/errors.test.ts`, against pi's *real* classifiers
 *     (`isRetryableAssistantError`, `isContextOverflow`, `getOverflowPatterns`) to
 *     keep the retry/overflow behavior pi intends: a 429/502 stays retryable, a
 *     401/403/model_not_found does not, and none of them triggers compaction.
 *
 *  3. **Inline-`<think>` extraction.** Two ids (glm-5.3-flash,
 *     deepseek-ai/DeepSeek-V4-Flash-0731) emit reasoning *inside `content`* as
 *     `<think>…</think>` — sometimes unterminated — which pi-ai does not parse.
 *     `splitInlineThinking` / `extractInlineThinking` move it into pi `thinking`
 *     blocks. See the note above those functions for the full rationale.
 */

import type { ProviderStreams, ThinkingContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/** Where a user gets a key / tops up. The gateway has no separate console URL we could verify. */
export const SITE_URL = "https://seekai.cc";

/** Prefix marking a message this module already rewrote, so rewrites are idempotent. */
const SENTINEL = "seekai:";

// --- measured gateway shapes (raw bodies recorded in research/) ---------------

/**
 * 401 `{"code":"","message":"Invalid token"}` — with the body dropped the raw
 * message is the bare `401 status code (no body)`.
 */
const AUTH_RE = /\binvalid token\b|invalid_api_key|unauthorized|\b401\b/i;

/**
 * 403 `{"error":{"message":"预扣费额度失败, 用户剩余额度: ＄…, 需要预扣费额度: ＄…",
 * "code":"insufficient_user_quota"}}` — new-api reserves `max_tokens × price`
 * before inference and refuses when the balance cannot cover it.
 */
const BILLING_RE = /预扣费额度失败|用户剩余额度|insufficient_user_quota|insufficient balance/i;

/**
 * 503 `{"code":"model_not_found","message":"No available channel for model X under
 * group default (distributor)"}` and 404 `{"error":{"message":"Model \"…\" is not
 * supported by any configured account in this group","type":"model_not_found"}}`.
 */
const MODEL_NOT_FOUND_RE = /model_not_found|no available channel for model|not supported by any configured account/i;

/**
 * The gateway's two throttles: its own 5/min counter
 * (`您已达到总请求数限制：1分钟内最多请求5次，包括失败次数`) and the per-group
 * concurrency cap (`Concurrency limit exceeded for group`, code
 * `gateway_concurrency_limit`). Both arrive as HTTP 429.
 */
const RATE_LIMIT_RE =
  /已达到总请求数限制|concurrency limit exceeded|gateway_concurrency_limit|rate_limit_error|too many requests|\brate.?limit\b/i;

/** 502 with an HTML "Bad gateway" page from the proxy in front of the gateway. */
const BAD_GATEWAY_RE = /<!doctype html|bad gateway/i;

// --- parsing -----------------------------------------------------------------

export interface ParsedGatewayError {
  /** HTTP status parsed from the leading `<status> …` token, when present. */
  status?: number;
  /** Human-readable cause, taken from JSON when the body is JSON, else the raw text. */
  message: string;
  /** Original composed message, unchanged. */
  raw: string;
}

/**
 * Split the composed `<status>[ :] <body>` message pi produces into its status
 * and a human cause. The body may be JSON (`{"message":…}` /
 * `{"error":{"message":…}}`) or, after `recoverErrorBody`, plain text.
 */
export function parseGatewayError(errorMessage: string): ParsedGatewayError {
  const raw = errorMessage;
  let rest = errorMessage.trim();
  let status: number | undefined;

  const head = /^(\d{3})\s*:?\s*/.exec(rest);
  if (head) {
    status = Number(head[1]);
    rest = rest.slice(head[0].length).trim();
  }

  if (rest.startsWith("{")) {
    try {
      const parsed = JSON.parse(rest) as { message?: unknown; error?: { message?: unknown } };
      const candidate = parsed?.error?.message ?? parsed?.message;
      if (typeof candidate === "string" && candidate.trim()) {
        return { status, message: candidate.trim(), raw };
      }
    } catch {
      // Not JSON after all (truncated body); fall through to the raw text.
    }
  }

  return { status, message: rest, raw };
}

// --- body recovery (the dropped-body fix) ------------------------------------

/**
 * Pull a human message out of a non-OK response body. Handles new-api's
 * `{"code","message"}` and `{"error":{"message"}}` envelopes, and falls back to
 * the first line of any non-JSON body (so an HTML gateway page collapses to one
 * readable line instead of a wall of markup). Returns undefined when there is
 * nothing useful, in which case the response is passed through unchanged.
 */
export function extractGatewayMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { message?: unknown; error?: { message?: unknown } };
      const candidate = parsed?.error?.message ?? parsed?.message;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    } catch {
      // fall through
    }
    return undefined;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  return firstLine ? firstLine.slice(0, 300) : undefined;
}

/**
 * Re-emit a non-OK response body as `text/plain` so the OpenAI SDK stops dropping
 * it. A successful response is returned untouched; so is a non-OK response whose
 * body carries no usable message.
 */
export async function recoverErrorBody(response: Response): Promise<Response> {
  if (response.ok) return response;
  let body: string;
  try {
    // clone() so the original stream stays intact if we decide not to replace it.
    body = await response.clone().text();
  } catch {
    return response;
  }
  const message = extractGatewayMessage(body);
  if (!message) return response;
  return new Response(message, {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

const BODY_RECOVERY_MARK = Symbol.for("pi-seekai.bodyRecovery");

/** Wrap a fetch so every non-OK response gets the recovery treatment. Idempotent and chaining. */
export function withBodyRecovery(inner?: typeof fetch): typeof fetch {
  const base = inner ?? globalThis.fetch;
  if ((base as unknown as Record<symbol, unknown>)?.[BODY_RECOVERY_MARK]) {
    return base;
  }
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) =>
    recoverErrorBody(await base(input, init))) as typeof fetch;
  Object.defineProperty(wrapped, BODY_RECOVERY_MARK, { value: true, enumerable: false });
  return wrapped;
}

/**
 * Apply the fetch recovery to a registered api surface. pi passes its own `fetch`
 * per call; we chain onto it rather than replacing it, and preserve every other
 * option field (`onPayload`, `onResponse`, `maxTokens`, …).
 */
export function withBodyRecoveryApi(api: ProviderStreams): ProviderStreams {
  const wrapped: ProviderStreams = {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
  };
  if (api.fetchDeferred) wrapped.fetchDeferred = api.fetchDeferred;
  if (api.cancelDeferred) wrapped.cancelDeferred = api.cancelDeferred;
  return wrapped;
}

// --- readable rewrites -------------------------------------------------------

const LIMIT_WORDS = `at most 5 requests per minute, and rejected requests count toward the limit`;

/**
 * Turn a measured seekai.cc failure into an actionable sentence, or return
 * undefined when the message is not one of the known shapes (or was already
 * rewritten). Every rewrite keeps the original body for debugging.
 */
export function clarifySeekaiError(errorMessage: string): string | undefined {
  if (!errorMessage || errorMessage.startsWith(SENTINEL)) return undefined;
  const { status, message, raw } = parseGatewayError(errorMessage);

  if (AUTH_RE.test(message)) {
    return (
      `${SENTINEL} authentication failed (HTTP ${status ?? 401}) — the gateway rejected the key ` +
      "(`Invalid token`). Run `/login " +
      PROVIDER_ID +
      "` or set `SEEKAI_API_KEY` to a valid key from " +
      SITE_URL +
      ". Original: " +
      message
    );
  }

  if (BILLING_RE.test(message)) {
    return (
      `${SENTINEL} the gateway refused the request before inference (HTTP ${status ?? 403}). ` +
      "new-api reserves `max_tokens × price` against the account balance first, and the balance " +
      "could not cover it — this is a billing/quota state, not a bad key. Top up the account at " +
      SITE_URL +
      ". Original: " +
      message
    );
  }

  if (MODEL_NOT_FOUND_RE.test(message)) {
    return (
      `${SENTINEL} this model has no serving channel for your account (HTTP ${status ?? 503}, ` +
      "`model_not_found`). `GET /v1/models` advertises ids the gateway *knows*, not ids your group " +
      "can actually run — pick another model. Original: " +
      message
    );
  }

  if (RATE_LIMIT_RE.test(message)) {
    return (
      `${SENTINEL} rate limit (HTTP ${status ?? 429}): the gateway allows ${LIMIT_WORDS}. ` +
      "Wait about a minute before retrying; this is a transient throttle, not an account problem. " +
      "Original: " +
      message
    );
  }

  if (BAD_GATEWAY_RE.test(raw)) {
    return (
      `${SENTINEL} the upstream channel returned HTTP ${status ?? 502} (Bad gateway) — the model is ` +
      "temporarily unreachable. Retry shortly, or pick another model. Original: " +
      message
    );
  }

  return undefined;
}

/** True when an assistant message is a seekai failure worth rewriting. */
export function shouldClarify(message: {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === PROVIDER_ID &&
    typeof message.errorMessage === "string" &&
    clarifySeekaiError(message.errorMessage) !== undefined
  );
}

/**
 * Whether the failure should also leave a persistent TUI note (invalid key and
 * exhausted credit need a human action, unlike a transient throttle).
 */
export function needsPersistentHelp(errorMessage: string): boolean {
  if (!errorMessage) return false;
  // Called from `turn_end`, *after* `message_end` may already have replaced the
  // message with a `seekai:`-prefixed sentence, so test the rewritten text too.
  const text = errorMessage.startsWith(SENTINEL)
    ? errorMessage
    : parseGatewayError(errorMessage).message;
  return AUTH_RE.test(text) || BILLING_RE.test(text);
}

// --- inline <think> extraction -----------------------------------------------

/** The assistant content blocks this module touches. */
export type AssistantContentBlock = TextContent | ThinkingContent | ToolCall;

/**
 * Whether a text block contains an inline reasoning tag. `<think>` is the exact
 * tag measured from glm-5.3-flash and deepseek-ai/DeepSeek-V4-Flash-0731.
 */
const THINK_RE = /<think>([\s\S]*?)(?:<\/think>|$)/gi;

/**
 * Split one text block into its answer and any `<think>…</think>` reasoning.
 *
 * The closing tag may be **absent** — measured on a glm-5.3-flash tool-call turn,
 * where `content` was `<think>…` and never closed before the tool call — so an
 * unterminated `<think>` consumes the rest of the block as reasoning. The residual
 * answer is trimmed only when a tag was actually removed, so an ordinary answer is
 * never altered.
 */
export function splitInlineThinking(text: string): { text: string; thinking: string } {
  const thoughts: string[] = [];
  let out = "";
  let lastIndex = 0;
  let matched = false;

  THINK_RE.lastIndex = 0;
  for (let match = THINK_RE.exec(text); match !== null; match = THINK_RE.exec(text)) {
    matched = true;
    out += text.slice(lastIndex, match.index);
    if (match[1].trim()) thoughts.push(match[1].trim());
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) break; // defensive: never loop forever
  }

  if (!matched) return { text, thinking: "" };
  out += text.slice(lastIndex);
  return { text: out.trim(), thinking: thoughts.join("\n\n") };
}

/**
 * Move inline `<think>…</think>` reasoning out of assistant `content` text blocks
 * and into pi `thinking` blocks. Returns `undefined` (leave the message untouched)
 * when no tag is found, so the message object is not needlessly replaced.
 *
 * Rationale for rewriting at all: pi-ai has no inline-think handling (it reads
 * reasoning only from `reasoning_content` / `reasoning` / `reasoning_text`, verified
 * in `pi-ai/dist/api/openai-completions.js`). Left in `content`, the tags become
 * the assistant's *answer*: shown as the answer, persisted as the answer, and
 * replayed to the model as its own previous turn. Moving them to `thinking` blocks
 * puts them in pi's reasoning channel, and pi-ai drops unsigned thinking blocks on
 * replay, so the model never sees its reasoning echoed back as an answer.
 */
export function extractInlineThinking(
  content: readonly AssistantContentBlock[],
): AssistantContentBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const next: AssistantContentBlock[] = [];
  let changed = false;

  for (const block of content) {
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const { text, thinking } = splitInlineThinking(block.text);
    if (!thinking) {
      next.push(block);
      continue;
    }
    changed = true;
    next.push({ type: "thinking", thinking });
    if (text) next.push({ type: "text", text });
  }

  return changed ? next : undefined;
}
