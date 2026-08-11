import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Backend, Role, RolePolicy } from "../types.js";

// Per-backend model policy.
// The Manager is plain TypeScript (not an LLM); the 6 spawned workers call models.
// opencode runs on the free OpenCode Zen pool; claude/codex use curated catalogs
// (their CLIs expose no `models list` command to enumerate at runtime — verified
// against claude 2.1.201 and codex 0.147.0). The dashboard offers these catalog
// ids as suggestions with free-text entry, so a user can pick any id their
// subscription supports.

// ---- opencode ----
const BIG = "opencode/deepseek-v4-flash-free";
const LAGUNA = "opencode/laguna-s-2.1-free";

// Free fallback pool (verified present in `opencode models`).
const OPENCODE_FALLBACKS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/north-mini-code-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
] as const;

// Free OpenCode model ids, as bare names (the form used in models.json and by `opencode models`).
export const FREE_OPCODE_MODELS: readonly string[] = Object.freeze([
  "deepseek-v4-flash-free",
  "laguna-s-2.1-free",
  "ling-3.0-tiny-free",
  "longcat-2.0-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

// ---- claude code ----
// Curated catalog (aliases Claude Code accepts via --model). Not exhaustive;
// the dashboard's free-text input lets users type any supported id.
export const CLAUDE_MODELS: readonly string[] = Object.freeze([
  "opus",
  "sonnet",
  "fable",
  "haiku",
  "claude-fable-5",
  "claude-sonnet-4-5",
  "claude-3-7-sonnet",
  "claude-opus-4",
  "claude-haiku-4-5",
]);

// ---- codex ----
export const CODEX_MODELS: readonly string[] = Object.freeze([
  "gpt-5.4-codex",
  "gpt-5.1-codex",
  "gpt-5.2-codex",
  "gpt-5-codex",
  "gpt-5.1-mini",
  "gpt-5-mini",
  "o3",
  "o4-mini",
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
  analyzer: "deepseek-v4-flash-free",
  planner: "deepseek-v4-flash-free",
  coder: "laguna-s-2.1-free",
  tester: "laguna-s-2.1-free",
  reviewer: "deepseek-v4-flash-free",
  pr: "laguna-s-2.1-free",
};

// Default models for claude + codex backends (the "use any sensible default" choice).
// Reasoning-heavy roles get a frontier model; building roles get a solid builder.
const CLAUDE_DEFAULTS: Record<Role, string> = {
  analyzer: "sonnet",
  planner: "sonnet",
  coder: "sonnet",
  tester: "sonnet",
  reviewer: "sonnet",
  pr: "sonnet",
};

const CODEX_DEFAULTS: Record<Role, string> = {
  analyzer: "gpt-5.1-codex",
  planner: "gpt-5.1-codex",
  coder: "gpt-5.1-codex",
  tester: "gpt-5.1-codex",
  reviewer: "gpt-5.1-codex",
  pr: "gpt-5.1-codex",
};

const POLICIES: Record<Role, RolePolicy> = {
  analyzer: { role: "analyzer", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "medium" },
  planner: { role: "planner", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "medium" },
  reviewer: { role: "reviewer", model: BIG, fallbacks: [...OPENCODE_FALLBACKS], variant: "medium" },
  coder: { role: "coder", model: LAGUNA, fallbacks: [...OPENCODE_FALLBACKS] },
  tester: { role: "tester", model: LAGUNA, fallbacks: [...OPENCODE_FALLBACKS] },
  pr: { role: "pr", model: LAGUNA, fallbacks: [...OPENCODE_FALLBACKS] },
};

// Mutable override layer: backend → (role → bare model name), merged over POLICIES at read time.
let overrides: Partial<Record<Backend, Partial<Record<Role, string>>>> = {};

// opencode's `-m` requires the `provider/model` form. POLICIES store prefixed ids while
// overrides/models.json store bare ids; normalize for opencode so runWorker always gets a
// valid `-m` argument. claude/codex accept bare ids via their own --model flags.
function normalizeModel(backend: Backend, name: string): string {
  if (backend === "opencode") {
    return name.startsWith("opencode/") ? name : `opencode/${name}`;
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
  if (backend === "opencode" && !FREE_OPCODE_MODELS.includes(model)) {
    throw new Error(
      `Invalid model "${model}" for opencode. Must be one of: ${FREE_OPCODE_MODELS.join(", ")}`,
    );
  }
  if (backend === "claude" && !CLAUDE_MODELS.includes(model)) {
    throw new Error(
      `Invalid model "${model}" for claude. Must be one of: ${CLAUDE_MODELS.join(", ")}`,
    );
  }
  if (backend === "codex" && !CODEX_MODELS.includes(model)) {
    throw new Error(
      `Invalid model "${model}" for codex. Must be one of: ${CODEX_MODELS.join(", ")}`,
    );
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