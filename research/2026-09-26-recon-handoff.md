# seekai.cc — measured reconnaissance (handoff to the build)

Probed 2026-09-26 with the live key. **Every line below is measured, not read** —
treat it as the starting point, not as the finished catalog. Anything the builder
re-measures wins over anything here.

Base `https://seekai.cc/v1`, key `sk-...`. Engine: `new-api` (one-api fork) —
error envelope `{"error":{"code","message","type":"new_api_error","request id"}}`.

## Hard operating constraint: 5 requests per minute, **failures count**

`429 {"code":"","message":"您已达到总请求数限制：1分钟内最多请求5次，包括失败次数…"}`
("you have reached the total request limit: at most 5 requests per minute,
including failed ones"). A burst of probes trips this within seconds. The live
harness **must** pace (or back off on 429); a naive parallel suite cannot run here.

## The free-probe technique does NOT work on this gateway

`max_tokens: 99999999` on `deepseek-v4.1-flash` returned **HTTP 200** and generated
39 tokens — accepted and billed, no cap disclosed. On `glm-5.3-flash` the same
request returned an opaque `400 "We got a bad response from the source"` (the
upstream's own rejection, no number in it). So output caps are **not** obtainable
from free rejections here; most caps must be recorded as *unverified* rather than
bought. (This is pitfalls L18/L35 in the wild: an accepted probe is a billed one.)

## Measured facts

| probe | result |
|---|---|
| `GET /v1/models` **with** key | 200, 11 ids |
| `GET /v1/models` **without** key | `401 {"code":"","message":"Invalid token"}` → listing is authenticated, so it doubles as free key validation |
| `POST /chat/completions {}` | `400 new_api_error` "Model name not specified…" |
| unknown model id | **`503`** `{"code":"model_not_found","message":"No available channel for model X under group default (distributor)"}` |
| huge `max_tokens` on `claude-sonnet-4-6` | **`403`** pre-billing refusal: `预扣费额度失败, 用户剩余额度: ＄12.345678, 需要预扣费额度: ＄1500.000016` — the gateway **reserves credit from `max_tokens × price`** and discloses the account balance in the clear |
| tools on `deepseek-v4.1-flash` | 200, tool schema accepted |

### Listed models (11)

`claude-sonnet`, `claude-sonnet-4-6`, `claude-sonnet-4-20250514`,
`doubao-seed-2.0-code`, `deepseek-v4.1-flash`,
`deepseek-ai/DeepSeek-V4-Flash-0731`, `glm-5.3-flash`, `hy3`, `hy4-preview-f`,
`MiniMax-M2.7-highspeed`, `Qwen3.8-27B` — all `supported_endpoint_types: ["openai"]`.

## `glm-5.3-flash` is a forced thinker with a shape pi cannot see

- `enable_thinking: false` → **ignored**: 200, and the model still thinks.
- no thinking params at all → same.
- The reasoning arrives **inline in `content` as `<think>…</think>`**, *not* in a
  `reasoning_content` field: with `max_tokens: 8` the whole answer was
  `"<think>The user says \"say ok\"…"` with `finish_reason: "length"` — the user
  gets no answer at all.
- Consequences to design for: (a) this model cannot be turned off — hide `off`
  (pitfalls T5) and map the remaining levels to whatever the vendor accepts;
  (b) **pi has no mechanism for inline think tags** — nothing in
  `openai-completions.js` strips `<think>` from `content`, so a small `max_tokens`
  turn silently yields no answer. Decide explicitly what the plugin does about it
  (strip? leave and document?) and write the decision down.

## Open questions for the build (do not guess)

- Does `glm-5.3-flash` accept `reasoning_effort` (`low`/`high`) or only
  `chat_template_kwargs.enable_thinking`? Pace the probes.
- Which of the 11 ids actually answer (the user's own list marks some as
  "lists but does not work") → `/models` is a *listing*, not an entitlement;
  `503 model_not_found` is the signal.
- Context windows and per-model output caps for the ids that do answer.
- Pricing: **no pricing page was found** → by house rule, zero + `priceNote`,
  never a guess. Note that the 403 pre-charge text reveals the balance, which is
  a debugging aid, not a price source.
