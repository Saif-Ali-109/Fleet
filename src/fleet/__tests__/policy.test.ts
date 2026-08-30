import { describe, expect, it } from "vitest";
import {
	canonicalPolicyHash,
	capabilitySnapshot,
	decodePolicyDocument,
	emptyPolicy,
	encodePolicyDocument,
	sha256Hex,
	validatePolicyDocument,
} from "../policy.ts";
import { canonicalJson } from "../../sor/signer.ts";
import { coderDef } from "../agents/coder.ts";
import type { PolicyDocument } from "../../sor/kernel/types.ts";

const validDoc: PolicyDocument = {
	schemaVersion: 1,
	meta: { subject_role: "coder" },
	allowedTools: ["read", "grep", "bash"],
	mcpAllow: [],
	toolRules: {
		bash: [{ op: "deny", when: { path: "command", match: "^git push" } }],
	},
};

describe("validatePolicyDocument (P3.1)", () => {
	it("accepts a structurally valid document", () => {
		expect(validatePolicyDocument(validDoc)).toEqual({ ok: true });
		expect(
			validatePolicyDocument(
				{ ...validDoc, meta: { subject_role: "planner" } },
				"planner",
			),
		).toEqual({ ok: true });
	});

	it("rejects wrong schemaVersion", () => {
		const bad = { ...validDoc, schemaVersion: 2 };
		expect(validatePolicyDocument(bad)).toEqual({
			ok: false,
			reason: "schemaVersion must be 1",
		});
	});

	it("rejects role mismatch when a target role is given", () => {
		expect(
			validatePolicyDocument(
				{ ...validDoc, meta: { subject_role: "planner" } },
				"coder",
			),
		).toEqual({
			ok: false,
			reason: "meta.subject_role 'planner' does not match role 'coder'",
		});
	});

	it("rejects unknown rule operator", () => {
		const bad: Record<string, unknown> = {
			...validDoc,
			toolRules: {
				bash: [{ op: "allow", when: { path: "x" } }],
			},
		};
		expect(validatePolicyDocument(bad)).toEqual({
			ok: false,
			reason: "toolRules[bash] predicate op must be 'deny'|'require'",
		});
	});

	it("rejects non-array tools", () => {
		expect(
			validatePolicyDocument({ ...validDoc, allowedTools: "bash" }),
		).toEqual({ ok: false, reason: "allowedTools must be a string array" });
		expect(
			validatePolicyDocument({ ...validDoc, mcpAllow: [1, 2] }),
		).toEqual({ ok: false, reason: "mcpAllow must be a string array" });
	});

	it("rejects malformed toolRules / matchers", () => {
		expect(
			validatePolicyDocument({ ...validDoc, toolRules: [] }),
		).toEqual({
			ok: false,
			reason: "toolRules must be an object keyed by tool name",
		});
		expect(
			validatePolicyDocument({
				...validDoc,
				toolRules: { bash: "deny" },
			}),
		).toEqual({
			ok: false,
			reason: "toolRules[bash] must be an array of predicates",
		});
		expect(
			validatePolicyDocument({
				...validDoc,
				toolRules: { bash: [{ op: "deny", when: { path: "" } }] },
			}),
		).toEqual({
			ok: false,
			reason: "toolRules[bash] matcher.path must be a non-empty string",
		});
		expect(
			validatePolicyDocument({
				...validDoc,
				toolRules: { bash: [{ op: "deny", when: { path: "p", match: 1 } }] },
			}),
		).toEqual({
			ok: false,
			reason: "toolRules[bash] matcher.match must be a string",
		});
	});
});

describe("canonicalPolicyHash (P3.2)", () => {
	it("is stable under object key insertion order", () => {
		const a = validDoc;
		const b: PolicyDocument = {
			toolRules: a.toolRules,
			schemaVersion: a.schemaVersion,
			allowedTools: a.allowedTools,
			meta: a.meta,
			mcpAllow: a.mcpAllow,
		};
		expect(canonicalPolicyHash(a)).toBe(canonicalPolicyHash(b));
	});

	it("equals sha256Hex(canonicalJson(doc))", () => {
		expect(canonicalPolicyHash(validDoc)).toBe(
			sha256Hex(canonicalJson(validDoc)),
		);
	});

	it("differs on any field change", () => {
		const base = canonicalPolicyHash(validDoc);
		expect(canonicalPolicyHash({ ...validDoc, allowedTools: ["read"] })).not.toBe(
			base,
		);
		expect(
			canonicalPolicyHash({
				...validDoc,
				meta: { subject_role: "planner" },
			}),
		).not.toBe(base);
	});
});

describe("SOR_POLICY_JSON_B64 codec (P3.3)", () => {
	it("round-trips a document including non-ASCII role/tool strings", () => {
		const doc: PolicyDocument = {
			schemaVersion: 1,
			meta: { subject_role: "coder" },
			allowedTools: ["read", "véřtřou", "𝔊𝔯𝔢𝔢𝔨"],
			mcpAllow: ["mcp://naïve"],
			toolRules: {
				read: [
					{
						op: "deny",
						when: { path: "路径", oneOf: ["秘密"] },
					},
				],
			},
		};
		const b64 = encodePolicyDocument(doc);
		expect(b64).not.toContain("read");
		expect(decodePolicyDocument(b64)).toEqual(doc);
	});

	it("rejects garbage base64", () => {
		expect(() => decodePolicyDocument("not-base64!!")).toThrow();
	});
});

describe("seed helpers", () => {
	it("emptyPolicy is valid and grants nothing (FR-11)", () => {
		const doc = emptyPolicy("coder");
		expect(validatePolicyDocument(doc, "coder")).toEqual({ ok: true });
		expect(doc.allowedTools).toEqual([]);
		expect(doc.mcpAllow).toEqual([]);
		expect(doc.toolRules).toEqual({});
	});

	it("capabilitySnapshot mirrors def.tools ∪ def.mcpAllow with empty toolRules", () => {
		const doc = capabilitySnapshot(coderDef, "coder");
		expect(validatePolicyDocument(doc, "coder")).toEqual({ ok: true });
		expect(doc.allowedTools).toEqual([...coderDef.tools]);
		expect(doc.mcpAllow).toEqual([...coderDef.mcpAllow]);
		expect(doc.toolRules).toEqual({});
	});
});