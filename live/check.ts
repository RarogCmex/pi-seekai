/**
 * Live checks against the real seekai.cc gateway — the items the offline suite
 * cannot cover (README § "What is verified live, and how"). Not part of
 * `npm test`: run explicitly with `npm run live`. Needs a key from
 * `SEEKAI_API_KEY` or from the credential `/login seekai` stored in `auth.json`
 * under pi's agent dir (resolved with pi's own `getAgentDir()`, so
 * `$PI_CODING_AGENT_DIR` is honoured); no other file is read.
 *
 * **Hard constraint: 5 requests per minute, and rejected requests count.** Every
 * request here is paced (>=13 s apart) and 429s are backed off, because a burst
 * trips the limit within seconds. Never parallelize this file.
 *
 * **Cost discipline.** The gateway publishes no prices and does NOT reject a huge
 * `max_tokens` (measured: `max_tokens: 99999999` is accepted and billed), so no
 * cap can be learned from a rejection. Every probe below is therefore either a
 * *pre-inference rejection* (free: 401, 503) or a tiny generation
 * (`max_tokens <= 300`, a few dozen output tokens). Nothing generates output to
 * "find a limit". Each paid call prints the tokens it spent; a free probe prints
 * `0 tokens`.
 *
 * **One exception, and it is not free by construction.** Check G reads the account
 * balance, and the only way this gateway discloses one is the 403 pre-billing
 * refusal — which is free *only while the balance cannot cover the reservation*
 * (`max_tokens × price`). On an account that can cover it, the same request is
 * accepted and billed; that is exactly what the `max_tokens: 99999999` measurement
 * above says. G is therefore opt-in: set `SEEKAI_LIVE_BALANCE=1` to run it.
 *
 *  A. GET /v1/models — the listing is what the catalog claims. Free.
 *  B. glm-5.3-flash — the inline `<think>` shape, and that `extractInlineThinking`
 *     turns it into a pi thinking block (no `<think>` left in the answer).
 *  C. deepseek-v4.1-flash — reasoning arrives in pi as native thinking deltas.
 *  D. a function tool round-trips (finish_reason tool_calls -> pi toolcall).
 *  E. an invalid key is rejected (free) and rewritten to a non-retryable sentence.
 *  F. an unknown model id is rejected (free) and rewritten to a non-retryable sentence.
 *  G. OPT-IN (`SEEKAI_LIVE_BALANCE=1`) — the account balance, read from the 403
 *     pre-billing text before and after: the only USD figure this gateway
 *     discloses, and free only while the balance cannot cover the reservation.
 *
 * Prints PASS/FAIL per item; exit code 1 if anything failed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Model,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "../catalog.ts";
import { clarifySeekaiError, extractInlineThinking, withBodyRecoveryApi } from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel, unknownModelToModel } from "../models.ts";
import { parseModelIds } from "../discovery.ts";

// --- key ---------------------------------------------------------------------

/**
 * pi's own agent-dir resolver, so `$PI_CODING_AGENT_DIR` and rebranded
 * distributions are honoured: a hardcoded `~/.pi/agent/auth.json` misses a pi
 * started with an alternate config dir, which is where `/login seekai` stored the
 * credential. Same class as the pi-nvidia-plus store fix (2026-09-30).
 */
const authJsonPath = (): string => join(getAgentDir(), "auth.json");

