import type { FleetAgentDef, ToolName } from "../types.ts";
import type { ToolImpl } from "./common.ts";
import { bashTool } from "./bash.ts";
import { editTool, readTool, writeTool } from "./files.ts";
import { globTool, grepTool } from "./search.ts";
import { loadSkillTool } from "./skill.ts";

export type {
  ToolImpl,
  ToolResult,
  ToolSchema,
  WtCtx,
} from "./common.ts";

export const BUILTIN_TOOLS: readonly ToolName[] = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "load_skill",
];

const IMPLS: Record<ToolName, ToolImpl> = {
  bash: bashTool,
  read: readTool,
  write: writeTool,
  edit: editTool,
  grep: grepTool,
  glob: globTool,
  load_skill: loadSkillTool,
};

export function buildRegistry(def: FleetAgentDef): Partial<Record<ToolName, ToolImpl>> {
  const registry: Partial<Record<ToolName, ToolImpl>> = {};
  for (const name of def.tools) {
    if ((BUILTIN_TOOLS as readonly string[]).includes(name)) {
      registry[name] = IMPLS[name];
    }
  }
  return registry;
}
