import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { getOverflowPatterns, isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  clarifySeekaiError,
  extractGatewayMessage,
  extractInlineThinking,
  needsPersistentHelp,
  parseGatewayError,
  recoverErrorBody,
  shouldClarify,
  splitInlineThinking,
  withBodyRecovery,
} from "../errors.ts";

/**
 * The exact messages pi composes from the gateway's recorded bodies (2026-09-26),
 * *after* `withBodyRecovery` re-emits the new-api `{code,message}` envelope as
 * text. Without the wrapper these four lose their body entirely and read as
 * `"<status> status code (no body)"` (verified offline by driving pi-ai's real
 * adapter — see research/raw/compose2.mjs).
 */
const AUTH_SEEN = "401 Invalid token";
const AUTH_DROPPED = "401 status code (no body)";
const MODEL_NOT_FOUND_503 = "503 No available channel for model xyz under group default (distributor)";
const MODEL_NOT_FOUND_404 =
  '404 Model "自部署/Qwen3.8-27B" is not supported by any configured account in this group';
const BILLING =
  "403 预扣费额度失败, 用户剩余额度: ＄12.345678, 需要预扣费额度: ＄1500.000016";
const RATE_LIMIT_429 = "429 您已达到总请求数限制：1分钟内最多请求5次，包括失败次数";
const CONCURRENCY_429 = "429 Concurrency limit exceeded for group, please retry later";
const BAD_GATEWAY = "502 <!DOCTYPE html><html><head><title>seekai.cc | 502: Bad gateway</title></head></html>";

function assistant(errorMessage: string) {
  return {
    role: "assistant" as const,
    stopReason: "error" as const,
    provider: "seekai",
    errorMessage,
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  } as any;
}

describe("parseGatewayError", () => {
  test("splits the leading status from a recovered plain-text body", () => {
    assert.deepEqual(parseGatewayError(AUTH_SEEN), { status: 401, message: "Invalid token", raw: AUTH_SEEN });
  });

  test("unwraps a JSON envelope that still carries one (pre-recovery)", () => {
    const parsed = parseGatewayError('403: {"error":{"message":"预扣费额度失败","code":"insufficient_user_quota"}}');
    assert.equal(parsed.status, 403);
    assert.equal(parsed.message, "预扣费额度失败");
  });

  test("keeps a bodiless message as-is", () => {
    const parsed = parseGatewayError(AUTH_DROPPED);
    assert.equal(parsed.status, 401);
    assert.equal(parsed.message, "status code (no body)");
  });
});

