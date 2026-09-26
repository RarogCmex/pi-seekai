import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { AuthContext, ProviderAuthInteraction, ProviderStreams } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID } from "../models.ts";
import {
  API_KEY_AUTH_NAME,
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  buildSeekaiProvider,
  resolveBaseUrl,
  seekaiApiKeyAuth,
} from "../provider.ts";

const unused: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

function authContext(env: Record<string, string>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(entered: string): ProviderAuthInteraction & {
  notifications: { message: string; links?: readonly { url: string; label?: string }[] }[];
} {
  const notifications: { message: string; links?: readonly { url: string; label?: string }[] }[] = [];
  return {
    signal: new AbortController().signal,
    notifications,
    notify: (event) => {
      if (event.type === "info") notifications.push({ message: event.message, links: event.links });
    },
    prompt: async () => entered,
  };
}

describe("resolveBaseUrl", () => {
  const realEnv = process.env[BASE_URL_ENV_VAR];
  afterEach(() => {
    if (realEnv === undefined) delete process.env[BASE_URL_ENV_VAR];
    else process.env[BASE_URL_ENV_VAR] = realEnv;
  });

  test("defaults to the seekai.cc v1 endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://seekai.cc/v1");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(() => "  https://proxy.example.com/seekai/v1///  "),
      "https://proxy.example.com/seekai/v1",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });
});

describe("api key auth", () => {
  const auth = seekaiApiKeyAuth();

  test("is named for the /login list", () => {
    assert.equal(auth.name, API_KEY_AUTH_NAME);
  });

  test("login points at the site before prompting", async () => {
    const ui = interaction("sk-abc123");
    const credential = await auth.login!(ui);
    assert.deepEqual(credential, { type: "api_key", key: "sk-abc123" });
    assert.equal(ui.notifications.length, 1);
    assert.deepEqual(ui.notifications[0].links, [{ url: "https://seekai.cc", label: "seekai.cc" }]);
  });

  test("login trims whitespace from a pasted key", async () => {
    const credential = await auth.login!(interaction("  sk-abc123\n"));
    assert.equal(credential.key, "sk-abc123");
  });

  test("login refuses an empty key", async () => {
    await assert.rejects(() => auth.login!(interaction("   \n")), /No API key entered/);
  });

  test("login warns about an unexpected shape but still saves it", async () => {
    const ui = interaction("some-other-format");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "some-other-format");
    assert.equal(ui.notifications.length, 2);
    assert.match(ui.notifications[1].message, /does not look like a seekai\.cc key/);
  });

  test("resolve prefers the stored credential and trims it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "sk_from_env" }),
      credential: { type: "api_key", key: "  sk_stored \n" },
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk_stored");
  });

  test("resolve falls back to the environment variable and names it", async () => {
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "  sk_from_env\n" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "sk_from_env");
    assert.equal(result?.source, API_KEY_ENV_VAR);
  });

  test("resolve reports unconfigured when neither source has a key", async () => {
    assert.equal(
      await auth.resolve({ ctx: authContext({}), signal: new AbortController().signal }),
      undefined,
    );
    assert.equal(
      await auth.resolve({
        ctx: authContext({}),
        credential: { type: "api_key", key: "   " },
        signal: new AbortController().signal,
      }),
      undefined,
    );
  });
});

describe("buildSeekaiProvider", () => {
  test("registers under the expected identity with api-key auth", () => {
    const provider = buildSeekaiProvider(unused);
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "seekai.cc");
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
    assert.ok(provider.auth.apiKey, "api-key auth must be present");
    assert.equal(provider.auth.oauth, undefined);
    assert.equal(typeof provider.auth.apiKey!.login, "function");
    assert.equal(typeof provider.auth.apiKey!.resolve, "function");
  });

  test("serves the curated 11-model catalog synchronously, on completions only", () => {
    const provider = buildSeekaiProvider(unused);
    const models = provider.getModels();
    assert.equal(models.length, 11);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
    }
  });

  test("opts into dynamic refresh so new ids appear", () => {
    assert.equal(typeof buildSeekaiProvider(unused).refreshModels, "function");
  });

  test("propagates a custom base url to every model", () => {
    const provider = buildSeekaiProvider(unused, "https://proxy.example.com/seekai/v1");
    assert.equal(provider.baseUrl, "https://proxy.example.com/seekai/v1");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://proxy.example.com/seekai/v1");
    }
  });

  test("sends chat models through the injected completions adapter", () => {
    let calls = 0;
    const counting: ProviderStreams = {
      stream: () => {
        calls++;
        throw new Error("completions");
      },
      streamSimple: unused.streamSimple,
    };
    const provider = buildSeekaiProvider(counting);
    const model = provider.getModels()[0];
    assert.equal(model.api, "openai-completions");
    assert.throws(() => provider.stream(model, normalizeContext({ messages: [] })), /completions/);
    assert.equal(calls, 1);
  });

  test("the curated catalog keeps the measured reasoning modes", () => {
    const provider = buildSeekaiProvider(unused);
    const glm = provider.getModels().find((m) => m.id === "glm-5.3-flash");
    assert.ok(glm);
    assert.equal(CATALOG_BY_ID.get("glm-5.3-flash")!.thinking.mode, "inline-content");
  });
});
