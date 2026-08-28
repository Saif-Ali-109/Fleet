import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzerDef } from "../fleet/agents/analyzer.ts";
import { coderDef } from "../fleet/agents/coder.ts";
import { plannerDef } from "../fleet/agents/planner.ts";
import { prDef } from "../fleet/agents/pr.ts";
import { reviewerDef } from "../fleet/agents/reviewer.ts";
import { testerDef } from "../fleet/agents/tester.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";

const DEFS: Array<[string, FleetAgentDef]> = [
	["analyzer", analyzerDef],
	["planner", plannerDef],
	["coder", coderDef],
	["tester", testerDef],
	["reviewer", reviewerDef],
	["pr", prDef],
];

const KNOWN_TOOLS: readonly ToolName[] = [
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"load_skill",
];

const MCP_ALLOWED: Record<string, string[]> = {
	analyzer: ["get_issue", "get_issue_comments"],
	pr: ["create_pr", "get_checks"],
};

function stripFrontmatter(raw: string): string {
	const open = "---\n";
	if (!raw.startsWith(open)) throw new Error("missing opening fence");
	const close = raw.indexOf("\n---\n", open.length);
	if (close < 0) throw new Error("missing closing fence");
	return raw.slice(close + "\n---\n".length);
}

function fixturePath(role: string): string {
	return fileURLToPath(
		new URL(`./fixtures/fleet-prompts/${role}.md`, import.meta.url),
	);
}

describe("fleet agent defs — prompt parity vs fixtures", () => {
	for (const [role, def] of DEFS) {
		it(`${role}: systemPrompt is byte-equal to its snapshot fixture`, () => {
			const fixture = readFileSync(fixturePath(role), "utf8");
			expect(def.systemPrompt).toBe(fixture);
		});
	}
});

// PRE-P8 NET: these assertions die with the agents/*.md deletion sweep.
// The fixture tests above remain after P8.
const AGENTS_MD_EXISTS = existsSync("agents/analyzer.md");

describe.skipIf(!AGENTS_MD_EXISTS)(
	"fleet agent defs — prompt parity vs git HEAD agents/*.md (pre-P8 net)",
	() => {
		for (const [role, def] of DEFS) {
			it(`${role}: systemPrompt byte-equals git show HEAD:agents/${role}.md body`, () => {
				const head = execFileSync("git", ["show", `HEAD:agents/${role}.md`], {
					encoding: "utf8",
					maxBuffer: 1024 * 1024,
				});
				expect(def.systemPrompt).toBe(stripFrontmatter(head));
			});
		}
	},
);

describe("fleet agent def shape sanity", () => {
	it("name matches filename for every def", () => {
		for (const [role, def] of DEFS) {
			expect(def.name).toBe(role);
		}
	});

	it("tools are non-empty subsets of the known ToolName union", () => {
		for (const [, def] of DEFS) {
			expect(def.tools.length).toBeGreaterThan(0);
			for (const tool of def.tools) {
				expect(KNOWN_TOOLS).toContain(tool);
			}
		}
	});

	it("every role gets load_skill; read-only roles lack write tools", () => {
		for (const [role, def] of DEFS) {
			expect(def.tools).toContain("load_skill");
			if (["analyzer", "planner", "reviewer"].includes(role)) {
				expect(def.tools).not.toContain("bash");
				expect(def.tools).not.toContain("write");
				expect(def.tools).not.toContain("edit");
			}
		}
	});

	it("mcpAllow matches the SPEC §9 matrix (empty unless allowlisted)", () => {
		for (const [role, def] of DEFS) {
			expect(def.mcpAllow).toEqual(MCP_ALLOWED[role] ?? []);
		}
	});

	it("skillsDir follows the skills/<role> convention consistently", () => {
		for (const [role, def] of DEFS) {
			expect(def.skillsDir).toBe(`skills/${role}`);
		}
	});
});
