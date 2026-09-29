/**
 * Fake-pi entry test: import the real extension default export with a stubbed
 * `ExtensionAPI` and assert the wiring, then drive the hooks with the message
 * shapes pi passes them. The preload aliases "@earendil-works/pi-ai" to the compat
 * entrypoint so `index.ts` imports.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import seekaiExtension from "../index.ts";

type Handler = (event: any, context?: any) => any;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; providers: any[] } {
  const handlers = new Map<string, Handler[]>();
  const providers: any[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerProvider: (provider: any) => {
      providers.push(provider);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers, providers };
}

function run(handlers: Map<string, Handler[]>, event: string, payload: any, context?: any): any {
  const list = handlers.get(event) ?? [];
  let result: any;
  for (const handler of list) result = handler(payload, context);
  return result;
}

function assistantMessage(overrides: Record<string, any> = {}) {
  return {
    role: "assistant",
    provider: "seekai",
    stopReason: "stop",
    content: [],
    ...overrides,
  };
}

describe("extension wiring", () => {
  test("registers the seekai provider and both hooks", () => {
    const { pi, handlers, providers } = fakePi();
    seekaiExtension(pi);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "seekai");
    assert.equal(providers[0].name, "seekai.cc");
    assert.deepEqual([...handlers.keys()].sort(), ["message_end", "turn_end"]);
  });
});

describe("message_end", () => {
  test("rewrites a pre-billing 403 into a readable sentence", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage: "403 预扣费额度失败, 用户剩余额度: ＄12.345678, 需要预扣费额度: ＄1500.000016",
      }),
    });
    assert.match(result.message.errorMessage, /^seekai: /);
    assert.match(result.message.errorMessage, /billing/);
  });

  test("rewrites a 401 invalid token", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({ stopReason: "error", errorMessage: "401 Invalid token" }),
    });
    assert.match(result.message.errorMessage, /SEEKAI_API_KEY/);
  });

  test("leaves other providers and non-error messages untouched", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({ provider: "openai", stopReason: "error", errorMessage: "401 Invalid token" }),
      }),
      undefined,
    );
    assert.equal(
      run(handlers, "message_end", { message: { role: "user", content: "hi" } }),
      undefined,
    );
  });

  test("moves an inline <think> block out of content into a thinking block", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({ content: [{ type: "text", text: "<think>reasoning</think>\n\nok" }] }),
    });
    assert.deepEqual(result.message.content, [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "ok" },
    ]);
  });

  test("a clean message is left exactly as-is (no needless replacement)", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    assert.equal(
      run(handlers, "message_end", { message: assistantMessage({ content: [{ type: "text", text: "ok" }] }) }),
      undefined,
    );
  });

  test("handles a tool-call turn whose <think> block was never closed", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "toolUse",
        content: [
          { type: "text", text: "<think>the user wants the weather" },
          { type: "toolCall", id: "t1", name: "get_weather", arguments: { city: "Paris" } },
        ],
      }),
    });
    assert.deepEqual(result.message.content, [
      { type: "thinking", thinking: "the user wants the weather" },
      { type: "toolCall", id: "t1", name: "get_weather", arguments: { city: "Paris" } },
    ]);
  });
});

describe("turn_end", () => {
  const authMessage = assistantMessage({ stopReason: "error", errorMessage: "401 Invalid token" });

  test("appends a deduped, persistent note in the TUI for a bad key", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    const result = run(handlers, "turn_end", { outcome: "error", message: authMessage, entries: [] }, { hasUI: true });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].customType, "seekai-help");
    assert.equal(result.entries[0].display, true);

    const deduped = run(
      handlers,
      "turn_end",
      { outcome: "error", message: authMessage, entries: [{ customType: "seekai-help" }] },
      { hasUI: true },
    );
    assert.equal(deduped, undefined);
  });

  test("stays silent in print mode so `pi -p` still prints the error", () => {
    // An entry appended after the errored assistant message makes `pi -p` print
    // nothing at all, which is why index.ts gates the note on `ctx.hasUI`.
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    assert.equal(
      run(handlers, "turn_end", { outcome: "error", message: authMessage, entries: [] }, { hasUI: false }),
      undefined,
    );
  });

  test("stays silent for a rate limit (transient, no human action)", () => {
    const { pi, handlers } = fakePi();
    seekaiExtension(pi);
    assert.equal(
      run(
        handlers,
        "turn_end",
        { outcome: "error", message: assistantMessage({ stopReason: "error", errorMessage: "429 rate limit" }), entries: [] },
        { hasUI: true },
      ),
      undefined,
    );
  });
});
