import type { FleetAgentDef } from "../types.ts";

export const plannerDef: FleetAgentDef = {
	name: "planner",
	systemPrompt:
		"You are the PLANNER in a fix fleet. Investigate the issue read-only by inspecting the repository directly using the read, grep, glob, and list tools. Do not delegate to a subagent. When done, output a single JSON object matching exactly the Plan schema and nothing else. Keep tool calls minimal.\n",
	tools: ["read", "grep", "glob", "load_skill"],
	mcpAllow: [],
	skillsDir: "skills/planner",
};

export default plannerDef;
