# pi-seekai

A provider plugin for [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`, the coding agent this plugs into) targeting the
**seekai.cc** gateway (`https://seekai.cc/v1`) — a `new-api` (one-api fork)
aggregator that name-routes model ids onto assorted upstreams. npm name:
`@rarogcmex/pi-seekai`. Registers the `seekai` provider with a curated 11-id
catalog, `/login` support, a live `/v1/models` overlay, and an error layer for
new-api's particular failure shapes.

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
(pi 0.87.1, pi-ai 0.87.1) with a real key. The findings are in
[`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md);
the raw probe transcripts behind them are in `research/raw/`, which is gitignored
and **not published**.

## Install / use

```bash
pi install git:github.com/RarogCmex/pi-seekai@main
# or a local checkout:  pi install /path/to/pi-seekai
# or one-shot:          pi -e /path/to/pi-seekai/index.ts
```

Then, **inside pi** (its own slash command, not a shell command):

```
/login seekai
```

or set the key in the environment instead:

```bash
export SEEKAI_API_KEY=sk-…
pi --model seekai/deepseek-v4.1-flash -p "hello"   # the id already names the provider
```

**Before you start.** Three things a first-time user needs and the gateway does not
tell you:

- **The account must carry a prepaid balance.** Every request *reserves*
  `max_tokens × price` before inference and refuses with 403 `预扣费额度失败` when
  the balance cannot cover the reservation. That is why six of the eleven listed
  ids fail for a fresh account: it is a balance/quota state, not a dead model.
- **A key comes from the seekai.cc site.** Nothing in this plugin can create one;
  the `/login` prompt names the site.
- **pi version.** The `<think>` extraction and the `message_end` rewrite depend on
  pi 0.87 hook semantics (`index.ts`, `models.ts`). `peerDependencies` is `*`, so
  an older pi may load the plugin and silently degrade rather than refuse.

Environment:

| Variable | Meaning |
|---|---|
| `SEEKAI_API_KEY` | API key (`sk-…`). The stored credential from `/login` wins over it. |
| `SEEKAI_BASE_URL` | Endpoint override (default `https://seekai.cc/v1`), trailing slash stripped. |
| `SEEKAI_LIVE_BALANCE` | `1` opts the live harness into check G (the balance read). Off by default — see § Development. |

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
would be to *buy* it by generating to the limit, and an accepted oversize request
is billed in full — so that is not done. The catalog therefore uses a small
conservative floor (32 K / 4 K) so pi
compacts *before* an over-context request would be billed. § "What remains
unverified" says how to measure it properly.

**Every price is zero, with a `priceNote` — and that does not mean free.**
seekai.cc publishes no price list and
returns no per-token cost; its 403 pre-billing text leaks only the *account
balance*, which is a debugging aid, not a price source. pi therefore reports
`$0.00` rather than a plausible-looking wrong number. **Your seekai.cc balance is
still debited per request**: the gateway reserves `max_tokens × price` before
inference and refuses when the balance cannot cover it (§ Install / use).

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
| `supportsOpenAIGrammarTools` | `false` | OpenAI grammar tools are undocumented here → do not send them. |
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
- a small `max_tokens` turn (measured with `max_tokens: 8`) is pure thinking, so
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
custom SSE/fetch layer, which this plugin deliberately avoids: streaming stays
delegated to pi-ai, because a `<think>` tag split across SSE chunks is easy to get
wrong and getting it wrong corrupts the answer. The
end-to-end effect *is* verified in print mode: `pi -p` on the inline-thinker prints
a clean answer, not `<think>` text.

### Errors: normalise the body, then rewrite

The gateway is `new-api`, and its failures arrive in two shapes. Which one you get
decides what pi sees, and the difference is worth spelling out because it is easy
to reason about the wrong one:

- **Enveloped** `{"error":{"code":…,"message":…,"type":…}}` — what **every status
  we measured** actually sends (401, 403, 429, 503, 404). The OpenAI SDK strips the
  outer `error` key, and pi-ai then surfaces the *stringified remainder* glued to the
  status: `401: {"code":"","message":"Invalid token …","type":"new_api_error"}`.
  The text survives — as a JSON blob no human wants to read and no rewrite wants to
  parse twice.
- **Non-OpenAI** — a bare `{"code":…,"message":…}` with no `error` key, and the
  proxy's HTML on 502. The SDK composes its message only from `error`, so pi sees
  bare `401 status code (no body)` / `502 status code (no body)`. Here the body
  really is lost.

Both rows are measured offline by driving pi-ai's real adapter with both fixtures
for the same status (enveloped → `401: {"code":…}`; bare → `401 status code (no
body)`), and `test/errors.test.ts` locks the enveloped shape in as a regression
test.

So `errors.ts` wraps the registered api surface with `withBodyRecovery`, a fetch
wrapper that re-emits a non-OK body as `text/plain` — the standard dropped-body fix.
Here it buys two things: the genuinely lost bodies come back, and *both* shapes
arrive as one uniform `<status> <text>` that `parseGatewayError` can handle once.
After that, `message_end` rewrites the five measured shapes into actionable
sentences, and deliberately does **not** rewrite a sixth:

| Shape | pi sees (after recovery) | Rewrite | Retryable after? |
|---|---|---|---|
| Relayed upstream 401 | `400 …bad_response_status_code… Invalid API key` (a *broken channel*, relayed verbatim by new-api) | names the upstream outage; checked **before** the auth branch, because `\b401\b` would otherwise match | **no** — and deliberately *not* sent to `/login` |
| Invalid key | `401 Invalid token` | names `/login seekai`, `SEEKAI_API_KEY`, the site | **no** (deterministic) |
| Pre-billing refusal | `403 预扣费额度失败, 用户剩余额度: ＄…, 需要预扣费额度: ＄…` | explains the `max_tokens × price` reservation and that it is a balance, not a key, problem | **no** |
| No channel | `503 No available channel for model X…` / `404 …not supported by any configured account…` | "no serving channel for your account"; lists are advertisements, not entitlements | **no** (deliberately) |
| Throttle | `429 您已达到总请求数限制…` / `429 Concurrency limit exceeded…` | states the 5/min rule (failures count) and to wait | **yes** |
| Proxy 502 | `502 <!DOCTYPE html>…` | "upstream channel returned HTTP 502 (Bad gateway)" | **yes** |

The first row is the subtlest behavior in the module: a 401 that must **not** be
treated as an auth failure, because the key is fine and the provider's channel is
down. Sending the user to `/login` there would be a wrong instruction.

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
`pi -p` print nothing at all.

No overflow rewrite is attempted: the gateway never disclosed an overflow wording
(the oversized request returned an opaque upstream `400 We got a bad
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

All on **2026-09-26**, pi 0.87.1, with a real key. Cost discipline: every fact
came from a **rejected** request (free: 401, 503, 429) or a tiny generation
(`max_tokens ≤ 300`). No limit was "measured" by generating. The one exception is
check G, the balance read, which is opt-in and *not* free by construction — see
§ Development.

### Offline + harness

- `npm run typecheck` (`tsc -p tsconfig.json`) — clean.
- `npm test` (`node --test`, with a preload that blocks `fetch`) — **94 passing**
  (run it rather than trusting the number).
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
  - G: the account balance, read from the 403 pre-billing text. **Opt-in**
    (`SEEKAI_LIVE_BALANCE=1`) and not run for the figures above — see § Development
    for why it is not free by construction.

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

## What verifying this cost

≈ **$0.0036** in total, across three full harness runs, two real `pi -p` runs, the
`POST /v1/messages` surface probe and ~20 paid probe calls. Every rejected probe
(401, 503, 404, 429) cost nothing, which is most of what was learned.

The figure is a **balance delta, not `rate × tokens`**: the gateway publishes no
per-token rate, so the only USD it discloses is the account balance inside its 403
pre-billing text. Two consequences, both measured:

- the delta is a coarse upper bound, not a meter — a 136-paid-token harness pass
  reported **$0.000000**, because the balance is shown to six decimals and does not
  always move for a small run;
- the balance also moves for reasons unrelated to this plugin, so a delta taken
  over a window is not attributable to the work in it. The exact, attributable
  figures are the **token counts**, which the harness prints per request.

The per-request ledger is in
[`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md)
rather than here.


## Known limitations

- **Context windows and per-model output caps are floors, not measurements.**
  They are unobtainable for free here — `max_tokens: 99999999` is accepted rather
  than rejected, so no rejection discloses a cap. Measuring one means either
  finding a documented page or sending a deliberately oversized prompt and
  accepting that an *accepted* oversize request is billed in full. Not done: a cap
  is never worth buying when the alternative is a conservative floor that only
  makes pi compact earlier.
- **Prices are zero because none are published.** pi reports `$0.00`; the account
  is still debited (§ Install / use).
- **Six of the eleven listed ids did not answer** on 2026-09-26. Whether the
  MiniMax Token Plan quota is restored, whether `doubao-seed-2.0-code`'s 502 is
  transient, and whether `Qwen3.8-27B` is ever granted are upstream/account states,
  re-checkable in one `npm run live` run. They stay registered on purpose —
  see § Why all 11 ids.
- **`hy4-preview-f`'s reasoning field is unknown.** Its usage reports
  `reasoning_tokens > 0`, but the body was not captured (the retry hit the
  concurrency cap).
- **Auto-compaction is proven at the classifier, not end to end.** No real session
  was driven over the (unknown) context edge until pi compacted.
- **During streaming, the raw `<think>` text is visible until the message
  finalizes.** Only the finalized message is cleaned; fixing the live view needs a
  custom SSE layer this plugin deliberately does not have (§ The `<think>` decision).
- **`POST /v1/messages`** (tools/streaming) and the in-band Minimax error — see
  § Surfaces.

## What was left unchecked in the build

Recorded so a contributor does not re-derive it:

- **Live TUI rendering** of the extracted thinking and of the `seekai-help` entry:
  only the print-mode behavior and the `ctx.hasUI` gate are tested; the TUI was not
  opened.
- **`pi install` from the published source** (vs `-e`) — exercised 2026-09-30
  against `git:github.com/RarogCmex/pi-seekai@main` with `PI_CODING_AGENT_DIR`
  pointed at a throwaway directory, so no global pi config was mutated: the
  package installed and `pi --list-models seekai` listed all 11 curated ids under
  a deliberately invalid key (the live `/v1/models` overlay therefore did not
  contribute — an unprobed account degrades to the static catalog, which is the
  documented behaviour). The control run (same key, empty config dir, no package)
  listed none. Still unchecked: a billed request on a valid key.

## Development

```bash
node scripts/link-pi.mjs   # once: link pi's packages from your global install
npm run check              # typecheck + the offline tests
npm run live               # opt-in A–F harness against the real gateway; spends credit
```

**Prerequisites.** Node ≥ 22.18 — the tests and `live/check.ts` are `.ts` executed
directly (type stripping, and `node --test`'s `.ts` discovery, are unflagged from
22.18) — plus a pi install.

pi's own packages are not dependencies of this plugin: at runtime pi's extension
loader aliases the bare `@earendil-works/pi-ai` specifier to its own copy, so a
plain `npm install` leaves nothing to typecheck against. `scripts/link-pi.mjs`
links them from your global pi install; it probes the npm prefix, nvm, pnpm,
`~/.local`, `/usr/local` and the directory the `pi` executable resolves to, and
creates junctions on Windows. For a specific install:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`. Verified against
pi 0.87.1 / pi-ai 0.87.1 / `@types/node` 22.19.19.

`npm run live` needs a key and nothing else — `SEEKAI_API_KEY`, or the credential
`/login seekai` stored in `~/.pi/agent/auth.json`. It is paced ≥13 s apart because
**the gateway allows 5 requests per minute and counts rejections**, and it backs
off on 429. Never parallelize it.

**Check G is opt-in and is not free by construction.** The only way this gateway
discloses a balance is the 403 pre-billing refusal, which is free *only while the
balance cannot cover the `max_tokens × price` reservation*. On an account that can
cover it, the same request is accepted and billed — that is precisely what the
`max_tokens: 99999999` measurement says. So G runs only under
`SEEKAI_LIVE_BALANCE=1`.


## Layout

```
index.ts      the only pi-runtime-coupled file (loader-alias import + hooks + registerProvider)
provider.ts   createProvider assembly, auth/login, base-url resolution
catalog.ts    pure data: the 11 ids, provenance, reasoning shape, level map
models.ts     catalog -> pi Model: compat flags, conservative limits, zero cost
discovery.ts  additive /v1/models overlay (authenticated, never throws)
errors.ts     body recovery, readable error rewrites, inline-<think> extraction
live/check.ts paced A–G live harness (G opt-in; explicit, not part of npm test)
test/*.ts     node --test suite + no-network preload
research/     the 2026-09-26 live-verification report (raw/ is gitignored)
scripts/      link-pi.mjs — dev setup only, never loaded by pi
```
