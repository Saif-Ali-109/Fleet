import { describe, expect, it } from "vitest";
import type { PolicyDocument } from "../../sor/kernel/types.ts";
import { coderDef } from "../agents/coder.ts";
import { capabilitySnapshot, emptyPolicy } from "../policy.ts";
import {
	computeEffectiveTools,
	type EffectiveToolSet,
	evaluateMatcher,
	evaluateToolCall,
} from "../policyEval.ts";

const granted: EffectiveToolSet = {
	allowedTools: ["read", "grep", "bash"],
	mcpAllow: ["mcp://fs"],
};

describe("evaluateToolCall (P3.4, FR-6/FR-11)", () => {
	it("allowed tool ⇒ ALLOW", () => {
		expect(evaluateToolCall("read", { path: "a.ts" }, granted, {})).toEqual({
			allowed: true,
			decision: "ALLOW",
			reason: "allowed",
		});
	});

	it("unknown tool ⇒ DENY (implicit deny, §9.3 last bullet)", () => {
		expect(evaluateToolCall("write", { path: "a.ts" }, granted, {})).toEqual({
			allowed: false,
			decision: "DENY",
			reason: "unknown tool: write",
		});
	});

	it("deny predicate matching ⇒ DENY", () => {
		const rules = {
			bash: [
				{ op: "deny" as const, when: { path: "command", match: "^git push" } },
			],
		};
		const denied = evaluateToolCall(
			"bash",
			{ command: "git push origin main" },
			granted,
			rules,
		);
		expect(denied.allowed).toBe(false);
		expect(denied.decision).toBe("DENY");
		expect(denied.reason).toContain("denied");
		const allowed = evaluateToolCall(
			"bash",
			{ command: "git status" },
			granted,
			rules,
		);
		expect(allowed).toEqual({
			allowed: true,
			decision: "ALLOW",
			reason: "allowed",
		});
	});

	it("require predicate failing ⇒ DENY", () => {
		const rules = {
			bash: [
				{ op: "require" as const, when: { path: "cwd", oneOf: ["/worktree"] } },
			],
		};
		const denied = evaluateToolCall(
			"bash",
			{ command: "ls", cwd: "/tmp" },
			granted,
			rules,
		);
		expect(denied.allowed).toBe(false);
		expect(denied.decision).toBe("DENY");
		expect(denied.reason).toContain("require");
		expect(
			evaluateToolCall(
				"bash",
				{ command: "ls", cwd: "/worktree" },
				granted,
				rules,
			),
		).toEqual({ allowed: true, decision: "ALLOW", reason: "allowed" });
	});

	it("multiple predicates ALL satisfied ⇒ ALLOW; single violation ⇒ DENY", () => {
		const rules = {
			bash: [
				{ op: "require" as const, when: { path: "cwd", oneOf: ["/worktree"] } },
				{ op: "deny" as const, when: { path: "command", match: "rm -rf" } },
			],
		};
		expect(
			evaluateToolCall(
				"bash",
				{ command: "ls", cwd: "/worktree" },
				granted,
				rules,
			),
		).toEqual({ allowed: true, decision: "ALLOW", reason: "allowed" });
		expect(
			evaluateToolCall(
				"bash",
				{ command: "rm -rf /", cwd: "/worktree" },
				granted,
				rules,
			),
		).toMatchObject({ allowed: false, decision: "DENY" });
		expect(
			evaluateToolCall("bash", { command: "ls", cwd: "/etc" }, granted, rules),
		).toMatchObject({ allowed: false, decision: "DENY" });
	});

	it("FR-11: an empty-but-valid document grants nothing", () => {
		const emptyDoc = emptyPolicy("coder");
		const effective = computeEffectiveTools(
			{ tools: coderDef.tools, mcpAllow: coderDef.mcpAllow },
			emptyDoc,
		);
		expect(effective.allowedTools).toEqual([]);
		expect(effective.mcpAllow).toEqual([]);
		for (const tool of coderDef.tools) {
			expect(
				evaluateToolCall(tool, {}, effective, emptyDoc.toolRules).allowed,
			).toBe(false);
		}
	});

	it("empty toolRules + tool in allowedTools ⇒ ALLOW", () => {
		expect(evaluateToolCall("grep", { pattern: "x" }, granted, {})).toEqual({
			allowed: true,
			decision: "ALLOW",
			reason: "allowed",
		});
	});

	it("mcp tool granted through mcpAllow ⇒ ALLOW", () => {
		expect(evaluateToolCall("mcp://fs", { path: "/" }, granted, {})).toEqual({
			allowed: true,
			decision: "ALLOW",
			reason: "allowed",
		});
	});
});

describe("computeEffectiveTools (P-I1 ceiling ∩ grant)", () => {
	it("a def tool absent from the policy doc yields no grant (AT-4)", () => {
		const doc: PolicyDocument = {
			...capabilitySnapshot(coderDef, "coder"),
			allowedTools: coderDef.tools.filter((t) => t !== "bash"),
		};
		const effective = computeEffectiveTools(
			{ tools: coderDef.tools, mcpAllow: coderDef.mcpAllow },
			doc,
		);
		expect(effective.allowedTools).not.toContain("bash");
		expect(effective.allowedTools.length).toBe(coderDef.tools.length - 1);
	});
});

describe("evaluateMatcher", () => {
	it("oneOf / notOneOf / match semantics", () => {
		const input = { a: { b: "hello" }, n: 3 };
		expect(
			evaluateMatcher({ path: "a.b", oneOf: ["hi", "hello"] }, input),
		).toBe(true);
		expect(evaluateMatcher({ path: "a.b", oneOf: ["hi"] }, input)).toBe(false);
		expect(evaluateMatcher({ path: "a.b", notOneOf: ["bye"] }, input)).toBe(
			true,
		);
		expect(evaluateMatcher({ path: "n", notOneOf: [3] }, input)).toBe(false);
		expect(evaluateMatcher({ path: "a.b", match: "^hel+o$" }, input)).toBe(
			true,
		);
		expect(evaluateMatcher({ path: "missing", match: "x" }, input)).toBe(false);
	});
});
