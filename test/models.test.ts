import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID, SEEKAI_THINKING } from "../catalog.ts";
import {
  buildModels,
  CHAT_COMPAT,
  DEFAULT_BASE_URL,
  entryToModel,
  PROVIDER_ID,
  unknownModelToModel,
} from "../models.ts";

describe("catalog -> Model", () => {
  test("registers under the seekai provider on the completions surface", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
      assert.equal(model.reasoning, true);
    }
  });

  test("ids stay bare (pi prefixes the provider), including the slashed one", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.id, CATALOG_BY_ID.get(model.id)!.id);
    }
    assert.ok(buildModels(DEFAULT_BASE_URL).some((m) => m.id === "deepseek-ai/DeepSeek-V4-Flash-0731"));
  });

  test("every cost is zero — no price was invented", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  test("carries the request-shape compat flags the gateway needs", () => {
    const model = entryToModel(CATALOG_BY_ID.get("glm-5.3-flash")!, DEFAULT_BASE_URL);
    assert.equal(model.compat?.maxTokensField, "max_tokens");
    assert.equal(model.compat?.thinkingFormat, "openai");
    assert.equal(model.compat?.supportsReasoningEffort, true);
    assert.equal(model.compat?.supportsDeveloperRole, false);
    assert.equal(model.compat?.supportsStore, false);
    assert.equal(model.compat?.supportsLongCacheRetention, false);
    assert.equal(model.compat?.supportsStrictMode, false);
    assert.equal(model.compat?.supportsUsageInStreaming, true);
    assert.equal(model.compat?.supportsFinishReason, true);
    for (const entry of CATALOG) {
      assert.deepEqual(entryToModel(entry, DEFAULT_BASE_URL).compat, { ...CHAT_COMPAT });
    }
  });

  test("never declares promptCache (that would enable billed cache warming)", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.promptCache, undefined);
    }
  });
});

describe("thinking levels", () => {
  test("hides the off-switch and clamps a request for it up to minimal", () => {
    const model = entryToModel(CATALOG_BY_ID.get("glm-5.3-flash")!, DEFAULT_BASE_URL);
    const levels = getSupportedThinkingLevels(model);
    assert.equal(levels.includes("off"), false, "off must be hidden: no measured disable");
    assert.equal(clampThinkingLevel(model, "off" as ModelThinkingLevel), "minimal");
  });

  test("clamps a request for the hidden off-switch up to minimal", () => {
    const model = entryToModel(CATALOG_BY_ID.get("glm-5.3-flash")!, DEFAULT_BASE_URL);
    assert.equal(clampThinkingLevel(model, "off" as ModelThinkingLevel), "minimal");
  });

  test("keeps pi's levels selectable, each mapping to a gateway-accepted effort", () => {
    // xhigh/max are mapped to the string "high" (not null) on purpose: a null
    // entry would make the adapter fall back to the raw level name if an
    // unclamped level ever reached it (`map[level] ?? level`), and the gateway
    // tolerates but does not understand `xhigh`. Mapping to a string guarantees no
    // pi-internal name can leak.
    const model = entryToModel(CATALOG_BY_ID.get("glm-5.3-flash")!, DEFAULT_BASE_URL);
    assert.deepEqual(getSupportedThinkingLevels(model), ["minimal", "low", "medium", "high", "xhigh", "max"]);
    const legal = new Set(["low", "medium", "high"]);
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as ModelThinkingLevel[]) {
      const mapped = SEEKAI_THINKING[level];
      assert.equal(typeof mapped, "string", `${level} must map to a string`);
      assert.ok(legal.has(mapped as string), `${level} → ${mapped}`);
      // A supported level is not clamped away by pi.
      assert.equal(clampThinkingLevel(model, level), level);
    }
  });
});

describe("unknown ids from discovery", () => {
  test("get conservative limits, zero cost and the shared level map", () => {
    const model = unknownModelToModel("some-future-model", DEFAULT_BASE_URL);
    assert.equal(model.contextWindow, 32_768);
    assert.equal(model.maxTokens, 4_096);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.thinkingLevelMap, SEEKAI_THINKING);
    assert.equal(model.reasoning, true);
  });
});
