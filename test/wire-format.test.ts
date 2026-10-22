/**
 * Wire-format tests.
 *
 * These drive pi's real `openai-completions` adapter — the same
 * `openAICompletionsApi()` `index.ts` registers, wrapped in the same
 * `withBodyRecoveryApi` production uses — and capture the request body through
 * `onPayload`, plus what the adapter makes of a recorded response body. Nothing
 * touches the network: `fetch` is a stub that records the URL and throws, or
 * answers with a canned body.
 *
 * This is the test that matters most, because every compat flag in `models.ts`
 * exists to change these bytes and a wrong guess fails only at runtime against a
 * paid, rate-limited API.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  AssistantMessage,
  Context,
  Model,
  ProviderStreams,
  ThinkingLevel,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError, normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { clarifySeekaiError, withBodyRecoveryApi } from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";

const api = withBodyRecoveryApi(openAICompletionsApi());

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  assert.ok(entry, `${id} missing from catalog`);
  return entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    ...overrides,
  });
}

let requestedUrl: string | undefined;

afterEach(() => {
  requestedUrl = undefined;
});

/** Run a stream to its (expected) failure and return the body it would have sent. */
async function capture(
  target: Model<"openai-completions">,
  options: { reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[] } = {},
): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;

  const stream = api.streamSimple(target, context({ tools: options.tools }), {
    apiKey: "sk_test",
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 2048,
    onPayload: (body) => {
      payload = body as Record<string, any>;
    },
    fetch: ((url: any) => {
      requestedUrl = String(url);
      throw new Error("stop after payload capture");
    }) as unknown as typeof fetch,
  });

  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }

  assert.ok(payload, "adapter never built a request payload");
  // pi assigns several fields the literal `undefined`, so `key in body` would lie.
  return JSON.parse(JSON.stringify(payload));
}

