import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Backend, Role, RolePolicy } from "../types.ts";

// Per-backend model policy.
// The Manager is plain TypeScript (not an LLM); the 6 spawned workers call models.
// opencode runs on the free OpenCode Zen pool; claude/codex use curated catalogs
// (their CLIs expose no `models list` command to enumerate at runtime — verified
// against claude 2.1.201 and codex 0.147.0). The dashboard offers these catalog
// ids as suggestions with free-text entry, so a user can pick any id their
// subscription supports.

// ---- opencode ----
const BIG = "opencode/x-preview-f-free";
const MIMO = "opencode/mimo-v2.5-free";

// Free fallback pool (verified present in `opencode models`).
const OPENCODE_FALLBACKS = [
  "opencode/x-preview-f-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
] as const;

// Free OpenCode model ids, as bare names (the form used in models.json and by `opencode models`).
export const FREE_OPCODE_MODELS: readonly string[] = Object.freeze([
  "hy3-free",
  "mimo-v2.5-free",
  "muse-spark-1.2-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "x-preview-f-free",
]);

// ---- claude code ----
// Curated catalog of OpenRouter free-tier claude model IDs (provider/model format).
// The dashboard's free-text input lets users type any supported id.
export const CLAUDE_MODELS: readonly string[] = Object.freeze([
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.5-sonnet-20241022",
  "anthropic/claude-3-opus",
  "anthropic/claude-3-haiku",
  "anthropic/claude-3.5-haiku",
]);

// ---- codex ----
// Curated catalog of OpenRouter free-tier codex/coding model IDs (provider/model format).
// The dashboard's free-text input lets users type any supported id.
export const CODEX_MODELS: readonly string[] = Object.freeze([
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "openai/gpt-4.1-mini",
  "google/gemini-2.0-flash",
  "google/gemini-2.5-flash",
  "meta-llama/llama-3.1-405b-instruct",
  "mistralai/codestral-2501",
]);

export const BACKENDS: readonly Backend[] = Object.freeze(["opencode", "claude", "codex"]);

/** Curated model-id catalog for a backend (suggestions in the dashboard picker). */
export function availableModels(backend: Backend): readonly string[] {
  switch (backend) {
    case "opencode":
      return FREE_OPCODE_MODELS;
    case "claude":
      return CLAUDE_MODELS;
    case "codex":
      return CODEX_MODELS;
  }
}

// Default per-role model mapping (bare names) per backend — mirrors agents/*.md
// frontmatter and self-seeds modelPolicyDefaults.
const DEFAULT_OVERRIDES: Record<Role, string> = {
  analyzer: "x-preview-f-free",
  planner: "x-preview-f-free",
  coder: "mimo-v2.5-free",
  tester: "mimo-v2.5-free",
  reviewer: "x-preview-f-free",
  pr: "mimo-v2.5-free",
};

// Default models for claude + codex backends (the "use any sensible default" choice).
// Reasoning-heavy roles get a frontier model; building roles get a solid builder.
const CLAUDE_DEFAULTS: Record<Role, string> = {
  analyzer: "anthropic/claude-3.5-sonnet",
  planner: "anthropic/claude-3.5-sonnet",
  coder: "anthropic/claude-3.5-sonnet",
  tester: "anthropic/claude-3.5-sonnet",
  reviewer: "anthropic/claude-3.5-sonnet",
  pr: "anthropic/claude-3.5-sonnet",
};

const CODEX_DEFAULTS: Record<Role, string> = {
  analyzer: "openai/gpt-4o-mini",
  planner: "openai/gpt-4o-mini",
  coder: "openai/gpt-4o-mini",
  tester: "openai/gpt-4o-mini",
  reviewer: "openai/gpt-4o-mini",
  pr: "openai/gpt-4o-mini",
};

const POLICIES: Record<Role, RolePolicy> = {
  analyzer: { role: "analyzer", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "low" },
  planner: { role: "planner", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "low" },
  reviewer: { role: "reviewer", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "low" },
  coder: { role: "coder", model: MIMO, fallbacks: [...OPENCODE_FALLBACKS] },
  tester: { role: "tester", model: MIMO, fallbacks: [...OPENCODE_FALLBACKS] },
  pr: { role: "pr", model: MIMO, fallbacks: [...OPENCODE_FALLBACKS] },
};

