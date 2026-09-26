/**
 * Catalog → pi `Model` conversion, plus the compat flags for the seekai.cc
 * gateway.
 *
 * `seekai.cc` matches none of pi-ai's URL auto-detection branches, so the
 * auto-detected profile is a vanilla OpenAI one that is wrong in several places.
 * Every flag below is set explicitly; the grounded ones cite the probe in
 * `research/` or the 2026-09-26 recon handoff.
 *
 * Prices are zero on purpose: the gateway publishes none (see `catalog.ts`).
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { CATALOG, SEEKAI_THINKING, type CatalogEntry, type GatewayApi } from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "seekai";
export const DEFAULT_BASE_URL = "https://seekai.cc/v1";

/**
 * Compatibility flags for the new-api completions surface.
 *
 *  - maxTokensField: `max_tokens`. Grounded: every probe sent `max_tokens` and the
 *    gateway enforced it (`max_tokens: 8` truncated the answer with
 *    `finish_reason:"length"`). `max_completion_tokens` was not probed; the
 *    auto-detected default for an unknown host is not `max_tokens`, so pin it.
 *  - thinkingFormat: `openai` → a top-level `reasoning_effort` string. Grounded:
 *    the gateway accepted `low`/`medium`/`high`/`none` and honored `low` on
 *    `deepseek-v4.1-flash` (reasoning_tokens rose), while glm-5.3-flash ignored
 *    it (forced thinker).
 *  - supportsReasoningEffort: true, so pi *states* an effort instead of inheriting
 *    the backend default.
 *  - supportsUsageInStreaming / supportsFinishReason: grounded — the SSE stream
 *    ends with `finish_reason:"stop"` and a final `choices:[]` chunk carrying
 *    `usage` when `stream_options.include_usage` is set (probed).
 *  - supportsDeveloperRole: false — conservative. The gateway was not proven to
 *    accept `role:"developer"`; `system` is universally accepted, so pi sends that.
 *  - supportsStore / supportsLongCacheRetention: false — neither `store` nor
 *    `prompt_cache_retention`/`prompt_cache_key` is documented, so do not send them.
 *  - supportsStrictMode: false — strict JSON-schema tools are not documented
 *    (pi 0.87 already defaults this false for unknown OpenAI-compatible hosts).
 *  - requiresThinkingAsText / requiresToolResultName / requiresAssistantAfterToolResult:
 *    false — the gateway forwards standard OpenAI tool-call shapes (probed: a
 *    function tool round-trips to `finish_reason:"tool_calls"`).
 */
export const CHAT_COMPAT: OpenAICompletionsCompat = {
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
  supportsReasoningEffort: true,
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsLongCacheRetention: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsOpenAIGrammarTools: false,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type SeekaiModel = Model<GatewayApi>;

export function entryToModel(entry: CatalogEntry, baseUrl: string): SeekaiModel {
  const model = {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: entry.reasoning,
    thinkingLevelMap: entry.thinking.levels,
    input: entry.input,
    cost: { ...ZERO_COST },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...CHAT_COMPAT },
  } satisfies Model<"openai-completions">;
  return model;
}

export function buildModels(baseUrl: string): SeekaiModel[] {
  return CATALOG.map((entry) => entryToModel(entry, baseUrl));
}

/**
 * Conservative shape for an id this build has never seen (e.g. a future id
 * surfaced by `GET /v1/models`). Cost stays zero so pi reports $0.00, and the
 * window is small enough that compaction fires early. This gateway routes by
 * name, so an unknown id's real capabilities are unknowable without probing.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxTokens: 4_096,
} as const;

export function unknownModelToModel(id: string, baseUrl: string): SeekaiModel {
  const entry: CatalogEntry = {
    id,
    name: id,
    contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow,
    maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens,
    input: ["text"],
    reasoning: true,
    thinking: { mode: "unknown", levels: SEEKAI_THINKING },
    priceNote: "unknown seekai.cc id discovered live; no price or limits are known",
  };
  return entryToModel(entry, baseUrl);
}
