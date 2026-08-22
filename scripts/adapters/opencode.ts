/**
 * opencode adapter.
 *
 * Emits a single .fleet/opencode.json with all roles inline under `agent`.
 * This MUST stay inline (not split into per-role agent files) because the
 * Manager spawns workers with `--dir <worktree>` pointing at an isolated git
 * worktree, and relies on OPENCODE_CONFIG to point back at this file so
 * agent discovery still works from inside that foreign directory. A
 * directory-based agent/ layout would only be discovered relative to --dir,
 * breaking that. See README.md "Config" section.
 */

import { join } from "node:path";
import type { CanonicalConfig } from "../lib/canonical.js";
import type { Adapter, GeneratedFile } from "../lib/adapter.js";
import { ROOT } from "../lib/canonical.js";

/**
 * Committed SOR plugin source (NOT generated) at `.fleet/opencode/plugins/sor-hook.ts`.
 * opencode resolves path-like plugin entries relative to the config file that
 * declares them, so with the config emitted at `.fleet/opencode.json` this
 * entry is `.fleet/opencode/plugins/sor-hook.ts` relative to `.fleet/` — i.e.
 * `./opencode/plugins/sor-hook.ts`. It still resolves correctly when a worker
 * in a foreign worktree loads this opencode.json via OPENCODE_CONFIG.
 */
export const SOR_HOOK_PLUGIN = "./opencode/plugins/sor-hook.ts";

export const opencodeAdapter: Adapter = (config: CanonicalConfig): GeneratedFile[] => {
  const agent: Record<string, unknown> = {};
  for (const r of config.roles) {
    agent[r.role] = {
      description: r.description,
      mode: r.mode,
      model: r.model,
      steps: r.steps,
      tools: r.tools,
      permission: r.permission,
      prompt: r.prompt,
    };
  }

  const out = {
    ...(config.schema ? { $schema: config.schema } : {}),
    agent,
    ...(config.globalPermission ? { permission: config.globalPermission } : {}),
    ...(config.tool_output ? { tool_output: config.tool_output } : {}),
    plugin: [SOR_HOOK_PLUGIN],
  };

  return [
    {
      path: join(ROOT, ".fleet", "opencode.json"),
      contents: JSON.stringify(out, null, 2) + "\n",
    },
  ];
};
