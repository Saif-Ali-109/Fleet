/**
 * Claude Code adapter.
 *
 * Emits .claude/agents/<role>.md — Claude Code's native custom-subagent
 * format: YAML frontmatter (name, description, tools, optional model) plus
 * the prompt as the markdown body.
 *
 * Deliberately dropped, because Claude Code's subagent format has no
 * equivalent concept:
 *   - `mode`, `steps` — opencode-specific (headless step budget).
 *   - `permission` (allow/deny/ask) — opencode enforces this on the tool
 *     layer for an unattended process. Claude Code subagents run with a
 *     human present; its `tools:` list is a capability grant, not a hard
 *     permission gate, so folding opencode's deny-list into it would imply
 *     a guarantee Claude Code doesn't make.
 * `model` is only emitted if the role sets an explicit `claude_model` in its
 * frontmatter — opencode's `model` field (e.g. "opencode/big-pickle") is a
 * different provider's model id and would be silently wrong here.
 */

import { join } from "node:path";
import type { CanonicalConfig, CanonicalRole, ToolFlags } from "../lib/canonical.js";
import type { Adapter, GeneratedFile } from "../lib/adapter.js";
import { ROOT } from "../lib/canonical.js";
import { emitClaudeSettingsHooks, emitSorHookScript } from "../lib/hooks.js";

// opencode tool flag -> Claude Code tool name. "list" and "patch" have no
// direct Claude Code equivalent (Claude Code's Glob covers directory
// listing; Edit covers patch-style changes), so they map onto the closest
// existing tool rather than being dropped silently.
const TOOL_MAP: Record<keyof ToolFlags, string> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  bash: "Bash",
  list: "Glob",
  webfetch: "WebFetch",
  write: "Write",
  edit: "Edit",
  patch: "Edit",
  task: "Task",
  skill: "Skill",
};

function toClaudeTools(tools: ToolFlags): string {
  const names = new Set<string>();
  for (const [flag, enabled] of Object.entries(tools) as [keyof ToolFlags, boolean | undefined][]) {
    if (enabled && TOOL_MAP[flag]) names.add(TOOL_MAP[flag]);
  }
  return [...names].join(", ");
}

function renderFrontmatter(r: CanonicalRole): string {
  const lines = [`name: ${r.role}`, `description: ${JSON.stringify(r.description)}`];
  const tools = toClaudeTools(r.tools);
  if (tools) lines.push(`tools: ${tools}`);
  if (r.claude_model) lines.push(`model: ${r.claude_model}`);
  return lines.join("\n");
}

/**
 * Embeds the hooks map from emitClaudeSettingsHooks() (an indented JSON object
 * starting/ending with braces) under the top-level "hooks" key of
 * `.claude/settings.json`, re-indenting the body by two spaces.
 */
function embedHooks(hooksJson: string): string {
  const body = hooksJson
    .split("\n")
    .slice(1, -1)
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
  return `{\n  "hooks": {\n${body}\n  }\n}\n`;
}

export const claudeCodeAdapter: Adapter = (config: CanonicalConfig): GeneratedFile[] => {
  return [
    ...config.roles.map((r) => ({
      path: join(ROOT, ".claude", "agents", `${r.role}.md`),
      contents: `---\n${renderFrontmatter(r)}\n---\n${r.prompt}\n`,
    })),
    {
      path: join(ROOT, ".claude", "settings.json"),
      contents: embedHooks(emitClaudeSettingsHooks()),
    },
    {
      path: join(ROOT, ".claude", "hooks", "sor-hook.sh"),
      contents: emitSorHookScript(),
    },
  ];
};
