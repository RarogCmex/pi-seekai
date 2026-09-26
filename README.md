# pi-seekai

A pi provider plugin for the **seekai.cc** gateway (`https://seekai.cc/v1`) — an
`new-api` (one-api fork) aggregator that name-routes model ids onto assorted
upstreams. Registers the `seekai` provider with a curated 11-id catalog,
`/login` support, a live `/v1/models` overlay, and an error layer for new-api's
particular failure shapes.

Two facts dominate this gateway's design, and both were measured, not read:

1. **It lists 11 models and only 5 of them answer** — and one of those routes to a
   *different* vendor than its name (see the liveness matrix).
2. **Reasoning is delivered the wrong way.** `glm-5.3-flash` (and one DeepSeek id)
   are forced thinkers that emit reasoning **inline in `content`** wrapped in
   `<think>…</think>` — sometimes unterminated — which pi-ai cannot see. pi has no
   mechanism for inline think tags, so this plugin strips them out of the answer
   and into pi thinking blocks. That decision is the centrepiece of the plugin; the
   full rationale is in **§ The `<think>` decision**.

Everything a claim rests on was probed against the live gateway on **2026-09-26**
(pi 0.87.1, pi-ai 0.87.1) with the key in `secret.env`. Raw evidence:
`research/2026-09-26-live-verification.md` (+ gitignored `research/raw/`).

## Install / use

```
pi install /path/to/pi-seekai       # or: pi -e /path/to/pi-seekai/index.ts
/login seekai                        # or export SEEKAI_API_KEY=sk-...
pi --provider seekai --model seekai/deepseek-v4.1-flash -p "hello"
```

Environment:

| Variable | Meaning |
|---|---|
| `SEEKAI_API_KEY` | API key (`sk-…`). The stored credential from `/login` wins over it. |
| `SEEKAI_BASE_URL` | Endpoint override (default `https://seekai.cc/v1`), trailing slash stripped. |

## The catalog

`GET https://seekai.cc/v1/models` (authenticated; 401 without a key) returns 11
ids. The table below combines that listing with a live liveness probe
(`max_tokens: 8`, 2026-09-26):

| Model (pi id) | Window† | pi `max_tokens`† | Reasoning shape | Live 2026-09-26 |
|---|---|---|---|---|
| `glm-5.3-flash` | 32 K | 4 K | **inline `<think>` in `content`**, forced | 200 (routes to `MiniMaxAI/MiniMax-M2.7`) |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | 32 K | 4 K | **inline `<think>` in `content`**, forced | 200 |
| `deepseek-v4.1-flash` | 32 K | 4 K | `reasoning_content` field | 200 |
| `hy3` | 32 K | 4 K | `reasoning_content` field | 200 |
| `hy4-preview-f` | 32 K | 4 K | reasoner (`reasoning_tokens` > 0) | 200 (body not captured) |
| `claude-sonnet` | 32 K | 4 K | unknown | 200 with an in-band Minimax quota error |
| `claude-sonnet-4-6` | 32 K | 4 K | unknown | 200 with an in-band Minimax quota error |
| `claude-sonnet-4-20250514` | 32 K | 4 K | unknown | 200 with an in-band Minimax quota error |
| `MiniMax-M2.7-highspeed` | 32 K | 4 K | unknown | 200 with an in-band Minimax quota error |
| `doubao-seed-2.0-code` | 32 K | 4 K | unknown | 502 (HTML Bad gateway) |
| `Qwen3.8-27B` | 32 K | 4 K | unknown | 404 `model_not_found` |

† **Window and output cap are unverified conservative floors, and the whole table's
numbers are placeholders by necessity, not by laziness.** The gateway does *not*
reject a huge `max_tokens` (measured: `max_tokens: 99999999` → HTTP 200 and a normal
completion), so no free rejection discloses a cap, and the only way to "measure" one
would be to *buy* it by generating to the limit. Per the catalogue rule, that is not
done. The catalog therefore uses a small conservative floor (32 K / 4 K) so pi
compacts *before* an over-context request would be billed. § "What remains
unverified" says how to measure it properly.

**Every price is zero, with a `priceNote`.** seekai.cc publishes no price list and
returns no per-token cost; its 403 pre-billing text leaks only the *account balance*,
which is a debugging aid, not a price source. pi therefore reports `$0.00` rather
than a plausible-looking wrong number.

### Why all 11 ids, including the six dead ones