describe("request shape common to every seekai model", () => {
  test("posts to the /v1 chat completions endpoint", async () => {
    await capture(model("glm-5.3-flash"));
    assert.equal(requestedUrl, "https://seekai.cc/v1/chat/completions");
  });

  test("uses max_tokens, not max_completion_tokens", async () => {
    const body = await capture(model("deepseek-v4.1-flash"), { maxTokens: 4096 });
    assert.equal(body.max_tokens, 4096);
    assert.equal("max_completion_tokens" in body, false);
  });

  test("never sends fields the gateway does not document", async () => {
    const body = await capture(model("glm-5.3-flash"), { tools: [weatherTool] });
    for (const field of ["store", "prompt_cache_retention", "prompt_cache_key", "priority"]) {
      assert.equal(field in body, false, `${field} should not be sent`);
    }
  });

  test("asks for streaming usage so token accounting works", async () => {
    const body = await capture(model("glm-5.3-flash"));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("uses the system role, not developer", async () => {
    const body = await capture(model("glm-5.3-flash"));
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are pi, a coding agent.");
    assert.equal(body.messages.some((m: any) => m.role === "developer"), false);
  });

  test("sends plain function tools without the strict flag", async () => {
    const body = await capture(model("glm-5.3-flash"), { tools: [weatherTool] });
    assert.equal(body.tools.length, 1);
    const fn = body.tools[0].function;
    assert.equal(fn.name, "get_weather");
    assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
    assert.equal("strict" in fn, false);
  });
});

describe("what the host composes from the gateway's failure bodies", () => {
  /**
   * The bodies are the recorded gateway ones (2026-09-26 / 2026-10-11); the
   * expected strings were measured offline on pi-ai 1.4.0 (openai SDK 7.19.0) by
   * driving the real adapter with a stubbed `fetch`. They are asserted rather than
   * assumed because they moved once already: pi-ai 0.87.1 (openai SDK 6) dropped a
   * body the SDK could not fold into its message, so a bare `{code,message}` 401
   * arrived as `401 status code (no body)`.
   */
  const HTML_PAGE = "<!DOCTYPE html>\n<html><head><title>seekai.cc | 502: Bad gateway</title></head></html>";
  const CASES: [string, number, string, string, string, string][] = [
    // [name, status, body, content-type, raw adapter message, recovered message]
    [
      "enveloped 401",
      401,
      '{"error":{"code":"","message":"Invalid token","type":"new_api_error"}}',
      "application/json",
      '401: {"code":"","message":"Invalid token","type":"new_api_error"}',
      "401 Invalid token",
    ],
    [
      "bare 401 (no error key)",
      401,
      '{"code":"","message":"Invalid token"}',
      "application/json",
      '401: {"code":"","message":"Invalid token"}',
      "401 Invalid token",
    ],
    ["proxy HTML 502", 502, HTML_PAGE, "text/html", `502 ${HTML_PAGE}`, "502 <!DOCTYPE html>"],
    // Nothing to recover: the wrapper must leave a bodiless failure alone.
    ["bodiless 500", 500, "", "application/json", "500 status code (no body)", "500 status code (no body)"],
  ];

  /** Drive the real adapter against a canned response and return its final message. */
  async function compose(
    streams: ProviderStreams,
    target: Model<"openai-completions">,
    response: { status: number; body: string; contentType: string },
  ): Promise<AssistantMessage> {
    const stream = streams.streamSimple(target, context(), {
      apiKey: "sk_test",
      maxTokens: 64,
      fetch: (async () =>
        new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.contentType },
        })) as unknown as typeof fetch,
    });

    let final: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "error") final = (event as { error: AssistantMessage }).error;
      else if (event.type === "done") final = (event as { message: AssistantMessage }).message;
    }
    assert.ok(final, "adapter produced no final message");
    return final;
  }

  const rawApi = openAICompletionsApi();

  test("the body recovery is what turns a blob into a sentence", async () => {
    const target = model("glm-5.3-flash");
    for (const [name, status, body, contentType, expectedRaw, expectedRecovered] of CASES) {
      const response = { status, body, contentType };
      const raw = await compose(rawApi, target, response);
      assert.equal(raw.errorMessage, expectedRaw, `${name}: raw adapter`);
      const recovered = await compose(api, target, response);
      assert.equal(recovered.errorMessage, expectedRecovered, `${name}: with recovery`);
    }
  });

  test("a failure carried inside HTTP 200 reaches the user only through the recovery", async () => {
    // Recorded live 2026-10-11 on `claude-sonnet-4-20250514` (the same fixture
    // `test/errors.test.ts` replays): HTTP 200 whose body carries the upstream's
    // quota error instead of a completion.
    const reason = "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量";
    const body =
      '{"_provider":"Minimax","base_resp":{"status_code":2056,"status_msg":"' +
      reason +
      '"},"choices":null,"object":"chat.completion","model":"MiniMax-M2.7",' +
      '"usage":{"prompt_tokens":74,"completion_tokens":0}}';
    const target = model("claude-sonnet-4-20250514");
    const response = { status: 200, body, contentType: "application/json" };

    // Without the recovery the reason is lost: the adapter guards `choices`, finds
    // no chunk and reports a bare `Stream ended without finish_reason` — which also
    // matches pi's retryable `ended without` pattern, so pi would re-send a
    // deterministic quota failure into the gateway's 5/min budget.
    const raw = await compose(rawApi, target, response);
    assert.equal(raw.stopReason, "error");
    assert.equal(raw.errorMessage?.includes(reason), false, "the reason must be lost");
    assert.equal(isRetryableAssistantError(raw), true);

    // With it, the 200 is demoted to a plain-text 400: the reason survives to
    // `message_end`, and the rewrite that owns this shape is non-retryable.
    const recovered = await compose(api, target, response);
    assert.equal(recovered.stopReason, "error");
    assert.equal(recovered.errorMessage, `400 ${reason}`);
    assert.equal(isRetryableAssistantError(recovered), false);
    const clarified = clarifySeekaiError(recovered.errorMessage!);
    assert.match(clarified ?? "", /^seekai: /, "the recovered message must reach the rewrite");
    assert.equal(
      isRetryableAssistantError({ ...recovered, errorMessage: clarified! }),
      false,
      "the rewrite must not make the quota-out retryable",
    );
  });
});

describe("reasoning_effort: the gateway's effort switch", () => {
  const expected: Record<ThinkingLevel, string> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };

  test("omitting reasoning (pi's off) sends no reasoning_effort at all", async () => {
    const body = await capture(model("glm-5.3-flash"));
    assert.equal("reasoning_effort" in body, false);
  });

  test("maps every level onto a gateway-accepted value across the whole catalog", async () => {
    const legal = new Set(["low", "medium", "high"]);
    for (const id of CATALOG_BY_ID.keys()) {
      for (const [level, value] of Object.entries(expected)) {
        const body = await capture(model(id), { reasoning: level as ThinkingLevel });
        assert.equal(body.reasoning_effort, value, `${id} at ${level}`);
        assert.ok(legal.has(body.reasoning_effort), `${id} at ${level} sent ${body.reasoning_effort}`);
      }
    }
  });

  test("never leaks a pi-internal level name to the wire", async () => {
    for (const level of Object.keys(expected) as ThinkingLevel[]) {
      const body = await capture(model("glm-5.3-flash"), { reasoning: level });
      for (const internal of ["minimal", "xhigh", "max", "off"]) {
        assert.notEqual(body.reasoning_effort, internal);
      }
    }
  });
});
