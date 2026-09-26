import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID, SEEKAI_THINKING } from "../catalog.ts";

/** The 11 ids `GET /v1/models` returned live on 2026-09-26. */
const LIVE_IDS = [
  "claude-sonnet",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "doubao-seed-2.0-code",
  "deepseek-v4.1-flash",
  "deepseek-ai/DeepSeek-V4-Flash-0731",
  "glm-5.3-flash",
  "hy3",
  "hy4-preview-f",
  "MiniMax-M2.7-highspeed",
  "Qwen3.8-27B",
];

describe("catalog invariants", () => {
  test("has exactly the 11 live ids and no duplicates", () => {
    assert.equal(CATALOG.length, 11);
    assert.equal(CATALOG_BY_ID.size, CATALOG.length, "duplicate model id in catalog");
    assert.deepEqual([...CATALOG_BY_ID.keys()].sort(), [...LIVE_IDS].sort());
  });

  test("ids are the live /v1 ids, never guessed", () => {
    for (const entry of CATALOG) {
      assert.ok(LIVE_IDS.includes(entry.id), `${entry.id} is not a measured /v1 id`);
    }
  });

  test("keeps the slashed upstream id verbatim (pi splits provider on the first slash)", () => {
    const entry = CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.ok(entry);
    assert.equal(entry.id.includes("/"), true);
  });

  test("windows and output caps are positive, ordered and conservative", () => {
    for (const entry of CATALOG) {
      assert.ok(entry.contextWindow > 0, `${entry.id} contextWindow`);
      assert.ok(entry.maxTokens > 0, `${entry.id} maxTokens`);
      assert.ok(
        entry.maxTokens <= entry.contextWindow,
        `${entry.id} maxTokens ${entry.maxTokens} exceeds contextWindow ${entry.contextWindow}`,
      );
      // Unverified floors: deliberately small so pi compacts before an
      // over-context request that the gateway would bill.
      assert.ok(entry.contextWindow <= 32_768, `${entry.id} window not conservative`);
      assert.ok(entry.maxTokens <= 16_384, `${entry.id} output cap not conservative`);
      assert.ok(entry.name.length > 0, `${entry.id} has no display name`);
      assert.ok(entry.input.includes("text"), `${entry.id} must accept text`);
      assert.ok(entry.reasoning, `${entry.id} should be a reasoner`);
    }
  });

  test("every price is zero with a priceNote — the gateway publishes no prices", () => {
    for (const entry of CATALOG) {
      assert.equal(typeof entry.priceNote, "string");
      assert.ok(entry.priceNote.length > 0, `${entry.id} missing priceNote`);
      assert.match(entry.priceNote, /no price|unverified/i);
    }
  });

  test("records the measured reasoning shape per model", () => {
    // Measured 2026-09-26: inline <think> in content vs a sibling reasoning_content.
    assert.equal(CATALOG_BY_ID.get("glm-5.3-flash")!.thinking.mode, "inline-content");
    assert.equal(CATALOG_BY_ID.get("deepseek-ai/DeepSeek-V4-Flash-0731")!.thinking.mode, "inline-content");
    assert.equal(CATALOG_BY_ID.get("deepseek-v4.1-flash")!.thinking.mode, "reasoning-field");
    assert.equal(CATALOG_BY_ID.get("hy3")!.thinking.mode, "reasoning-field");
    // Listed but not answering on the probe date → shape unknown.
    for (const id of ["claude-sonnet", "doubao-seed-2.0-code", "Qwen3.8-27B", "hy4-preview-f"]) {
      assert.equal(CATALOG_BY_ID.get(id)!.thinking.mode, "unknown", id);
    }
  });

  test("shares one level map, and it hides the off-switch", () => {
    for (const entry of CATALOG) {
      assert.equal(entry.thinking.levels, SEEKAI_THINKING);
    }
    // `off: null` hides the level; pi then up-clamps a request for it (models.ts).
    assert.equal(SEEKAI_THINKING.off, null);
  });

  test("the shared map only ever emits gateway-accepted effort strings", () => {
    const legal = new Set(["low", "medium", "high"]);
    for (const [level, value] of Object.entries(SEEKAI_THINKING)) {
      if (value === null) continue;
      assert.ok(legal.has(value as string), `level ${level} maps to unmeasured effort ${value}`);
    }
  });
});
