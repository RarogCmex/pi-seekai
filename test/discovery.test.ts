import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { buildOverlay, fetchSeekaiModels, parseModelIds, resolveDiscoveryKey } from "../discovery.ts";
import { DEFAULT_BASE_URL } from "../models.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

/** The exact `GET /v1/models` body shape (live 2026-09-26). */
const LIVE_IDS = [
  "claude-sonnet",
  "claude-sonnet-4-6",
  "doubao-seed-2.0-code",
  "claude-sonnet-4-20250514",
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "deepseek-ai/DeepSeek-V4-Flash-0731",
  "hy4-preview-f",
  "MiniMax-M2.7-highspeed",
  "Qwen3.8-27B",
  "hy3",
];
const payload = (...ids: string[]) => ({
  data: ids.map((id) => ({ id, object: "model", created: 1626777600, owned_by: "openai" })),
  object: "list",
  success: true,
});

describe("parseModelIds", () => {
  test("reads the live 11-id listing", () => {
    assert.deepEqual(parseModelIds(payload(...LIVE_IDS)).sort(), [...LIVE_IDS].sort());
  });

  test("dedupes and trims", () => {
    assert.deepEqual(parseModelIds(payload("hy3", " hy3 ", "hy3")), ["hy3"]);
  });

  test("survives malformed payloads", () => {
    assert.deepEqual(parseModelIds(null), []);
    assert.deepEqual(parseModelIds({}), []);
    assert.deepEqual(parseModelIds({ data: "nope" }), []);
    assert.deepEqual(parseModelIds({ data: [null, 1, {}, { id: "" }] }), []);
  });
});

describe("buildOverlay", () => {
  test("keeps known ids out so curated data wins", () => {
    assert.deepEqual(buildOverlay(LIVE_IDS, DEFAULT_BASE_URL), []);
  });

  test("adds unknown ids with conservative limits and zero cost", () => {
    const overlay = buildOverlay(["brand-new-model"], DEFAULT_BASE_URL);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].id, "brand-new-model");
    assert.equal(overlay[0].contextWindow, 32_768);
    assert.deepEqual(overlay[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(CATALOG_BY_ID.has("brand-new-model"), false);
  });
});

describe("resolveDiscoveryKey", () => {
  test("prefers the refresh credential and trims it", () => {
    const key = resolveDiscoveryKey(
      makeContext({ credential: { type: "api_key", key: "  sk_cred \n" } as any }),
      () => "sk_env",
    );
    assert.equal(key, "sk_cred");
  });

  test("falls back to the environment variable", () => {
    assert.equal(resolveDiscoveryKey(makeContext(), () => "  sk_env  "), "sk_env");
  });

  test("reports no key when neither source has one", () => {
    assert.equal(resolveDiscoveryKey(makeContext(), () => undefined), undefined);
    assert.equal(
      resolveDiscoveryKey(makeContext({ credential: { type: "api_key", key: "  " } as any }), () => ""),
      undefined,
    );
  });
});

describe("fetchSeekaiModels", () => {
  function stubFetch(status: number, body: unknown, capture?: { url?: string; auth?: string }): typeof fetch {
    return (async (url: any, init: any) => {
      if (capture) {
        capture.url = String(url);
        capture.auth = init?.headers?.Authorization;
      }
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  test("sends the key and returns an overlay from the live listing", async () => {
    const capture: { url?: string; auth?: string } = {};
    globalThis.fetch = stubFetch(200, payload(...LIVE_IDS, "seekai-future-1"), capture);
    const models = await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext({ credential: { type: "api_key", key: "sk_x" } as any }));
    assert.deepEqual(models.map((m) => m.id), ["seekai-future-1"]);
    assert.equal(capture.url, "https://seekai.cc/v1/models");
    assert.equal(capture.auth, "Bearer sk_x");
  });

  test("never throws — a failed listing degrades to the curated baseline", async () => {
    globalThis.fetch = stubFetch(401, { code: "", message: "Invalid token" });
    assert.deepEqual(await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext({ credential: { type: "api_key", key: "sk_x" } as any })), []);

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext({ credential: { type: "api_key", key: "sk_x" } as any })), []);
  });

  test("is inert without a key, without network, or when aborted", async () => {
    globalThis.fetch = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext()), []);
    assert.deepEqual(
      await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext({ allowNetwork: false, credential: { type: "api_key", key: "sk_x" } as any })),
      [],
    );
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(
      await fetchSeekaiModels(DEFAULT_BASE_URL, makeContext({ signal: aborted.signal, credential: { type: "api_key", key: "sk_x" } as any })),
      [],
    );
  });
});