The four MiniMax-aliased ids, the 502-ing `doubao`, and the 404-ing `Qwen` are
still registered. The failures are an upstream **account/quota state** (Token Plan
exhausted), a transient proxy 502, and a routing-table gap — not a model
capability. Hiding them on a single day's observation would be failing *closed* on
a recoverable condition and would also be defeated by discovery (the overlay would
re-add any id the plugin omitted). They stay, and the table says exactly what they
did on the probe date.

## Design decisions

### Wire protocol

`openai-completions` only. Every listed id carries `supported_endpoint_types:
["openai"]` and the chat route is what all probes used. See § Surfaces for the two
other routes that exist and are deliberately not registered.

### Auth: which header goes on the wire

The key is resolved through pi's `envApiKeyAuth("seekai.cc API key",
["SEEKAI_API_KEY"])`, so it comes from `/login` (stored) or the env var, and the
OpenAI adapter sends it as **`Authorization: Bearer <key>`**.

That is a measured decision: `GET /v1/models` answers 200 with `Authorization:
Bearer <key>` and `401 {"message":"Invalid token"}` without it, and
`POST /v1/chat/completions` answers 200 with Bearer. new-api's native scheme *is*
Bearer, so no extra header is needed; the plugin does not read the key a second
time outside pi's auth resolution.

There is no zero-inference key probe at `/login`. `GET /v1/models` *would* serve as
one (401 = bad key, free), but it needs the network and would make `/login` fail
offline; the key is validated implicitly on the first request, and the 401 rewrite
names it precisely.

### Request shape (`models.ts` `CHAT_COMPAT`)

`seekai.cc` matches none of pi-ai's URL auto-detection branches, so the
auto-detected vanilla-OpenAI profile is wrong in places. Every flag is deliberate;
the grounded ones cite a probe:

| Flag | Value | Why |
|---|---|---|
| `maxTokensField` | `max_tokens` | Every probe sent `max_tokens` and the gateway enforced it (`max_tokens: 8` truncated with `finish_reason:"length"`). Pin it so auto-detect cannot switch to `max_completion_tokens`. |
| `thinkingFormat` | `openai` | The knob is a top-level `reasoning_effort` string (accepted, and honored on `deepseek-v4.1-flash`). |
| `supportsReasoningEffort` | `true` | Make pi *state* an effort rather than inherit the backend default. |
| `supportsUsageInStreaming` | `true` | Measured: the SSE ends with a `choices:[]` chunk carrying `usage` when `stream_options.include_usage` is set. |
| `supportsFinishReason` | `true` | Measured: `finish_reason` is `stop` / `length` / `tool_calls`. |
| `supportsDeveloperRole` | `false` | Conservative: `developer` was not proven accepted, `system` always is. |
| `supportsStore`, `supportsLongCacheRetention` | `false` | `store` and `prompt_cache_retention` are undocumented → do not send them. |
| `supportsStrictMode` | `false` | Strict JSON-schema tools are undocumented (pi 0.87 already defaults this false for unknown hosts). |
| `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText` | `false` | Standard OpenAI tool-call shapes round-trip (probed: a function tool returns `finish_reason:"tool_calls"`). |

`promptCache` is never set — that is what would make pi send extra *billed*
cache-warming requests, and this gateway documents no cache TTL.

### Thinking control: forced thinkers, so the off-switch is hidden

The shared map (`catalog.ts` `SEEKAI_THINKING`) maps pi's six levels onto the
effort strings the gateway accepted (`low`, `medium`, `high`), and sets **`off:
null`**, which hides the off-switch from the picker and up-clamps a request for it.

The evidence for hiding `off` is direct: `glm-5.3-flash` is a forced thinker.
`enable_thinking:false` is ignored (recon), and `reasoning_effort:"none"` is
*accepted* (200) but **still thinks** (build probe). No request turns it off. For
the models where disable is unproven, leaving `off` selectable would let pi send a
request that silently keeps thinking on — billing the user for reasoning they
turned off. Hiding it is the only honest state an unmeasured gateway supports.

`xhigh`/`max` are mapped to the string `"high"` (not `null`) on purpose: a `null`
entry makes pi-ai fall back to the raw level name (`map[level] ?? level`) if an
unclamped level ever reaches the adapter, and although this gateway tolerates
unknown effort values (probed), a wire-format test asserts no pi-internal name can
leak.

### The `<think>` decision

**Decision: the plugin extracts inline `<think>…</think>` reasoning out of
`content` and moves it into pi `thinking` blocks, at `message_end`.**

The problem, measured: `glm-5.3-flash` and
`deepseek-ai/DeepSeek-V4-Flash-0731` return their reasoning *inside `content`* —
e.g. `content = "<think>The user says…</think>\n\nok"` — not in a `reasoning_content`
field. pi-ai reads reasoning only from `reasoning_content` / `reasoning` /
`reasoning_text` (`pi-ai/dist/api/openai-completions.js`), so the tags are treated
as ordinary answer text. Left alone, the consequences are bad in three ways:

- the user's "answer" is the model's private scratchpad;
- the reasoning is **persisted** as the assistant turn and **replayed to the model
  as its own previous answer** on the next request;
- a small `max_tokens` turn (the recon saw `max_tokens: 8`) is pure thinking, so
  the user gets no answer at all.

pi offers no compat flag for this (`requiresThinkingAsText` is the *opposite*
direction — replaying pi thinking as text), so the plugin fixes it in the one hook
that sees the finalized message and can replace it: `message_end`. It moves each
think block into a `{type:"thinking"}` block (pi's native reasoning channel) and
trims the residual answer. Because pi-ai drops unsigned thinking blocks on replay,
the model never sees its reasoning echoed back as an answer.

Edge cases, both measured:

- **Unterminated blocks.** A `glm-5.3-flash` tool-call turn returned
  `content = "<think>The user wants the weather…"` with *no* closing tag. The
  splitter treats an unterminated `<think>` as reasoning to the end of the block, so
  a truncated thought is never mistaken for an answer.
- **Multiple blocks.** `<think>a</think>ok<think>b` becomes thinking `"a\n\nb"` and
  answer `"ok"`.

**Cost / limitation, stated plainly:** during *streaming*, pi-ai assembles the raw
text deltas, so a live TUI shows the `<think>…` text until the message finalizes;
only the finalized (and persisted) message is cleaned. Fixing the live view needs a
custom SSE/fetch layer, which this plugin deliberately avoids (delegating streaming
to pi-ai is the house default, and a partial-tag stream is easy to get wrong). The
end-to-end effect *is* verified in print mode: `pi -p` on the inline-thinker prints
a clean answer, not `<think>` text.

### Errors: recover the dropped body, then rewrite

The gateway is `new-api`, and several of its failures use a `{"code","message"}`
envelope **with no `error` key**. The OpenAI SDK builds its message only from
`error`, so it *drops* those bodies — driving pi-ai's real adapter with the recorded
bodies (offline) shows pi would otherwise see bare:
`401 status code (no body)`, `503 status code (no body)`,
`429 status code (no body)`. A rewrite cannot match a body it never sees.

So `errors.ts` wraps the registered api surface with `withBodyRecovery`, a fetch
wrapper that re-emits a non-OK body as `text/plain` (the standard dropped-body fix).
After that, `message_end` rewrites the four measured shapes into actionable
sentences:

| Shape | pi sees (after recovery) | Rewrite | Retryable after? |
|---|---|---|---|
| Invalid key | `401 Invalid token` | names `/login seekai`, `SEEKAI_API_KEY`, the site | **no** (deterministic) |
| Pre-billing refusal | `403 预扣费额度失败, 用户剩余额度: ＄…, 需要预扣费额度: ＄…` | explains the `max_tokens × price` reservation and that it is a balance, not a key, problem | **no** |
| No channel | `503 No available channel for model X…` / `404 …not supported by any configured account…` | "no serving channel for your account"; lists are advertisements, not entitlements | **no** (deliberately) |
| Throttle | `429 您已达到总请求数限制…` / `429 Concurrency limit exceeded…` | states the 5/min rule (failures count) and to wait | **yes** |
| Proxy 502 | `502 <!DOCTYPE html>…` | "upstream channel returned HTTP 502 (Bad gateway)" | **yes** |

The rewrites are proven against pi's *real* classifiers (`test/errors.test.ts`
imports `isRetryableAssistantError`, `isContextOverflow`, `getOverflowPatterns`):
a 429/502 stays retryable, the deterministic three do not, and **none** triggers
auto-compaction. One rewrite is a deliberate behavior change with a reason: the
`model_not_found` rewrite **drops the numeric 503** because `503` is in pi's
retryable pattern, and retrying a no-channel routing error three times only burns
the gateway's 5/min budget. Everything else preserves pi's classification.

For the two failures a human must act on (bad key, empty balance), `turn_end`
appends one persistent, deduped TUI note with the site link — gated on
`ctx.hasUI`, because an entry appended after the errored assistant message makes
`pi -p` print nothing at all (pitfall P23).

No overflow rewrite is attempted: the gateway never disclosed an overflow wording
(the recon's oversized request returned an opaque upstream `400 We got a bad
response from the source`), so a gateway-specific pattern would be invented. pi's
built-in OpenAI-compatible patterns already cover the common phrasings.

### Discovery

`fetchModels` (`discovery.ts`) reads `GET /v1/models` **with the key** (the route is
authenticated — 401 without it), then layers an **additive, unknowns-only** overlay:
curated ids keep their data, unknown ids get conservative limits and zero cost. A
failed, empty, keyless or aborted listing returns `[]` and leaves the baseline
intact, so an offline start degrades to "static catalog", never "broken provider".
Today the overlay is always empty — the gateway lists exactly the curated ids. (pi's
merge never deletes, so an id the gateway *removes* would linger until a catalog
edit; that limitation is documented rather than worked around.)

## Surfaces — three states

- **Checked and absent as of 2026-09-26:** none of the ids offers a documented
  non-openai surface — every `/v1/models` entry carries
  `supported_endpoint_types:["openai"]`. `POST /v1/responses` returns **400**
  `{"code":"resource_error"}`, i.e. the route is not wired to a backend (not a clean
  404, but nothing served it).
- **Exists but deliberately not added, with the reason (2026-09-26):**
  `POST /v1/messages` returned **200** with an Anthropic-shaped body
  (`{"type":"message","role":"assistant","content":[{"type":"text","text":"<think>…"}]}`).
  The Anthropic Messages route is therefore live and unregistered. It was not added
  because it is **unprobed** for tools and streaming and because it would not change
  behavior for the coding-agent use case (the same inline-`<think>` problem appears
  there too, and the plugin's `message_end` fix is protocol-agnostic). Adding it
  means a second `api` route plus a tools/streaming probe pass — a later increment.
  Note the corollary: `supported_endpoint_types` **is not authoritative**; a listing
  is not a capability list.
- **Deliberately not investigated:** whether the in-band Minimax 200-with-`choices:
  null` error could be surfaced by the adapter (only the four documented shapes are
  rewritten); non-chat modalities (none were advertised by `/v1/models`); and
  region/group routing (`新-api` "group" config) beyond the default group.

## Non-goals

Multi-account key pools, i18n, a separate transport/retry layer, `/v1/messages`
routing, a Minimax in-band-error adapter, command trees, persisted stores. The `pi`
surface this plugin needs is: register, `/login`, `--list-models`, `pi -p`, tools,
thinking on/off, and the error paths.

## What is verified live, and how

All on **2026-09-26**, pi 0.87.1, key from `secret.env`. Cost discipline: every fact
came from a **rejected** request (free: 401, 503, 429, and the 403 balance read) or a
tiny generation (`max_tokens ≤ 300`). No limit was "measured" by generating.

### Offline + harness

- `npm run typecheck` (`tsc -p tsconfig.json`) — clean.
- `npm test` (`node --test`, with a preload that blocks `fetch`) — **93 passing**.
  Includes wire-format tests driving pi-ai's real adapter across the catalog × every
  thinking level, and negative-safety tests against pi's real
  `isContextOverflow` / `isRetryableAssistantError` / `getOverflowPatterns`.
- `npm run live` (`live/check.ts`, paced to 5/min with 429 backoff) — **A–F PASS**:
  - A: `GET /v1/models` → 11 ids, none stale.
  - B: **glm-5.3-flash emits `<think>` inline**, and `extractInlineThinking` turns it
    into a 311-char thinking block with a clean answer (`ok`), no tag left.
  - C: deepseek-v4.1-flash's reasoning arrives as native pi thinking deltas (96
    chars; `reasoning_tokens: 43`).
  - D: a function tool round-trips (`toolcall_end`, `stopReason: toolUse`).
  - E: invalid key → `401 Invalid token`, rewritten to the non-retryable sentence, 0
    tokens.
  - F: unknown id → `503 No available channel…`, rewritten, non-retryable, 0 tokens.

### Real `pi` runs (loaded with `-e`, no global install)

- `pi -e ./index.ts --list-models` → all 11 `seekai` rows (`32.8K / 4.1K / thinking
  yes / images no`), including the slashed `deepseek-ai/DeepSeek-V4-Flash-0731` id.
- `pi -e ./index.ts -p --model seekai/deepseek-ai/DeepSeek-V4-Flash-0731 "Reply with
  exactly: ok"` → prints clean `ok` lines, **no `<think>` text**; exercises both the
  slashed-id resolution and the inline-think extraction end to end.