function loadKey(): string {
  if (process.env.SEEKAI_API_KEY?.trim()) return process.env.SEEKAI_API_KEY.trim();
  const auth = JSON.parse(readFileSync(authJsonPath(), "utf8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  const key = auth["seekai"]?.key?.trim();
  if (!key) throw new Error(`no seekai key in SEEKAI_API_KEY or ${authJsonPath()}`);
  return key;
}

const BASE_URL = (process.env.SEEKAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
const KEY = loadKey();
const api = withBodyRecoveryApi(openAICompletionsApi());

let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`\n[${tag}] ${name}\n${detail.replace(/^/gm, "  ")}`);
}

// --- pacing + 429 handling ---------------------------------------------------

const PACE_MS = 13_000;
let lastRequest = 0;

async function pace(): Promise<void> {
  const wait = PACE_MS - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
}

/** Paced fetch with bounded backoff on the gateway's 429 (two shapes possible). */
async function pacedFetch(url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await pace();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    if (response.status !== 429) return { status: response.status, text };
    console.log(`  [429] backing off after attempt ${attempt + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    lastRequest = Date.now();
  }
  return { status: 429, text: "gave up after repeated 429s" };
}

// --- running a real request through pi's adapter -----------------------------

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface LiveResult {
  status: number;
  text: string;
  reasoning: string;
  toolCalls: number;
  errorMessage: string | undefined;
  stopReason: string | undefined;
  usage: Usage;
  sent: Record<string, any>;
  message: AssistantMessage | undefined;
}

async function run(
  target: Model<"openai-completions">,
  options: { prompt: string; reasoning?: ThinkingLevel; maxTokens?: number; tools?: Tool[]; apiKey?: string },
): Promise<LiveResult> {
  const context = normalizeContext({
    systemPrompt: "You are concise. Answer briefly.",
    messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    tools: options.tools,
  });

  let status = 0;
  let text = "";
  let reasoning = "";
  let toolCalls = 0;
  let errorMessage: string | undefined;
  let stopReason: string | undefined;
  let final: AssistantMessage | undefined;
  let sent: Record<string, any> = {};

  let raw = "";
  const tee: typeof fetch = (async (input: any, init: any) => {
    await pace();
    const response = await fetch(input, init);
    status = response.status;
    void response.clone().text().then((t) => (raw = t)).catch(() => {});
    return response;
  }) as typeof fetch;

  const stream = api.streamSimple(target, context, {
    apiKey: options.apiKey ?? KEY,
    reasoning: options.reasoning,
    maxTokens: options.maxTokens ?? 16,
    onPayload: (body) => {
      sent = body as Record<string, any>;
    },
    fetch: tee,
  });

  for await (const event of stream) {
    if (event.type === "done") {
      final = event.message;
      stopReason = `done:${event.reason}`;
    }
    if (event.type === "error") {
      errorMessage = event.error.errorMessage;
      final = event.error;
      stopReason = `error:${event.reason}`;
    }
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "thinking_delta") reasoning += event.delta;
    if (event.type === "toolcall_end") toolCalls++;
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    status,
    text: raw,
    reasoning,
    toolCalls,
    errorMessage,
    stopReason,
    usage: final?.usage ?? ZERO_USAGE,
    sent,
    message: final,
  };
}

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) throw new Error(`${id} not in catalog`);
  return entryToModel(entry, BASE_URL) as Model<"openai-completions">;
}

function tokens(usage: Usage): number {
  return usage.input + usage.output + (usage.cacheRead ?? 0);
}

// --- checks -------------------------------------------------------------------

async function checkListing(): Promise<void> {
  const { status, text } = await pacedFetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (status !== 200) {
    report("A: GET /v1/models", false, `status ${status}: ${text.slice(0, 200)}`);
    return;
  }
  const ids = parseModelIds(JSON.parse(text));
  const known = new Set(CATALOG_BY_ID.keys());
  const stale = [...known].filter((id) => !ids.includes(id));
  const overlay = ids.filter((id) => !known.has(id));
  report(
    "A: GET /v1/models (free)",
    stale.length === 0,
    [
      `${ids.length} ids listed`,
      `catalog ids not served (stale): ${stale.join(", ") || "none"}`,
      `gateway ids not in catalog (overlay candidates): ${overlay.join(", ") || "none"}`,
    ].join("\n"),
  );
}

/**
 * Opt-in gate for check G. See the header: the balance is only disclosed by the
 * 403 pre-billing refusal, and that refusal is free *only while the balance
 * cannot cover the `max_tokens x price` reservation*. On an account that can
 * cover it, this exact request is accepted and billed — which is what the
 * `max_tokens: 99999999` measurement in the header records. So it does not run
 * unless the operator asks for it.
 */
const BALANCE_ENABLED = /^1|true|yes|on$/i.test(process.env.SEEKAI_LIVE_BALANCE?.trim() ?? "");

/** The 403 pre-billing text discloses the balance; the only USD figure available. */
async function readBalance(): Promise<number | undefined> {
  if (!BALANCE_ENABLED) return undefined;
  const { status, text } = await pacedFetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 99999999,
    }),
  });
  if (status !== 403) return undefined;
  const match = /用户剩余额度:\s*[＄$]([0-9.]+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function main(): Promise<void> {
  await checkListing();

  if (!BALANCE_ENABLED) {
    console.log(
      "G: balance read skipped — set SEEKAI_LIVE_BALANCE=1 to opt in.\n" +
        "   It is not free by construction: the balance is disclosed only by the 403\n" +
        "   pre-billing refusal, which is free only while the balance cannot cover the\n" +
        "   max_tokens x price reservation. On a funded account the request is billed.",
    );
  }
  const balanceBefore = await readBalance();
  let spentTokens = 0;

  // B: the vendor story — glm-5.3-flash reasons inline in content as <think>.
  {
    const r = await run(model("glm-5.3-flash"), {
      prompt: "Reply with exactly: ok",
      reasoning: "low" as ThinkingLevel,
      maxTokens: 300,
    });
    spentTokens += tokens(r.usage);
    // pi-ai assembles the SSE text deltas into `message.content`; the raw `<think>`
    // tags are still inline there, which is exactly what the plugin must move.
    const content = r.message?.content ?? [];
    const rawContent = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const blocks = extractInlineThinking(content as any) ?? [];
    const thinkingBlock = blocks.find((b) => b.type === "thinking") as { thinking?: string } | undefined;
    const answerBlock = blocks.find((b) => b.type === "text") as { text?: string } | undefined;
    report(
      "B: glm-5.3-flash inline <think> is extracted into a thinking block",
      r.status === 200 &&
        /<think>/.test(rawContent) &&
        typeof thinkingBlock?.thinking === "string" &&
        thinkingBlock.thinking.length > 0 &&
        !/<think>/.test(answerBlock?.text ?? ""),
      [
        `sent: max_tokens=${r.sent.max_tokens} reasoning_effort=${JSON.stringify(r.sent.reasoning_effort)}`,
        `assembled content contains <think>: ${/<think>/.test(rawContent)}`,
        `raw content: ${JSON.stringify(rawContent.slice(0, 80))}`,
        `extracted thinking chars: ${thinkingBlock?.thinking?.length ?? 0}`,
        `answer text (cleaned): ${JSON.stringify((answerBlock?.text ?? "").slice(0, 60))}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `spent ${tokens(r.usage)} tokens`,
      ].join("\n"),
    );
  }

  // C: a model whose reasoning arrives in reasoning_content (pi reads it natively).
  {
    const r = await run(model("deepseek-v4.1-flash"), {
      prompt: "A train leaves at 15:15 and the trip takes 2 h 40 min. What time does it arrive? Think it through.",
      reasoning: "high" as ThinkingLevel,
      maxTokens: 256,
    });
    spentTokens += tokens(r.usage);
    report(
      "C: deepseek-v4.1-flash reasoning arrives as native thinking deltas",
      r.status === 200 && !r.errorMessage && r.reasoning.length > 0,
      [
        `thinking chars streamed: ${r.reasoning.length}`,
        `answer: ${JSON.stringify(
          (r.message?.content ?? [])
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("")
            .slice(0, 40),
        )}`,
        `usage: input=${r.usage.input} output=${r.usage.output} reasoning_tokens=${r.usage.reasoning ?? "n/a"}`,
        `spent ${tokens(r.usage)} tokens`,
      ].join("\n"),
    );
  }

  // D: a function tool round-trips through the gateway.
  {
    const weatherTool: Tool = {
      name: "get_weather",
      description: "Look up the weather for a city.",
      parameters: Type.Object({ city: Type.String({ description: "City" }) }),
    };
    const r = await run(model("deepseek-v4.1-flash"), {
      prompt: "What is the weather in Paris? Use the tool.",
      reasoning: "low" as ThinkingLevel,
      maxTokens: 128,
      tools: [weatherTool],
    });
    spentTokens += tokens(r.usage);
    report(
      "D: function tool call round-trip",
      r.toolCalls >= 1 && !r.errorMessage,
      [
        `toolcall_end events: ${r.toolCalls}`,
        `finish: ${r.stopReason}`,
        `sent tools: ${Array.isArray(r.sent.tools) ? r.sent.tools.length : 0}`,
        `usage: input=${r.usage.input} output=${r.usage.output}`,
        `spent ${tokens(r.usage)} tokens`,
      ].join("\n"),
    );
  }

  // E: invalid key (free).
  {
    const r = await run(model("glm-5.3-flash"), {
      prompt: "hi",
      reasoning: "low" as ThinkingLevel,
      maxTokens: 8,
      apiKey: "sk-invalid-key-for-the-auth-check",
    });
    const raw = r.errorMessage ?? "";
    const clarified = clarifySeekaiError(raw);
    const asMsg = (m: string) => ({ role: "assistant", stopReason: "error", errorMessage: m }) as any;
    report(
      "E: invalid key rejected and clarified (free)",
      r.status === 401 &&
        !!clarified &&
        !isContextOverflow(asMsg(clarified)) &&
        !isRetryableAssistantError(asMsg(clarified)),
      [
        `http status: ${r.status}`,
        `pi sees: ${JSON.stringify(raw)}`,
        `clarified: ${(clarified ?? "(none)").slice(0, 160)}`,
        `spent 0 tokens`,
      ].join("\n"),
    );
  }

  // F: unknown model id (free).
  {
    const ghost = unknownModelToModel("seekai-does-not-exist-xyz", BASE_URL) as Model<"openai-completions">;
    const r = await run(ghost, { prompt: "hi", reasoning: "low" as ThinkingLevel, maxTokens: 8 });
    const raw = r.errorMessage ?? "";
    const clarified = clarifySeekaiError(raw);
    const asMsg = (m: string) => ({ role: "assistant", stopReason: "error", errorMessage: m }) as any;
    report(
      "F: unknown model id rejected and clarified (free)",
      !!clarified && !isContextOverflow(asMsg(clarified)) && !isRetryableAssistantError(asMsg(clarified)),
      [
        `http status: ${r.status}`,
        `pi sees: ${JSON.stringify(raw)}`,
        `clarified: ${(clarified ?? "(none)").slice(0, 160)}`,
        `spent 0 tokens`,
      ].join("\n"),
    );
  }

  const balanceAfter = await readBalance();

  console.log(
    [
      "",
      "Cost accounting",
      `  paid tokens this run: ${spentTokens}`,
      `  balance before: ${balanceBefore !== undefined ? `$${balanceBefore}` : BALANCE_ENABLED ? "unavailable (no 403)" : "skipped (SEEKAI_LIVE_BALANCE not set)"}`,
      `  balance after:  ${balanceAfter !== undefined ? `$${balanceAfter}` : BALANCE_ENABLED ? "unavailable (no 403)" : "skipped (SEEKAI_LIVE_BALANCE not set)"}`,
      balanceBefore !== undefined && balanceAfter !== undefined
        ? `  measured balance delta: $${(balanceBefore - balanceAfter).toFixed(6)}`
        : "  measured balance delta: n/a",
      "  The gateway publishes no per-token price, so the catalog costs are zero;",
      "  the balance delta is the only USD figure it discloses.",
    ].join("\n"),
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
