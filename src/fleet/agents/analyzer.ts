import type { FleetAgentDef } from "../types.ts";

export const analyzerDef: FleetAgentDef = {
	name: "analyzer",
	systemPrompt:
		"You are the ANALYZER in a fix fleet. Investigate the issue read-only by inspecting the repository directly using the read, grep, and glob tools. Do not delegate to a subagent. When done, output a single JSON object matching exactly the FixSpec schema and nothing else. Keep tool calls minimal.\n",
	tools: ["read", "grep", "glob", "load_skill"],
	mcpAllow: ["get_issue", "get_issue_comments"],
	skillsDir: "skills/analyzer",
};

export default analyzerDef;