describe("body recovery (the dropped-body fix)", () => {
  test("re-emits a new-api {code,message} body as plain text", async () => {
    const response = new Response('{"code":"","message":"Invalid token"}', {
      status: 401,
      headers: { "content-type": "application/json", "retry-after": "30" },
    });
    const recovered = await recoverErrorBody(response);
    assert.equal(recovered.status, 401);
    assert.match(recovered.headers.get("content-type") ?? "", /text\/plain/);
    // Other headers (e.g. Retry-After, which pi's retry may honor) survive.
    assert.equal(recovered.headers.get("retry-after"), "30");
    assert.equal(await recovered.text(), "Invalid token");
  });

  test("collapses an HTML gateway page to its first line", async () => {
    const response = new Response("<!DOCTYPE html>\n<html>…</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    assert.equal(await recoverErrorBody(response).then((r) => r.text()), "<!DOCTYPE html>");
  });

  test("leaves successful responses and bodiless errors untouched", async () => {
    const ok = new Response("fine", { status: 200 });
    assert.equal(await recoverErrorBody(ok), ok);

    const empty = new Response("", { status: 500 });
    assert.equal(await recoverErrorBody(empty), empty);
  });

  test("extractGatewayMessage prefers error.message, then message, then raw text", () => {
    assert.equal(extractGatewayMessage('{"error":{"message":"a"}}'), "a");
    assert.equal(extractGatewayMessage('{"message":"b"}'), "b");
    assert.equal(extractGatewayMessage("plain  text"), "plain  text");
    assert.equal(extractGatewayMessage("   "), undefined);
    assert.equal(extractGatewayMessage('{"code":1}'), undefined);
  });

  test("withBodyRecovery chains onto the inner fetch and is idempotent", async () => {
    let calls = 0;
    const inner = (async () => {
      calls++;
      return new Response('{"code":"","message":"Invalid token"}', { status: 401 });
    }) as unknown as typeof fetch;

    const wrapped = withBodyRecovery(inner);
    const again = withBodyRecovery(wrapped);
    assert.equal(again, wrapped, "double registration must not double-wrap");
    const response = await wrapped("https://seekai.cc/v1/chat/completions");
    assert.equal(calls, 1);
    assert.equal(await response.text(), "Invalid token");
  });
});

describe("readable rewrites", () => {
  test("401 invalid token names the key, the login command and the env var", () => {
    const clarified = clarifySeekaiError(AUTH_SEEN)!;
    assert.ok(clarified.startsWith("seekai: "));
    assert.match(clarified, /401/);
    assert.match(clarified, /\/login seekai/);
    assert.match(clarified, /SEEKAI_API_KEY/);
    assert.match(clarified, /https:\/\/seekai\.cc/);
  });

  test("401 also works when the body was dropped (defensive)", () => {
    assert.match(clarifySeekaiError(AUTH_DROPPED)!, /authentication failed/);
  });

  test("403 pre-billing is explained as a credit reservation, not a bad key", () => {
    const clarified = clarifySeekaiError(BILLING)!;
    assert.match(clarified, /max_tokens × price/);
    assert.match(clarified, /not a bad key/);
    assert.match(clarified, /https:\/\/seekai\.cc/);
  });

  test("503 and 404 model_not_found become one actionable sentence", () => {
    for (const raw of [MODEL_NOT_FOUND_503, MODEL_NOT_FOUND_404]) {
      const clarified = clarifySeekaiError(raw)!;
      assert.match(clarified, /model_not_found/);
      assert.match(clarified, /pick another model/);
      assert.doesNotMatch(clarified, /\b50[234]\b/, "must not echo a retryable status code");
    }
  });

  test("both 429 throttles are readable and keep the 5/min rule", () => {
    for (const raw of [RATE_LIMIT_429, CONCURRENCY_429]) {
      const clarified = clarifySeekaiError(raw)!;
      assert.match(clarified, /rate limit/);
      assert.match(clarified, /5 requests per minute/);
    }
  });

  test("502 bad gateway is readable", () => {
    const clarified = clarifySeekaiError(BAD_GATEWAY)!;
    assert.match(clarified, /502/);
    assert.match(clarified, /Bad gateway/);
  });

  test("leaves unrelated failures untouched and is idempotent", () => {
    assert.equal(clarifySeekaiError("500 boom internal"), undefined);
    assert.equal(clarifySeekaiError(""), undefined);
    for (const raw of [AUTH_SEEN, BILLING, MODEL_NOT_FOUND_404, RATE_LIMIT_429, BAD_GATEWAY]) {
      const once = clarifySeekaiError(raw)!;
      assert.equal(clarifySeekaiError(once), undefined, "second pass must be a no-op");
    }
  });
});

describe("negative-safety against pi's real classifiers", () => {
  const overflowPatterns = getOverflowPatterns();
  const cases: [string, string][] = [
    ["auth", AUTH_SEEN],
    ["billing", BILLING],
    ["model_not_found", MODEL_NOT_FOUND_503],
    ["rate limit", RATE_LIMIT_429],
    ["concurrency limit", CONCURRENCY_429],
    ["bad gateway", BAD_GATEWAY],
  ];

  test("no rewrite accidentally triggers auto-compaction", () => {
    for (const [name, raw] of cases) {
      const clarified = clarifySeekaiError(raw)!;
      assert.equal(isContextOverflow(assistant(clarified)), false, name);
      for (const pattern of overflowPatterns) {
        assert.equal(pattern.test(clarified), false, `${name} matches overflow pattern ${pattern}`);
      }
    }
  });

  test("a 429 / 502 stays retryable, a deterministic failure does not", () => {
    // Transient throttles and upstream gateways must keep pi's retry behavior.
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(RATE_LIMIT_429)!)), true);
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(CONCURRENCY_429)!)), true);
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(BAD_GATEWAY)!)), true);
    // Deterministic: an invalid key, an empty balance, a missing channel.
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(AUTH_SEEN)!)), false);
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(BILLING)!)), false);
    assert.equal(isRetryableAssistantError(assistant(clarifySeekaiError(MODEL_NOT_FOUND_503)!)), false);
  });

  test("the model_not_found rewrite is what removes the wasteful retry (control)", () => {
    // Raw "503 …" is retryable by pi's catalog; retrying a no-channel routing
    // error three times only burns the gateway's 5/min budget.
    assert.equal(isRetryableAssistantError(assistant(MODEL_NOT_FOUND_503)), true);
  });
});

