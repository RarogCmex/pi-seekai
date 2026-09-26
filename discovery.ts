/**
 * Live model discovery — the dynamic half of a semi-dynamic catalog.
 *
 * `GET /v1/models` is authenticated (no key → `401 {"message":"Invalid token"}`,
 * measured 2026-09-26), so the refresh must carry the key. It currently returns
 * exactly the 11 curated ids; this module exists so a future id the gateway adds
 * shows up without a plugin release.
 *
 * The overlay is deliberately **additive** and **unknowns-only**: known ids keep
 * their curated data (a listing does not know a model's reasoning shape), and a
 * failed or empty listing leaves the curated baseline untouched.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "./catalog.ts";
import { unknownModelToModel, type SeekaiModel } from "./models.ts";

/** `GET /v1/models` body: `{"data":[{"id":"glm-5.3-flash",…}],"object":"list","success":true}`. */
interface ModelsResponse {
  data?: { id?: unknown }[];
}

/** Pull model ids out of a `/v1/models` body. Pure so it is testable offline. */
export function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as ModelsResponse).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    ids.push(id.trim());
  }
  return [...new Set(ids)];
}

/**
 * Overlay for discovered ids the catalog does not know. Known ids are skipped so a
 * plugin update to curated data wins without waiting for a refresh; pi's merge is
 * by id and never deletes, so a removed upstream id would linger until a catalog
 * edit removes it (documented in the README).
 */
export function buildOverlay(
  ids: readonly string[],
  baseUrl: string,
  known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): SeekaiModel[] {
  return ids.filter((id) => !known.has(id)).map((id) => unknownModelToModel(id, baseUrl));
}

/** Resolve the effective key: the refresh credential first, then the env var. Both trimmed. */
export function resolveDiscoveryKey(
  context: RefreshModelsContext,
  env: (name: string) => string | undefined = (name) => process.env[name],
  envVar = "SEEKAI_API_KEY",
): string | undefined {
  const fromCredential =
    context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
  if (fromCredential) return fromCredential;
  const fromEnv = env(envVar)?.trim();
  return fromEnv || undefined;
}

/**
 * `fetchModels` implementation. Never throws: returning `[]` leaves the curated
 * baseline (and any previously persisted overlay) untouched, so an offline start
 * degrades to "static catalog" instead of "broken provider".
 */
export async function fetchSeekaiModels(
  baseUrl: string,
  context: RefreshModelsContext,
  timeoutMs = 8_000,
): Promise<SeekaiModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return [];

  const key = resolveDiscoveryKey(context);
  if (!key) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const ids = parseModelIds(await response.json());
    return buildOverlay(ids, baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
