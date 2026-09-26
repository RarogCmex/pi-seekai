/**
 * Curated catalog for the seekai.cc gateway (https://seekai.cc/v1).
 *
 * Engine: `new-api` (a one-api fork). Provenance — everything below was measured
 * against the live gateway on 2026-09-26 with the key in `secret.env`; raw probe
 * transcripts live in `research/`. The recon handoff
 * (`research/2026-09-26-recon-handoff.md`) is the starting point; where this file
 * and the handoff disagree, the newer measurement in `research/` wins.
 *
 * Two things are deliberately NOT here, because this gateway refuses to disclose
 * them for free:
 *
 *  - Per-model prices. `seekai.cc` publishes no price list, and the gateway
 *    prices nothing in its responses. Its 403 pre-billing refusal leaks only the
 *    *account balance* (a debug aid, not a price source). By house rule every
 *    `cost` is therefore zero with a `priceNote` — never a guess.
 *  - Context windows and output caps. `max_tokens: 99999999` is **accepted**
 *    (HTTP 200, billed) rather than rejected, so no rejection discloses the cap,
 *    and bracketing it with accepted requests would buy the answer. Every window
 *    below is a conservative, clearly-unverified floor.
 *
 * What IS measured per model is the liveness and reasoning shape (see the
 * comments on each entry): the gateway lists 11 ids, and name-based routing sends
 * several of them to a completely different upstream than their name suggests.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** The gateway speaks OpenAI chat-completions (`supported_endpoint_types:["openai"]`). */
export type GatewayApi = "openai-completions";

/**
 * Where a model's reasoning lands on the wire (measured per model, see
 * `research/`). This decides whether pi can read it natively and whether the
 * extension must move an inline `<think>` block out of `content`:
 *
 *  - `inline-content`  reasoning is emitted **inside `content`** wrapped in
 *                      `<think>…</think>`, and may be **unterminated** when the
 *                      turn ends in a tool call or at `max_tokens`. pi-ai has no
 *                      handling for this (it only reads `reasoning_content` /
 *                      `reasoning` / `reasoning_text`), so `errors.ts`
 *                      `splitInlineThinking` extracts it. Measured: glm-5.3-flash,
 *                      deepseek-ai/DeepSeek-V4-Flash-0731.
 *  - `reasoning-field` reasoning is returned in a sibling `reasoning_content`
 *                      field, which pi-ai parses natively. Measured: hy3,
 *                      deepseek-v4.1-flash.
 *  - `unknown`         not measured (the id was listed but did not answer, or its
 *                      answer body was not captured).
 */
export type ReasoningMode = "inline-content" | "reasoning-field" | "unknown";

export interface ThinkingControl {
  /** How reasoning reaches the wire (measured; see `ReasoningMode`). */
  mode: ReasoningMode;
  /** pi thinking-level map. `off: null` hides the off-switch (see models.ts). */
  levels: ThinkingLevelMap;
}

export interface CatalogEntry {
  /** Exact gateway model id — case-sensitive. */
  id: string;
  name: string;
  /**
   * UNVERIFIED conservative floor (32K). The gateway never disclosed a window in
   * a free rejection, so a small value is used deliberately: pi compacts *before*
   * an over-context request instead of sending one that would be billed.
   */
  contextWindow: number;
  /**
   * UNVERIFIED conservative `max_tokens` (4K). pi sends `max_tokens = maxTokens`,
   * and for a forced inline thinker reasoning and the answer share that budget —
   * a tiny value silently yields no answer (measured: `max_tokens: 8` on
   * glm-5.3-flash returned thinking only). 4K leaves ample room.
   */
  maxTokens: number;
  /** pi input modalities. Only `text` is verified; vision is unprobed. */
  input: ("text" | "image")[];
  /** Whether the model reasons. True for every listed id (all are reasoner families; see README). */
  reasoning: boolean;
  thinking: ThinkingControl;
  /** Human-readable caveat; pi's `Model` has no notes field. */
  priceNote: string;
}

