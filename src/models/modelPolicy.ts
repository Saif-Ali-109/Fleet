import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Role, RolePolicy } from "../types.js";

// Model policy (user directive 2026-08-09):
//   deepseek-v4-flash-free → reasoning-heavy roles (analyzer, planner, reviewer) — swapped from big-pickle to cut tokens and bypass the free-pool capacity bottleneck
//   laguna-s-2.1-free       → building roles (coder, tester, pr)
// Fallbacks are other free OpenCode Zen models, tried in order on 5xx/quota/empty output.

const BIG = "opencode/deepseek-v4-flash-free";
const LAGUNA = "opencode/laguna-s-2.1-free";

// Free fallback pool (verified present in `opencode models`).
const FREE_FALLBACKS = [
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

// Default per-role model mapping (bare names) — mirrors models.json and self-seeds the file.
const DEFAULT_OVERRIDES: Record<Role, string> = {
  analyzer: "deepseek-v4-flash-free",
  planner: "deepseek-v4-flash-free",
  coder: "laguna-s-2.1-free",
  tester: "laguna-s-2.1-free",
  reviewer: "deepseek-v4-flash-free",
  pr: "laguna-s-2.1-free",
};

const POLICIES: Record<Role, RolePolicy> = {
  analyzer: { role: "analyzer", model: BIG, fallbacks: [...FREE_FALLBACKS], variant: "medium" },
  planner: { role: "planner", model: BIG, fallbacks: [...FREE_FALLBACKS], variant: "medium" },
  reviewer: { role: "reviewer", model: BIG, fallbacks: [...FREE_FALLBACKS], variant: "medium" },
  coder: { role: "coder", model: LAGUNA, fallbacks: [...FREE_FALLBACKS] },
  tester: { role: "tester", model: LAGUNA, fallbacks: [...FREE_FALLBACKS] },
  pr: { role: "pr", model: LAGUNA, fallbacks: [...FREE_FALLBACKS] },
};

// Mutable override layer: bare model names keyed by role, merged over POLICIES at read time.
let overrides: Partial<Record<Role, string>> = {};

// opencode's `-m` requires the `provider/model` form (see opencode CLI/docs). `POLICIES` stores
// prefixed ids while `overrides`/`models.json` store bare ids; normalize here so policyFor always
// yields a valid OpenCode model argument (runWorker passes `-m policy.model`).
function normalizeModel(name: string): string {
  return name.startsWith("opencode/") ? name : `opencode/${name}`;
}

export function policyFor(role: Role): RolePolicy {
  const base = POLICIES[role];
  return { ...base, model: normalizeModel(overrides[role] ?? base.model) };
}

export function allPolicies(): RolePolicy[] {
  return (Object.keys(POLICIES) as Role[]).map((role) => policyFor(role));
}

export function getModelOverrides(): Partial<Record<Role, string>> {
  return { ...overrides };
}

export function setModelOverride(role: Role, model: string): void {
  if (!FREE_OPCODE_MODELS.includes(model)) {
    throw new Error(
      `Invalid model "${model}". Must be one of: ${FREE_OPCODE_MODELS.join(", ")}`,
    );
  }
  overrides[role] = model;
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
    // Self-seed: create the file with current defaults so the feature works out of the box.
    try {
      mkdirSync(dirname(modelsJsonPath), { recursive: true });
    } catch {
      // Ignore: writeFileSync below will throw if the directory is truly unwritable.
    }
    writeFileSync(modelsJsonPath, JSON.stringify(DEFAULT_OVERRIDES, null, 2) + "\n", "utf8");
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  overrides = {};
  for (const role of Object.keys(DEFAULT_OVERRIDES) as Role[]) {
    const val = parsed[role];
    if (typeof val === "string" && val.length > 0) {
      overrides[role] = val;
    }
  }
}