describe("shouldClarify / needsPersistentHelp", () => {
  test("shouldClarify is guarded to this provider and error stops", () => {
    assert.equal(shouldClarify(assistant(AUTH_SEEN)), true);
    assert.equal(shouldClarify(assistant("500 boom internal")), false);
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "error", provider: "openai", errorMessage: AUTH_SEEN }),
      false,
    );
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "stop", provider: "seekai", errorMessage: AUTH_SEEN }),
      false,
    );
    assert.equal(shouldClarify({ role: "user", stopReason: "error", provider: "seekai", errorMessage: AUTH_SEEN }), false);
  });

  test("only a bad key or an empty balance asks for a persistent note", () => {
    assert.equal(needsPersistentHelp(AUTH_SEEN), true);
    assert.equal(needsPersistentHelp(BILLING), true);
    assert.equal(needsPersistentHelp(RATE_LIMIT_429), false);
    assert.equal(needsPersistentHelp(MODEL_NOT_FOUND_503), false);
    assert.equal(needsPersistentHelp(BAD_GATEWAY), false);
  });

  test("also recognizes the already-rewritten sentence (turn_end runs after message_end)", () => {
    assert.equal(needsPersistentHelp(clarifySeekaiError(AUTH_SEEN)!), true);
    assert.equal(needsPersistentHelp(clarifySeekaiError(BILLING)!), true);
    assert.equal(needsPersistentHelp(clarifySeekaiError(RATE_LIMIT_429)!), false);
  });
});

describe("inline <think> extraction", () => {
  test("splits a terminated block and trims the answer", () => {
    assert.deepEqual(splitInlineThinking("<think>pondering</think>\n\nok"), {
      text: "ok",
      thinking: "pondering",
    });
  });

  test("treats an unterminated <think> as reasoning to the end of the block", () => {
    // Measured on a glm-5.3-flash tool-call turn: content was `<think>…` with no
    // closing tag before the tool_call.
    const only = "<think>The user wants the weather. Sunny, 15°C.";
    assert.deepEqual(splitInlineThinking(only), { text: "", thinking: only.slice(7) });
  });

  test("handles multiple blocks and a trailing unterminated one", () => {
    assert.deepEqual(splitInlineThinking("<think>a</think>ok<think>b"), { text: "ok", thinking: "a\n\nb" });
  });

  test("leaves an ordinary answer byte-for-byte unchanged", () => {
    const answer = "  keep  my   spacing  ";
    assert.deepEqual(splitInlineThinking(answer), { text: answer, thinking: "" });
  });

  test("moves reasoning into thinking blocks and keeps tool calls in place", () => {
    const toolCall = { type: "toolCall", id: "t1", name: "get_weather", arguments: { city: "Paris" } } as const;
    const content = [{ type: "text", text: "<think>hmm</think>\n\nok" }, toolCall] as any;
    assert.deepEqual(extractInlineThinking(content), [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "ok" },
      toolCall,
    ]);
  });

  test("drops an unterminated thinking-only block to a thinking block with no answer", () => {
    const content = [{ type: "text", text: "<think>only thought" }] as any;
    assert.deepEqual(extractInlineThinking(content), [{ type: "thinking", thinking: "only thought" }]);
  });

  test("returns undefined when there is nothing to move (message not replaced)", () => {
    assert.equal(extractInlineThinking([{ type: "text", text: "plain answer" }] as any), undefined);
    assert.equal(extractInlineThinking([] as any), undefined);
  });
});