/**
 * The pi level map shared by every seekai model.
 *
 * `off: null` **hides** the off-switch: pi drops an all-null *level* from the
 * picker and up-clamps a request for it (`pi-ai/dist/models.js`). This is
 * deliberate and grounded:
 *
 *  - glm-5.3-flash and deepseek-ai/DeepSeek-V4-Flash-0731 are **forced
 *    thinkers**: `enable_thinking:false` is ignored and `reasoning_effort:"none"`
 *    is accepted but still thinks (both probed 2026-09-26). There is no request
 *    that turns them off.
 *  - No model on this gateway has a *measured* disable, and leaving `off`
 *    selectable would let pi send a request that silently keeps thinking on —
 *    billing the user for the reasoning they turned off. Hiding it is the honest
 *    state.
 *
 * The effort tokens are the ones the gateway accepted in probes (`low`, `high`;
 * `medium` also accepted). `minimal`/`xhigh`/`max` are folded onto the nearest of
 * those so no pi-internal level name leaks to the wire (the gateway tolerates
 * unknown values — that was probed — but normalizing is house convention).
 */
export const SEEKAI_THINKING: ThinkingLevelMap = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const UNVERIFIED_CONTEXT_WINDOW = 32_768;
const UNVERIFIED_MAX_TOKENS = 4_096;

/** pi cannot express "priced, unknown"; every seekai entry is zero-cost with this note. */
const PRICE_NOTE =
  "seekai.cc publishes no price list and reports no per-token cost; window and cap are unverified conservative floors";

interface EntrySpec {
  id: string;
  name: string;
  mode: ReasoningMode;
  reasoning?: boolean;
}

const SPECS: readonly EntrySpec[] = [
  // --- measured working, reasoning inline in content -------------------------
  // 200, content = "<think>…</think>\n\n<answer>". Routed by name to a vLLM
  // backend (`model: "MiniMaxAI/MiniMax-M2.7"` in the response, probed).
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", mode: "inline-content" },
  // 200, same inline-<think> shape as glm-5.3-flash.
  { id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash (0731)", mode: "inline-content" },

  // --- measured working, reasoning in a sibling field ------------------------
  // 200, content:"ok", reasoning_content present, usage.reasoning_tokens > 0.
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", mode: "reasoning-field" },
  { id: "hy3", name: "HY3", mode: "reasoning-field" },
  // 200 with usage.reasoning_tokens > 0; body not captured (a retry hit the
  // gateway concurrency limit), so the field is unconfirmed.
  { id: "hy4-preview-f", name: "HY4 Preview Fast", mode: "unknown" },

  // --- listed but not answering on 2026-09-26 (see README § Surfaces) --------
  // These four answer HTTP 200 with a Minimax in-band error and choices:null
  // ("Token Plan usage limit reached"); the id is a name-alias onto a MiniMax
  // upstream account that is out of quota. Kept in the catalog because the
  // failure is an account/quota state, not a model capability.
  { id: "claude-sonnet", name: "Claude Sonnet", mode: "unknown" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", mode: "unknown" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (2025-05-14)", mode: "unknown" },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", mode: "unknown" },
  // HTTP 502 + an HTML "Bad gateway" page from the fronting proxy.
  { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code", mode: "unknown" },
  // HTTP 404 model_not_found: `"自部署/Qwen3.8-27B" is not supported by any
  // configured account in this group`.
  { id: "Qwen3.8-27B", name: "Qwen3.8 27B", mode: "unknown" },
];

export const CATALOG: readonly CatalogEntry[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  contextWindow: UNVERIFIED_CONTEXT_WINDOW,
  maxTokens: UNVERIFIED_MAX_TOKENS,
  input: ["text"],
  reasoning: spec.reasoning ?? true,
  thinking: { mode: spec.mode, levels: SEEKAI_THINKING },
  priceNote: PRICE_NOTE,
}));

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);
