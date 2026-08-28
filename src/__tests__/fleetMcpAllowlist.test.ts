import { describe, expect, it } from "vitest";
import { analyzerDef } from "../fleet/agents/analyzer.ts";
import { coderDef } from "../fleet/agents/coder.ts";
import { plannerDef } from "../fleet/agents/planner.ts";
import { prDef } from "../fleet/agents/pr.ts";
import { reviewerDef } from "../fleet/agents/reviewer.ts";
import { testerDef } from "../fleet/agents/tester.ts";
import type { FleetAgentDef } from "../fleet/types.ts";
import {
	ALLOWED_TOOLS_PER_ROLE,
	handleToolCall,
	isToolAllowedForRole,
} from "../mcp/fleetServer.ts";

const DEFS: Array<[string, FleetAgentDef]> = [
	["analyzer", analyzerDef],
	["planner", plannerDef],
	["coder", coderDef],
	["tester", testerDef],
	["reviewer", reviewerDef],
	["pr", prDef],
];

describe("MCP allowlist matrix — server-side isToolAllowedForRole", () => {
	it("analyzer role allows get_issue and get_issue_comments", () => {
		expect(isToolAllowedForRole("analyzer", "get_issue")).toBe(true);
		expect(isToolAllowedForRole("analyzer", "get_issue_comments")).toBe(true);
	});

	it("analyzer role rejects create_pr and get_checks", () => {
		expect(isToolAllowedForRole("analyzer", "create_pr")).toBe(false);
		expect(isToolAllowedForRole("analyzer", "get_checks")).toBe(false);
	});

	it("pr role allows create_pr and get_checks", () => {
		expect(isToolAllowedForRole("pr", "create_pr")).toBe(true);
		expect(isToolAllowedForRole("pr", "get_checks")).toBe(true);
	});

	it("pr role rejects get_issue and get_issue_comments", () => {
		expect(isToolAllowedForRole("pr", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("pr", "get_issue_comments")).toBe(false);
	});

	it("planner role rejects all tools", () => {
		expect(isToolAllowedForRole("planner", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("planner", "get_issue_comments")).toBe(false);
		expect(isToolAllowedForRole("planner", "create_pr")).toBe(false);
		expect(isToolAllowedForRole("planner", "get_checks")).toBe(false);
	});

	it("coder role rejects all tools", () => {
		expect(isToolAllowedForRole("coder", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("coder", "get_issue_comments")).toBe(false);
		expect(isToolAllowedForRole("coder", "create_pr")).toBe(false);
		expect(isToolAllowedForRole("coder", "get_checks")).toBe(false);
	});

	it("tester role rejects all tools", () => {
		expect(isToolAllowedForRole("tester", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("tester", "get_issue_comments")).toBe(false);
		expect(isToolAllowedForRole("tester", "create_pr")).toBe(false);
		expect(isToolAllowedForRole("tester", "get_checks")).toBe(false);
	});

	it("reviewer role rejects all tools", () => {
		expect(isToolAllowedForRole("reviewer", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("reviewer", "get_issue_comments")).toBe(false);
		expect(isToolAllowedForRole("reviewer", "create_pr")).toBe(false);
		expect(isToolAllowedForRole("reviewer", "get_checks")).toBe(false);
	});

	it("unknown role rejects all tools", () => {
		expect(isToolAllowedForRole("unknown", "get_issue")).toBe(false);
		expect(isToolAllowedForRole("unknown", "create_pr")).toBe(false);
	});
});

describe("MCP allowlist matrix — server-side handleToolCall enforcement", () => {
	it("rejects disallowed tool for analyzer with role-aware error", async () => {
		await expect(
			handleToolCall(
				"create_pr",
				{ owner: "o", repo: "r", head: "h", base: "b", title: "t", body: "b" },
				"analyzer",
			),
		).rejects.toThrow("Tool create_pr not allowed for role analyzer");
	});

	it("rejects disallowed tool for pr with role-aware error", async () => {
		await expect(
			handleToolCall("get_issue", { owner: "o", repo: "r", number: 1 }, "pr"),
		).rejects.toThrow("Tool get_issue not allowed for role pr");
	});

	it("rejects any tool for planner with role-aware error", async () => {
		await expect(
			handleToolCall(
				"get_issue",
				{ owner: "o", repo: "r", number: 1 },
				"planner",
			),
		).rejects.toThrow("Tool get_issue not allowed for role planner");
	});

	it("rejects any tool for coder with role-aware error", async () => {
		await expect(
			handleToolCall(
				"create_pr",
				{ owner: "o", repo: "r", head: "h", base: "b", title: "t", body: "b" },
				"coder",
			),
		).rejects.toThrow("Tool create_pr not allowed for role coder");
	});

	it("rejects any tool for tester with role-aware error", async () => {
		await expect(
			handleToolCall(
				"get_checks",
				{ owner: "o", repo: "r", ref: "main" },
				"tester",
			),
		).rejects.toThrow("Tool get_checks not allowed for role tester");
	});

	it("rejects any tool for reviewer with role-aware error", async () => {
		await expect(
			handleToolCall(
				"get_issue_comments",
				{ owner: "o", repo: "r", number: 1 },
				"reviewer",
			),
		).rejects.toThrow("Tool get_issue_comments not allowed for role reviewer");
	});
});

describe("MCP allowlist matrix — agent definitions mcpAllow matches matrix", () => {
	const MCP_ALLOWED: Record<string, string[]> = {
		analyzer: ["get_issue", "get_issue_comments"],
		pr: ["create_pr", "get_checks"],
	};

	it("every role's mcpAllow matches SPEC matrix (empty unless allowlisted)", () => {
		for (const [role, def] of DEFS) {
			expect(def.mcpAllow).toEqual(MCP_ALLOWED[role] ?? []);
		}
	});

	it("analyzer mcpAllow contains exactly get_issue and get_issue_comments", () => {
		expect(analyzerDef.mcpAllow).toEqual(["get_issue", "get_issue_comments"]);
	});

	it("pr mcpAllow contains exactly create_pr and get_checks", () => {
		expect(prDef.mcpAllow).toEqual(["create_pr", "get_checks"]);
	});

	it("planner mcpAllow is empty", () => {
		expect(plannerDef.mcpAllow).toEqual([]);
	});

	it("coder mcpAllow is empty", () => {
		expect(coderDef.mcpAllow).toEqual([]);
	});

	it("tester mcpAllow is empty", () => {
		expect(testerDef.mcpAllow).toEqual([]);
	});

	it("reviewer mcpAllow is empty", () => {
		expect(reviewerDef.mcpAllow).toEqual([]);
	});
});

describe("MCP allowlist matrix — ALLOWED_TOOLS_PER_ROLE constant", () => {
	it("contains only analyzer and pr keys", () => {
		const keys = Object.keys(ALLOWED_TOOLS_PER_ROLE);
		expect(keys).toEqual(["analyzer", "pr"]);
	});

	it("analyzer entry matches expected tools", () => {
		expect(ALLOWED_TOOLS_PER_ROLE.analyzer).toEqual([
			"get_issue",
			"get_issue_comments",
		]);
	});

	it("pr entry matches expected tools", () => {
		expect(ALLOWED_TOOLS_PER_ROLE.pr).toEqual(["create_pr", "get_checks"]);
	});
});
