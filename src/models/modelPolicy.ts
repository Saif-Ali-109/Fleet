import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { modelDefaults } from "../fleet/modelDefaults.ts";
import { parseGeminiRateLimitModels } from "../gemini/quotaConfig.ts";
import type { ProviderName, Role, RolePolicy } from "../types.ts";
import { PROVIDER_NAMES } from "../types.ts";

// Per-provider model policy.
// The Manager is plain TypeScript (not an LLM); the 6 spawned workers call models.
// Model ids come from the SPEC §5 tier table (src/fleet/modelDefaults.ts); these
// are the offline-fallback suggestions in the dashboard picker — the picker
// prefers the provider's live /models list (GET /api/models) and falls back to
// this tier table when the provider is unreachable. Free-text entry still allows
// any id the provider supports.

const GEMINI_STRONG = modelDefaults.gemini.analyzer;
const GEMINI_FAST = modelDefaults.gemini.coder;

/** Known model ids for a provider (suggestions in the dashboard picker), derived from the SPEC §5 tier table. */
export function availableModels(provider: ProviderName): readonly string[] {
  return [...new Set(Object.values(modelDefaults[provider]))];
}

// Default per-role model mapping (bare names) per provider — single source of
// truth lives in src/fleet/modelDefaults.ts (SPEC §5 tier table).

function defaultsFor(provider: ProviderName): Record<Role, string> {
  return modelDefaults[provider];
}

// Per-role policy for a provider.
const POLICIES: Record<Role, RolePolicy> = {
  analyzer: { role: "analyzer", model: GEMINI_STRONG, fallbacks: [], variant: "low" },
  planner: { role: "planner", model: GEMINI_STRONG, fallbacks: [], variant: "low" },
  reviewer: { role: "reviewer", model: GEMINI_STRONG, fallbacks: [], variant: "low" },
  coder: { role: "coder", model: GEMINI_FAST, fallbacks: [] },
  tester: { role: "tester", model: GEMINI_FAST, fallbacks: [] },
  pr: { role: "pr", model: GEMINI_FAST, fallbacks: [] },
};

// Mutable override layer: provider → (role → bare model name), merged over POLICIES at read time.
let overrides: Partial<Record<ProviderName, Partial<Record<Role, string>>>> = {};

// Log-once latch for v1 override keys discarded during loadModelOverrides (SPEC §12/P8).
let warnedLegacyOverrideKeys = false;

// Resolution chain per SPEC D6: dashboard override beats the
// `<ROLE>_MODEL_<PROVIDER>` env var, which beats the SPEC §5 tier default,
// which beats the POLICIES baseline. An empty-string env value is treated as
// unset. Ids are provider-correct at each layer — no cross-provider prefixing.

/** Per-role policy for a provider. `provider` defaults to "gemini" (the primary path). */
export function policyFor(role: Role, provider: ProviderName = "gemini"): RolePolicy {
  const base = POLICIES[role];
  const tierDefault: string | undefined = defaultsFor(provider)[role];
  const rawEnv = process.env[`${role.toUpperCase()}_MODEL_${provider.toUpperCase()}`];
  const fromEnv = typeof rawEnv === "string" && rawEnv.length > 0 ? rawEnv : undefined;
  const chosen = overrides[provider]?.[role] ?? fromEnv ?? tierDefault ?? base.model;
  // Gemini chains come ONLY from the user-configured GEMINI_RATE_LIMIT_MODELS
  // pool (never the implicit tier default); other providers fall back to their
  // tier default when an override/env changed the primary.
  const fallbacks =
    provider === "gemini"
      ? parseGeminiRateLimitModels().filter((m) => m !== chosen)
      : chosen !== tierDefault && tierDefault
        ? [tierDefault]
        : [];
  return {
    ...base,
    model: chosen,
    fallbacks,
  };
}

export function allPolicies(providers: readonly ProviderName[] = PROVIDER_NAMES): RolePolicy[] {
  const out: RolePolicy[] = [];
  for (const provider of providers) {
    for (const role of Object.keys(POLICIES) as Role[]) {
      out.push(policyFor(role, provider));
    }
  }
  return out;
}

export function getModelOverrides(): Partial<Record<ProviderName, Partial<Record<Role, string>>>> {
  const copy: Partial<Record<ProviderName, Partial<Record<Role, string>>>> = {};
  for (const provider of PROVIDER_NAMES) {
    if (overrides[provider]) copy[provider] = { ...overrides[provider] };
  }
  return copy;
}

export function setModelOverride(role: Role, model: string, provider: ProviderName = "gemini"): void {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`Invalid model id for ${provider}`);
  }
  const existing = overrides[provider] ?? {};
  existing[role] = model;
  overrides[provider] = existing;
}

export function resetModelOverrides(): void {
  overrides = {};
}

export function saveModelOverrides(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Directory may already exist or be the cwd; writeFileSync surfaces real errors.
  }
  writeFileSync(path, JSON.stringify(overrides, null, 2) + "\n", "utf8");
}

export function loadModelOverrides(modelsJsonPath: string): void {
  if (!existsSync(modelsJsonPath)) {
    // Missing file = no user overrides yet, so write an EMPTY v2 store. Seeding
    // the SPEC §5 tier table here would put defaults into the OVERRIDE layer,
    // where they outrank the `<ROLE>_MODEL_<PROVIDER>` env vars on every later
    // boot (D6: dashboard override > env > tier default) and silently defeat
    // user env config. Defaults already live in src/fleet/modelDefaults.ts and
    // are applied as the tier-default stage of the resolution chain.
    try {
      mkdirSync(dirname(modelsJsonPath), { recursive: true });
    } catch {
      // Ignore: writeFileSync below will throw if the directory is truly unwritable.
    }
    writeFileSync(modelsJsonPath, "{}\n", "utf8");
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  overrides = {};

  // v2 store shape: provider → role → model. Keys outside PROVIDER_NAMES (v1
  // per-provider keys like gemini/openrouter/ollama, or flat role keys) are
  // discarded with a single warning.
  const legacyKeys = Object.keys(parsed).filter((key) => !(PROVIDER_NAMES as readonly string[]).includes(key));
  if (legacyKeys.length > 0 && !warnedLegacyOverrideKeys) {
    warnedLegacyOverrideKeys = true;
    console.warn(`[models] discarding legacy v1 override keys: ${legacyKeys.join(", ")}`);
  }

  for (const provider of PROVIDER_NAMES) {
    const source = parsed[provider] as Record<string, unknown> | undefined;
    if (!source) continue;
    const roleMap: Partial<Record<Role, string>> = {};
    for (const role of Object.keys(POLICIES) as Role[]) {
      const val = source[role];
      if (typeof val === "string" && val.length > 0) {
        roleMap[role] = val;
      }
    }
    if (Object.keys(roleMap).length > 0) overrides[provider] = roleMap;
  }
}