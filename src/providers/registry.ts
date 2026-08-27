// Provider registry spec as per SPEC.md section 4.
// Manager-side support code: definitions, memoized OpenAI-compatible clients,
// fleet ordering, and the fallback walk. No model calls are made here except
// through the returned clients (worker-side usage).

import OpenAI from "openai";
import { PROVIDER_NAMES, type ProviderName, type Role } from "../types.ts";

export type { ProviderName };

export interface ProviderDef {
  name: ProviderName;
  baseURL: string;
  // gemini:     https://generativelanguage.googleapis.com/v1beta/openai/
  // openrouter: https://openrouter.ai/api/v1
  // ollama:     process.env.OLLAMA_BASE_URL ?? http://localhost:11434/v1
  apiKeyEnv: string | null;   // GEMINI_API_KEY / OPENROUTER_API_KEY / null (ollama)
}

const DEFAULT_FLEET_PROVIDERS: readonly ProviderName[] = ["gemini", "openrouter", "ollama"];

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/Saif-Ali-109/fleet",
  "X-Title": "Fleet",
} as const;

const providerDefs: Record<ProviderName, ProviderDef> = {
  gemini: {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  openrouter: {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  ollama: {
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    apiKeyEnv: null,
  },
};

/**
 * Returns the provider definition for the given provider name.
 */
export function getProviderDef(name: ProviderName): ProviderDef {
  return providerDefs[name];
}

/** Raw env value of the provider's required key (undefined for ollama or when unset). */
export function getApiKeyForProvider(name: ProviderName): string | undefined {
  const def = getProviderDef(name);
  if (!def.apiKeyEnv) return undefined; // ollama
  return process.env[def.apiKeyEnv];
}

// One OpenAI client per provider, created lazily and memoized.
const clientCache = new Map<ProviderName, OpenAI>();

/** Memoized `new OpenAI({ baseURL, apiKey })` per provider. */
export function getClientForProvider(name: ProviderName): OpenAI {
  const cached = clientCache.get(name);
  if (cached) return cached;
  const def = getProviderDef(name);
  const client = new OpenAI({
    baseURL: def.baseURL,
    apiKey: def.apiKeyEnv ? (getApiKeyForProvider(name) ?? "") : "ollama",
    maxRetries: 0,
    ...(name === "openrouter" ? { defaultHeaders: { ...OPENROUTER_HEADERS } } : {}),
  });
  clientCache.set(name, client);
  return client;
}

/**
 * Drop every memoized provider client so the next getClientForProvider call
 * rebuilds from the CURRENT process.env keys (SPEC §11.5 key-change resume).
 */
export function invalidateProviderClients(): void {
  clientCache.clear();
}

/**
 * FLEET_PROVIDERS env parsing: comma-separated subset/order of provider names.
 * Invalid names are skipped with a warning; unset/empty falls back to the
 * default order "gemini,openrouter,ollama". Duplicates are dropped.
 */
export function getFleetProviders(): ProviderName[] {
  const raw = process.env.FLEET_PROVIDERS?.trim();
  if (!raw) return [...DEFAULT_FLEET_PROVIDERS];
  const out: ProviderName[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    const known = PROVIDER_NAMES.find((p) => p === name);
    if (!known) {
      console.warn(`[providers] FLEET_PROVIDERS: skipping unknown provider "${name}"`);
      continue;
    }
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

/** True when the provider's required key is present (ollama always qualifies). */
export function hasProviderKey(name: ProviderName): boolean {
  const def = getProviderDef(name);
  return !def.apiKeyEnv || Boolean(process.env[def.apiKeyEnv]);
}

/** Filter a provider list down to those whose required key is present. */
export function providersWithKeys(
  providers: readonly ProviderName[] = getFleetProviders(),
): ProviderName[] {
  return providers.filter(hasProviderKey);
}

export interface FleetAttempt {
  /** null on the synthetic fail-fast entry emitted when no provider has keys. */
  provider: ProviderName | null;
  model: string;
  ok: boolean;
  error?: string;
}

export interface ProviderAttemptOutcome<T> {
  model: string;
  ok: boolean;
  value?: T;
  error?: string;
  stopFallback?: boolean;
}

export type ProviderAttempt<T> = (provider: ProviderName) => Promise<ProviderAttemptOutcome<T>>;

export interface FallbackResult<T> {
  ok: boolean;
  /** Provider whose attempt succeeded (or last tried); null only on no-keys fail-fast. */
  provider: ProviderName | null;
  model: string;
  value?: T;
  error?: string;
  attempts: FleetAttempt[];
}

/**
 * Walk the fleet left→right, calling `attempt(provider)` once per candidate.
 * Providers with missing keys are skipped before any call; runtime failures
 * advance the walk; total failure returns a failed result with every attempt.
 * With zero keyed providers this fails fast with `{model:"none", ok:false}`.
 */
export async function withProviderFallback<T>(
  role: Role,
  attempt: ProviderAttempt<T>,
  providerList?: readonly ProviderName[],
): Promise<FallbackResult<T>> {
  const explicitProviders = providerList !== undefined;
  const configured = providerList ?? getFleetProviders();
  const candidates = providersWithKeys(configured);
  if (candidates.length === 0) {
    const error = explicitProviders && configured.length === 1
      ? `selected provider "${configured[0]}" has no key configured`
      : "no provider keys configured";
    return {
      ok: false,
      provider: null,
      model: "none",
      error,
      attempts: [{ provider: null, model: "none", ok: false, error }],
    };
  }
  const attempts: FleetAttempt[] = [];
  let lastProvider: ProviderName | null = null;
  let lastModel = "none";
  let lastError: string | undefined;
  for (const provider of candidates) {
    try {
      const outcome = await attempt(provider);
      lastProvider = provider;
      lastModel = outcome.model;
      if (outcome.ok) {
        attempts.push({ provider, model: outcome.model, ok: true });
        return { ok: true, provider, model: outcome.model, value: outcome.value, attempts };
      }
      lastError = outcome.error ?? "attempt failed";
      attempts.push({ provider, model: outcome.model, ok: false, error: lastError });
      if (outcome.stopFallback) break;
    } catch (err) {
      lastProvider = provider;
      lastError = err instanceof Error ? err.message : String(err);
      attempts.push({ provider, model: "unknown", ok: false, error: lastError });
    }
  }
  return {
    ok: false,
    provider: lastProvider,
    model: lastModel,
    error: lastError ?? `all providers failed for ${role}`,
    attempts,
  };
}

/** Live model ids via GET {baseURL}/models; [] on any error. */
export async function listModelsForProvider(name: ProviderName): Promise<string[]> {
  try {
    const client = getClientForProvider(name);
    const ids: string[] = [];
    for await (const model of client.models.list()) {
      if (model?.id) ids.push(model.id);
    }
    return ids;
  } catch {
    return [];
  }
}

export default providerDefs;
