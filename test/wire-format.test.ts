/**
 * Wire-format tests.
 *
 * These drive pi's real `openai-completions` adapter — the same
 * `openAICompletionsApi()` `index.ts` registers, wrapped in the same
 * `withBodyRecoveryApi` production uses — and capture the request body through
 * `onPayload`. Nothing touches the network: `fetch` is a stub that records the URL
 * and throws.
 *
 * This is the test that matters most, because every compat flag in `models.ts`
 * exists to change these bytes and a wrong guess fails only at runtime against a
 * paid, rate-limited API.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Context, Model, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { withBodyRecoveryApi } from "../errors.ts";
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
