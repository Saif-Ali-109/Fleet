import type { Role } from "../types.ts";

export type ToolName =
	| "bash"
	| "read"
	| "write"
	| "edit"
	| "grep"
	| "glob"
	| "load_skill";

export interface FleetAgentDef {
	name: Role;
	systemPrompt: string;
	tools: ToolName[];
	mcpAllow: string[];
	skillsDir: string;
}
