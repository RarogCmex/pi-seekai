/**
 * Offline-suite guard and loader alias.
 *
 * Loaded as a preload (`node --test --import ./test/no-network.ts`) so the whole
 * `node --test` run:
 *
 *  1. has `globalThis.fetch` replaced with a throwing stub — a test that
 *     accidentally dials the real seekai.cc gateway fails loudly instead of
 *     spending the account's credit (the gateway allows only 5 requests/minute),
 *     making "offline tests" a property of the suite rather than a claim about it;
 *  2. resolves the bare "@earendil-works/pi-ai" specifier to pi-ai's `compat`
 *     entrypoint, exactly as pi's extension loader does. Plain Node resolves it
 *     to `dist/index`, which does not export `openAICompletionsApi`, so without
 *     this mirror `index.ts` (the one pi-runtime-coupled file) could not be
 *     imported by the entry test.
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-ai") {
      return next("@earendil-works/pi-ai/compat", context);
    }
    return next(specifier, context);
  },
});

const blocked = (): never => {
  throw new Error("network blocked: the offline test suite must not dial out");
};

globalThis.fetch = blocked as unknown as typeof fetch;
