/**
 * seekai.cc provider for pi (`https://seekai.cc/v1`).
 *
 * Registers `seekai` as a first-class pi-ai provider: the curated 11-id catalog,
 * `/login` support, a live `/v1/models` overlay, and an error layer for the
 * gateway's `new-api` failure shapes. The vendor-specific piece is the inline
 * `<think>` handling — see `errors.ts` `extractInlineThinking`.
 *
 * pi 0.87 boundaries: `message_end` rewrites the finalized assistant message
 * (recovered error text → readable sentence, inline `<think>` → `thinking` blocks)
 * before it is persisted, while `turn_end` appends a persistent TUI note for the
 * two failures a human must act on (bad key, exhausted balance).
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. Subpaths
// other than /compat, /oauth and /providers/all are NOT aliased. tsconfig.json
// mirrors the loader's alias so `npm run typecheck` sees what pi sees. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clarifySeekaiError,
  extractInlineThinking,
  needsPersistentHelp,
  withBodyRecoveryApi,
  SITE_URL,
} from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { buildSeekaiProvider } from "./provider.ts";

const HELP_ENTRY_TYPE = "seekai-help";

export default function (pi: ExtensionAPI) {
  // One rewrite per finalized assistant message, guarded twice (this provider,
  // then the message role): the readable error sentence, and the inline-`<think>`
  // extraction. Both return a *replacement* message, which pi applies in place
  // before persisting, so the cleaned content reaches the transcript and the
  // model's next turn, not just the display.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== PROVIDER_ID) return;

    let next = message;

    if (message.stopReason === "error") {
      const clarified = clarifySeekaiError(message.errorMessage ?? "");
      if (clarified) next = { ...next, errorMessage: clarified };
    }

    if (Array.isArray(message.content)) {
      const content = extractInlineThinking(message.content);
      if (content) next = { ...next, content };
    }

    return next === message ? undefined : { message: next };
  });

  // A persistent TUI note for the two failures the user must fix (invalid key,
  // balance cannot cover the pre-billing reservation). The `ctx.hasUI` gate is
  // load-bearing: an entry appended *after* the errored assistant message makes
  // `pi -p` print nothing at all (pitfall P23), so print mode keeps only the
  // rewritten error bubble. Deduped via customType so re-emits do not stack.
  pi.on("turn_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const msg = event.message as unknown as {
      role: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    if (msg.role !== "assistant" || msg.provider !== PROVIDER_ID) return;
    if (!needsPersistentHelp(msg.errorMessage ?? "")) return;
    if (event.entries.some((e) => (e as { customType?: string }).customType === HELP_ENTRY_TYPE)) return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: HELP_ENTRY_TYPE,
          content:
            "seekai.cc rejected the request before generation. Check the API key " +
            `(\`/login ${PROVIDER_ID}\` or \`SEEKAI_API_KEY\`) and the account balance at ${SITE_URL}. ` +
            "The gateway answers HTTP 401 for an invalid key and HTTP 403 when the balance cannot " +
            "cover the pre-billing reservation (max_tokens × price).",
          display: true,
        },
      ],
    };
  });

  pi.registerProvider(buildSeekaiProvider(withBodyRecoveryApi(openAICompletionsApi())));
}
