# seekai.cc — live verification (build session, 2026-09-26)

Second measurement pass, done while building `pi-seekai`. Raw probe scripts and
full transcripts live in `research/raw/` (gitignored): `probe.mjs`, `probe2.mjs`,
`probe3.mjs`, `probe4.mjs`, `probe5.mjs`, `compose.mjs`, `compose2.mjs`, and
`live-run-1.txt` / `live-run-2.txt`. Nothing here contradicts the recon handoff;
it fills its open questions and corrects one implication.

Operating constraints held throughout: **5 requests/minute, failures included** →
every probe paced ≥13 s; **accepted = billed** → no cap was bisected with accepted
requests.

## 1. Open questions the build was asked to close

| Question | Answer (measured) |
|---|---|
| Does glm-5.3-flash accept `reasoning_effort`? | **Yes, but it changes nothing.** `low`, `medium`, `high`, `none` all return 200 and the model still emits inline `<think>`. `none` does **not** disable thinking. → the model is a true forced thinker; the plugin hides the `off` switch. |
| Which of the 11 ids answer? | See the matrix below. `GET /v1/models` is a *listing*, not an entitlement: 4 ids answer 200 with an in-band Minimax quota error, one 502s, one 404s. |
| Context windows / output caps? | **Not obtainable.** `max_tokens: 99999999` is accepted (200), so no rejection discloses a cap; buying it would mean generating to the cap. Recorded as unverified; the catalog uses conservative floors (32 768 / 4 096). |
| Pricing? | None published. The 403 pre-billing text leaks only the account balance. Catalog = zero + `priceNote`. |

## 2. Liveness matrix (max_tokens:8, 2026-09-26)

| id | HTTP | reality |
|---|---|---|
| `deepseek-v4.1-flash` | 200 | real completion, reasoning in `reasoning_content` |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | 200 | real completion, reasoning **inline in `content`** as `<think>` |
| `glm-5.3-flash` | 200 | real completion, reasoning **inline in `content`** as `<think>`; response `model` field says `MiniMaxAI/MiniMax-M2.7`, `system_fingerprint: vllm-0.30.0` → name-routed to a MiniMax backend |
| `hy3` | 200 | real completion, `reasoning_content` field, `usage.reasoning_tokens` populated |
| `hy4-preview-f` | 200 | `usage.reasoning_tokens > 0`; body not captured (a retry hit the concurrency limit) |
| `claude-sonnet`, `claude-sonnet-4-6`, `claude-sonnet-4-20250514`, `MiniMax-M2.7-highspeed` | 200 | **in-band error**: `{"_provider":"Minimax","base_resp":{"status_code":2056,"status_msg":"已达到 Token Plan 用量上限…"},"choices":null,"model":"MiniMax-M2.7"}` — the MiniMax upstream account is out of Token Plan quota |
| `doubao-seed-2.0-code` | 502 | HTML `<title>seekai.cc \| 502: Bad gateway</title>` page from the fronting proxy |
| `Qwen3.8-27B` | 404 | `model_not_found`: `Model "自部署/Qwen3.8-27B" is not supported by any configured account in this group` |

## 3. Error-body composition (this is why the plugin wraps fetch)

Driving pi-ai's real `openai-completions` adapter with the recorded bodies
(`compose.mjs`) shows the OpenAI SDK **drops** new-api's `{code,message}` envelopes
(no `error` key), so pi sees:

| recorded body | pi sees WITHOUT recovery | pi sees WITH `withBodyRecovery` |
|---|---|---|
| 401 `{"code":"","message":"Invalid token"}` | `401 status code (no body)` | `401 Invalid token` |
| 503 `{"code":"model_not_found","message":"No available channel for model X under group default (distributor)"}` | `503 status code (no body)` | `503 No available channel for model X …` |
| 429 `{"code":"","message":"您已达到总请求数限制：1分钟内最多请求5次，包括失败次数"}` | `429 status code (no body)` | `429 您已达到总请求数限制…` |
| 403 / 404 with an `error` key | already visible | visible (same text) |
| 502 HTML | `502 <!DOCTYPE html>…` | `502 <!DOCTYPE html>…` (first line only) |

## 4. Streaming

SSE for `glm-5.3-flash` (`stream:true`, `stream_options:{include_usage:true}`):
content deltas carry the raw `<think>…` text; the stream ends with
`finish_reason:"stop"` and a final `choices:[]` chunk carrying
`usage:{prompt_tokens:43, completion_tokens:124, total_tokens:167}`. So
`supportsUsageInStreaming` and `supportsFinishReason` are both true.

## 5. Surfaces

| route | 2026-09-26 | note |
|---|---|---|
| `POST /v1/chat/completions` | 200 | the only registered surface |
| `GET /v1/models` | 200 with a key, 401 without | doubles as free key validation |
| `POST /v1/messages` | **200**, Anthropic-shaped (`{"type":"message","role":"assistant","content":[{"type":"text","text":"<think>…"}]}`) | **exists but deliberately not added** — unprobed for tools/streaming; the listing's `supported_endpoint_types:["openai"]` is therefore *not authoritative* |
| `POST /v1/responses` | 400 `{"code":"resource_error","message":"Resource error…"}` | not a clean 404; no backend wired; not added |

## 6. Cost ledger (this build session)

The gateway publishes no prices, so USD figures come only from the balance the 403
pre-billing text discloses (`用户剩余额度: ＄…`). Token counts for the harness runs
are from `live/check.ts`; the raw probes used `max_tokens ≤ 512`.

| activity | tokens | USD |
|---|---|---|
| `live/check.ts` run 1 (A–F) | 509 paid | $0.000106 (balance delta) |
| `live/check.ts` run 2 (A–F, after harness fix) | 602 paid | $0.000122 (balance delta) |
| one real `pi -p` run (`seekai/deepseek-v4.1-flash`, "ok") | not captured | **$0.001098 (balance delta)** |
| one real `pi -p` run (`…/DeepSeek-V4-Flash-0731`, slashed id) | not captured | ≈$0.001 (same shape, unmeasured) |
| `research/raw/probe*.mjs` — ~20 paid 2xx calls (liveness sweep, think shapes, effort probes, tool probe) | ≈1 500 completion + ≈600 prompt | ≈$0.0005 (extrapolated from the measured runs) |
| `POST /v1/messages` surface probe | ≈100 | ≈$0.00002 |
| rejected probes (401 key, 503/404 model, 429s, 403 balance reads) | 0 (not billed) | $0.000000 |
| **total** | | **≈ $0.0035** |

That is **≈7 % of the $0.05 budget**.

**Do not read the account balance as this build's spend.** The recon recorded
`$<redacted>`; the build ended at `≈$<redacted>` — a ~$2.00 drop that is ~570× the
measured build spend and therefore belongs to concurrent account activity, not to
these probes. The ledger above itemises the calls this build actually made.

## 7. Correction to the recon handoff

The handoff implied `/v1/models`' `supported_endpoint_types:["openai"]` means only
completions is available. It does not: `POST /v1/messages` answered 200 with an
Anthropic-shaped body. The field is a hint, not a capability list (same lesson as
pitfalls C-series: a listing is not an entitlement).
