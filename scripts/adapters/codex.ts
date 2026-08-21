/**
 * Codex CLI adapter.
 *
 * Emits .fleet/codex/agents/<role>.toml — Codex's custom-agent format (TOML, not
 * markdown+frontmatter). Fields: name, description, developer_instructions
 * (= the prompt), sandbox_mode, and optionally model / model_reasoning_effort.
 *
 * `model` is only emitted if the role sets an explicit `codex_model` — never
 * derived from opencode's `model` field, which names an opencode-provider
 * model id (e.g. "opencode/big-pickle") meaningless to Codex.
 * `model_reasoning_effort` is only emitted if the role sets
 * `codex_reasoning_effort` explicitly (currently: analyzer, planner,
 * reviewer — the reasoning-heavy roles per README).
 *
 * sandbox_mode is derived from the canonical tools/permission flags: a role
 * with no bash/write/edit/patch access maps to "read-only"; anything else
 * maps to "workspace-write". There is no finer-grained equivalent of
 * opencode's per-tool allow/deny in Codex's sandbox model.
 */

import { join } from "node:path";
import type { CanonicalConfig, CanonicalRole } from "../lib/canonical.js";
import type { Adapter, GeneratedFile } from "../lib/adapter.js";
import { ROOT } from "../lib/canonical.js";
import { emitCodexConfigHooks, emitSorHookScript } from "../lib/hooks.js";

function tomlString(value: string): string {
  return JSON.stringify(value); // close enough for TOML basic strings on ASCII text
}

function tomlMultiline(value: string): string {
  const safe = value.replace(/"""/g, '\\"\\"\\"');
  return `"""\n${safe}\n"""`;
}

function sandboxMode(r: CanonicalRole): "read-only" | "workspace-write" {
  const t = r.tools;
  const canMutate = Boolean(t.bash || t.write || t.edit || t.patch);
  return canMutate ? "workspace-write" : "read-only";
}

function renderToml(r: CanonicalRole): string {
  const lines = [`name = ${tomlString(r.role)}`, `description = ${tomlString(r.description)}`];
  if (r.codex_model) lines.push(`model = ${tomlString(r.codex_model)}`);
  if (r.codex_reasoning_effort) lines.push(`model_reasoning_effort = ${tomlString(r.codex_reasoning_effort)}`);
  lines.push(`sandbox_mode = ${tomlString(sandboxMode(r))}`);
  lines.push(`developer_instructions = ${tomlMultiline(r.prompt)}`);
  return lines.join("\n") + "\n";
}

export const codexAdapter: Adapter = (config: CanonicalConfig): GeneratedFile[] => {
  return [
    ...config.roles.map((r) => ({
      path: join(ROOT, ".fleet", "codex", "agents", `${r.role}.toml`),
      contents: renderToml(r),
    })),
    // The SOR hooks live in .fleet/codex/config.toml (the only config.toml this
    // adapter emits). emitCodexConfigHooks() is self-contained today; if a
    // future adapter emits additional config.toml sections, merge them here
    // rather than replacing the file.
    {
      path: join(ROOT, ".fleet", "codex", "config.toml"),
      contents: emitCodexConfigHooks(),
    },
    {
      path: join(ROOT, ".fleet", "codex", "hooks", "sor-hook.sh"),
      contents: emitSorHookScript(),
    },
  ];
};
