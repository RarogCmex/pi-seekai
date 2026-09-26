/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it loads under plain Node (and `node --test`):
 * everything here resolves through pi-ai's core entrypoint. The one symbol that
 * does not — `openAICompletionsApi`, which pi's loader serves from the compat
 * entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { SITE_URL } from "./errors.ts";
import { fetchSeekaiModels } from "./discovery.ts";
import { buildModels, DEFAULT_BASE_URL, PROVIDER_ID, type GatewayApi } from "./models.ts";

export const API_KEY_AUTH_NAME = "seekai.cc API key";
export const API_KEY_ENV_VAR = "SEEKAI_API_KEY";
export const BASE_URL_ENV_VAR = "SEEKAI_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Endpoint override for a proxy or a mirror. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

/**
 * Stored-key-then-env resolution with whitespace trimming on both paths. A key
 * pasted with a trailing newline is rejected with the same opaque
 * `401 (no body)` as a revoked one (see errors.ts), which reads like an account
 * problem rather than a stray character.
 *
 * There is no zero-inference key probe here: `GET /v1/models` *would* serve as one
 * (401 = bad key), but it needs the network, and login would then fail offline.
 * The key is checked implicitly on the first request, and the 401 rewrite names it.
 */
export function seekaiApiKeyAuth(): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction) {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message: "Create a seekai.cc API key at the gateway site, then paste it here:",
        links: [{ url: SITE_URL, label: "seekai.cc" }],
      });
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "sk-...",
      });
      interaction.signal.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("sk-")) {
        // Warn, don't reject: the gateway's key format is not a documented contract.
        interaction.notify({
          type: "info",
          message: "That does not look like a seekai.cc key (expected sk-…). Saving it regardless.",
        });
      }
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      if (!resolved || !key) return undefined;
      return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
    },
  };
}

/**
 * Build the `seekai` provider.
 *
 * `models` is the curated baseline, always present and never network-dependent.
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore and restores it offline, so a new id
 * shows up without a catalog edit while a failed listing degrades to the baseline.
 *
 * Only the `openai-completions` surface is registered — every listed id carries
 * `supported_endpoint_types:["openai"]`, so there is no second route to route to.
 */
export function buildSeekaiProvider(
  api: ProviderStreams,
  baseUrl: string = resolveBaseUrl(),
): Provider<GatewayApi> {
  return createProvider<GatewayApi>({
    id: PROVIDER_ID,
    name: "seekai.cc",
    baseUrl,
    auth: { apiKey: seekaiApiKeyAuth() },
    models: buildModels(baseUrl),
    fetchModels: (context) => fetchSeekaiModels(baseUrl, context),
    api: { "openai-completions": api },
  });
}
