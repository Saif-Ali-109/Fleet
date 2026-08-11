/**
 * Loads the canonical agent source (agents/*.md) into a single in-memory
 * model. This is the ONLY place that reads agents/*.md — every tool adapter
 * (opencode, Claude Code, Codex, ...) consumes CanonicalConfig, never the
 * filesystem directly. Add a new tool by writing a new adapter against this
 * shape; never by adding another reader of agents/*.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

export const ROOT = join(import.meta.dirname, "..", "..");
export const AGENTS_DIR = join(ROOT, "agents");
const GLOBAL_FILE = "_global.md";

// Fixed pipeline order (analyzer -> planner -> scout -> coder -> tester ->
// reviewer -> pr), not alphabetical. Roles present on disk but absent here
// are appended alphabetically at the end.
export const ROLE_ORDER = ["analyzer", "planner", "scout", "coder", "tester", "reviewer", "pr"];

export interface ToolFlags {
  read?: boolean;
  grep?: boolean;
  glob?: boolean;
  bash?: boolean;
  list?: boolean;
  webfetch?: boolean;
  write?: boolean;
  edit?: boolean;
  patch?: boolean;
  task?: boolean;
  skill?: boolean;
}

export interface PermissionFlags {
  bash?: "allow" | "deny" | "ask";
  edit?: "allow" | "deny" | "ask";
  webfetch?: "allow" | "deny" | "ask";
  task?: "allow" | "deny" | "ask";
  skill?: "allow" | "deny" | "ask";
  external_directory?: "allow" | "deny" | "ask";
}

export interface CanonicalRole {
  role: string; // filename minus .md — the role key everywhere
  description: string;
  mode?: string;
  model?: string; // opencode-format model id (e.g. "opencode/big-pickle") — DO NOT reuse verbatim for other providers
  steps?: number;
  tools: ToolFlags;
  permission: PermissionFlags;
  prompt: string; // markdown body, trimmed — the instructions verbatim

  // Optional, tool-specific overrides. Absent unless a role file sets them.
  // These exist because a model id / reasoning-effort concept from one
  // provider is meaningless (or actively wrong) if copied to another —
  // adapters must NOT invent these from opencode's `model` field.
  codex_reasoning_effort?: "low" | "medium" | "high";
  codex_model?: string;
  claude_model?: string;
}

export interface CanonicalConfig {
  schema?: string;
  globalPermission?: Record<string, unknown>;
  roles: CanonicalRole[];
}

function loadRoleFiles(): string[] {
  const all = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md") && f !== GLOBAL_FILE);
  const roleOf = (f: string) => f.replace(/\.md$/, "");
  const known = ROLE_ORDER.filter((role) => all.includes(`${role}.md`)).map((role) => `${role}.md`);
  const unknown = all.filter((f) => !ROLE_ORDER.includes(roleOf(f))).sort();
  if (unknown.length > 0) {
    console.warn(
      `Note: role(s) not in ROLE_ORDER, appended alphabetically at the end: ${unknown.map(roleOf).join(", ")}`,
    );
  }
  return [...known, ...unknown];
}

export function loadCanonicalConfig(): CanonicalConfig {
  const globalRaw = readFileSync(join(AGENTS_DIR, GLOBAL_FILE), "utf8");
  const { data: globalFrontmatter } = matter(globalRaw);
  const { $schema, permission: globalPermission } = globalFrontmatter as Record<string, unknown>;

  const roles: CanonicalRole[] = loadRoleFiles().map((file) => {
    const role = file.replace(/\.md$/, "");
    const raw = readFileSync(join(AGENTS_DIR, file), "utf8");
    const { data, content } = matter(raw);

    if (!data.model) {
      throw new Error(`agents/${file}: missing required "model" field`);
    }
    if (!data.description) {
      throw new Error(`agents/${file}: missing required "description" field`);
    }

    return {
      role,
      description: data.description,
      mode: data.mode,
      model: data.model,
      steps: data.steps,
      tools: data.tools ?? {},
      permission: data.permission ?? {},
      prompt: content.trim(),
      codex_reasoning_effort: data.codex_reasoning_effort,
      codex_model: data.codex_model,
      claude_model: data.claude_model,
    };
  });

  return {
    schema: $schema as string | undefined,
    globalPermission: globalPermission as Record<string, unknown> | undefined,
    roles,
  };
}