- **Invalid key in print mode** → prints the clarified 401 sentence, exit 1.
- **Unknown model in print mode** → prints the clarified `model_not_found` sentence,
  exit 1 (after pi's own "Using custom model id" warning, which is pi's normal
  fallback for an unregistered id).

## Cost log (what was spent, and why that figure)

The gateway prices nothing, so USD figures come only from the balance its 403
pre-billing text discloses. Token counts for harness runs are exact; the gateway
publishes no per-token rate, so the USD is the balance delta, not a rate × tokens
computation.

| Activity | Tokens | Cost |
|---|---|---|
| `live/check.ts` run 1 (A–F) | 509 paid | $0.000106 (balance delta) |
| `live/check.ts` run 2 (A–F, after a harness fix) | 602 paid | $0.000122 (balance delta) |
| one real `pi -p` run (`deepseek-v4.1-flash`) | not captured | **$0.001098 (balance delta)** |
| one real `pi -p` run (`…/DeepSeek-V4-Flash-0731`) | not captured | ≈$0.001 (unmeasured, same shape) |
| `research/raw/probe*.mjs` — ~20 paid 2xx calls | ≈1 500 out + ≈600 in | ≈$0.0005 (extrapolated) |
| `POST /v1/messages` surface probe | ≈100 | ≈$0.00002 |
| all rejected probes (401, 503, 404, 429, 403 balance reads) | 0 (not billed) | $0.000000 |
| **Total** | | **≈ $0.0035** |

