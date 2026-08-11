/**
 * opencode adapter.
 *
 * Emits a single opencode.json with all roles inline under `agent`. This
 * MUST stay inline (not split into .opencode/agent/*.md files) because the
 * Manager spawns workers with `--dir <worktree>` pointing at an isolated git
 * worktree, and relies on OPENCODE_CONFIG to point back at this file so
 * agent discovery still works from inside that foreign directory. A
 * directory-based .opencode/agent/ layout would only be discovered relative
 * to --dir, breaking that. See README.md "Config" section.
 */

import { join } from "node:path";
import type { CanonicalConfig } from "../lib/canonical.js";
import type { Adapter, GeneratedFile } from "../lib/adapter.js";
import { ROOT } from "../lib/canonical.js";

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
  };

  return [
    {
      path: join(ROOT, "opencode.json"),
      contents: JSON.stringify(out, null, 2) + "\n",
    },
  ];
};