// Mutable override layer: backend → (role → bare model name), merged over POLICIES at read time.
let overrides: Partial<Record<Backend, Partial<Record<Role, string>>>> = {};

// opencode's `-m` requires the `provider/model` form. POLICIES store prefixed ids while
// overrides/models.json store bare ids; normalize for opencode so runWorker always gets a
// valid `-m` argument. claude/codex accept bare ids via their own --model flags.
// OpenRouter models have format "provider/model" (e.g., "nvidia/nemotron-3-ultra-550b-a55b")
// and need "openrouter/" prefix. Native opencode models are bare names and need "opencode/" prefix.
function normalizeModel(backend: Backend, name: string): string {
  if (backend === "opencode") {
    if (name.startsWith("opencode/") || name.startsWith("openrouter/")) {
      return name;
    }
    return name.includes("/") ? `openrouter/${name}` : `opencode/${name}`;
  }
  return name;
}

function defaultsFor(backend: Backend): Record<Role, string> {
  switch (backend) {
    case "opencode":
      return DEFAULT_OVERRIDES;
    case "claude":
      return CLAUDE_DEFAULTS;
    case "codex":
      return CODEX_DEFAULTS;
  }
}

/** Per-role policy for a backend. `backend` defaults to "opencode" (backward compatible). */
export function policyFor(role: Role, backend: Backend = "opencode"): RolePolicy {
  const base = POLICIES[role];
  const chosen = overrides[backend]?.[role] ?? defaultsFor(backend)[role] ?? base.model;
  return {
    ...base,
    model: normalizeModel(backend, chosen),
    fallbacks:
      backend === "opencode"
        ? [...OPENCODE_FALLBACKS]
        : [normalizeModel(backend, defaultsFor(backend)[role])],
  };
}

export function allPolicies(backends: readonly Backend[] = BACKENDS): RolePolicy[] {
  const out: RolePolicy[] = [];
  for (const backend of backends) {
    for (const role of Object.keys(POLICIES) as Role[]) {
      out.push(policyFor(role, backend));
    }
  }
  return out;
}

export function getModelOverrides(): Partial<Record<Backend, Partial<Record<Role, string>>>> {
  const copy: Partial<Record<Backend, Partial<Record<Role, string>>>> = {};
  for (const backend of BACKENDS) {
    if (overrides[backend]) copy[backend] = { ...overrides[backend] };
  }
  return copy;
}

export function setModelOverride(role: Role, model: string, backend: Backend = "opencode"): void {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`Invalid model id for ${backend}`);
  }
  const existing = overrides[backend] ?? {};
  existing[role] = model;
  overrides[backend] = existing;
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
    // Self-seed: write per-backend defaults so the feature works out of the box.
    const seed: Record<Backend, Record<Role, string>> = {
      opencode: DEFAULT_OVERRIDES,
      claude: CLAUDE_DEFAULTS,
      codex: CODEX_DEFAULTS,
    };
    try {
      mkdirSync(dirname(modelsJsonPath), { recursive: true });
    } catch {
      // Ignore: writeFileSync below will throw if the directory is truly unwritable.
    }
    writeFileSync(modelsJsonPath, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  overrides = {};

  // Old flat shape: {analyzer: "..."} → treat as opencode.
  const flatKeys = Object.keys(parsed).filter((k) => (DEFAULT_OVERRIDES as Record<string, unknown>)[k] !== undefined);
  const isFlat = flatKeys.length > 0 && BACKENDS.every((b) => typeof parsed[b] !== "object");

  for (const backend of BACKENDS) {
    const source: Record<string, unknown> | undefined = isFlat
      ? (parsed as Record<string, unknown>)
      : (parsed[backend] as Record<string, unknown> | undefined);
    if (!source) continue;
    const roleMap: Partial<Record<Role, string>> = {};
    for (const role of Object.keys(DEFAULT_OVERRIDES) as Role[]) {
      const val = source[role];
      if (typeof val === "string" && val.length > 0) {
        roleMap[role] = val;
      }
    }
    if (Object.keys(roleMap).length > 0) overrides[backend] = roleMap;
  }
}