That is **≈7 % of the $0.05 budget**. The account balance is *not* the build's spend:
it fell ~$2.00 between the recon and the end of this session, which is ~570× the
measured build spend and therefore belongs to concurrent account activity. The
ledger itemises every 2xx call this build made; the 401/503/429/403 probes are listed
at zero because a rejection is not billed.

## What remains unverified

- **Context windows and per-model output caps.** Unobtainable for free here
  (`max_tokens: 99999999` is accepted, not rejected), so they are conservative floors.
  To measure: either find a documented page, or send a deliberately 10×-oversized
  prompt and read the rejection — accepting that an *accepted* oversize prompt is
  billed in full. Not done, per the "never buy a cap" rule.
- **Prices.** None published; catalog is zero + `priceNote`.
- **The six non-answering ids.** Whether the MiniMax Token Plan quota is restored,
  whether `doubao-seed-2.0-code`'s 502 is transient, and whether `Qwen3.8-27B` is ever
  granted are all upstream/account states re-checkable in one `npm run live` run.
- **`hy4-preview-f`'s reasoning field.** Its usage reports `reasoning_tokens > 0`, but
  the body was not captured (the retry hit the concurrency cap), so the field is
  recorded as `unknown`.
- **Auto-compaction end-to-end.** The classifier is unit-tested and the rewrite is
  proven, but no real session was driven over the (unknown) context edge until pi
  compacted.
- **Live TUI rendering of the extracted thinking and of the `seekai-help` entry.**
  Only the print-mode behavior and the `ctx.hasUI` gate are tested; the TUI was not
  opened.
- **`POST /v1/messages`** (tools/streaming) and the in-band Minimax error — see
  § Surfaces.
- **`pi install <path>`** specifically (vs `-e`): the `pi.extensions` manifest is
  standard, but the install path was not exercised to avoid mutating the global pi
  config.

## Layout

```
index.ts      the only pi-runtime-coupled file (loader-alias import + hooks + registerProvider)
provider.ts   createProvider assembly, auth/login, base-url resolution
catalog.ts    pure data: the 11 ids, provenance, reasoning shape, level map
models.ts     catalog -> pi Model: compat flags, conservative limits, zero cost
discovery.ts  additive /v1/models overlay (authenticated, never throws)
errors.ts     body recovery, readable error rewrites, inline-<think> extraction
live/check.ts paced A–F live harness (explicit; not part of npm test)
test/*.ts     node --test suite + no-network preload
research/     recon handoff + this build's live-verification report (raw/ is gitignored)
```
