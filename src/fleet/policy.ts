// Policy SoR v1 — document schema validation, canonical hash, and the
// SOR_POLICY_JSON_B64 codec (spec §9.3, plan-sor.md C6.1). Pure module.

import { createHash } from "node:crypto";
import type { PolicyDocument } from "../sor/kernel/types.ts";
import { canonicalJson } from "../sor/signer.ts";
import type { FleetAgentDef } from "./types.ts";

export type {
	ArgumentMatcher,
	CapabilitySnapshot,
	EffectivePolicy,
	Grant,
	PolicyDocument,
	PolicyMode,
	RulePredicate,
	ToolRule,
} from "../sor/kernel/types.ts";

/** sha256 hex of a UTF-8 string. Shared with the audit registry hashing. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Structural + (optional) role validation of a policy document (§9.3, locked). */
export function validatePolicyDocument(
	doc: unknown,
	role?: string,
): { ok: true } | { ok: false; reason: string } {
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		return { ok: false, reason: "policy document must be an object" };
	}
	const d = doc as Record<string, unknown>;
	if (d.schemaVersion !== 1) {
		return { ok: false, reason: "schemaVersion must be 1" };
	}
	const meta = d.meta;
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
		return { ok: false, reason: "meta must be an object" };
	}
	const subjectRole = (meta as Record<string, unknown>).subject_role;
	if (typeof subjectRole !== "string" || subjectRole.length === 0) {
		return {
			ok: false,
			reason: "meta.subject_role must be a non-empty string",
		};
	}
	if (role !== undefined && subjectRole !== role) {
		return {
			ok: false,
			reason: `meta.subject_role '${subjectRole}' does not match role '${role}'`,
		};
	}
	for (const key of ["allowedTools", "mcpAllow"] as const) {
		const arr = d[key];
		if (!Array.isArray(arr) || arr.some((el) => typeof el !== "string")) {
			return { ok: false, reason: `${key} must be a string array` };
		}
	}
	const toolRules = d.toolRules;
	if (
		toolRules === null ||
		typeof toolRules !== "object" ||
		Array.isArray(toolRules)
	) {
		return {
			ok: false,
			reason: "toolRules must be an object keyed by tool name",
		};
	}
	for (const [tool, predicates] of Object.entries(
		toolRules as Record<string, unknown>,
	)) {
		if (!Array.isArray(predicates)) {
			return {
				ok: false,
				reason: `toolRules[${tool}] must be an array of predicates`,
			};
		}
		for (const raw of predicates as unknown[]) {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				return {
					ok: false,
					reason: `toolRules[${tool}] contains a non-object predicate`,
				};
			}
			const pred = raw as Record<string, unknown>;
			if (pred.op !== "deny" && pred.op !== "require") {
				return {
					ok: false,
					reason: `toolRules[${tool}] predicate op must be 'deny'|'require'`,
				};
			}
			if (pred.reason !== undefined && typeof pred.reason !== "string") {
				return {
					ok: false,
					reason: `toolRules[${tool}] predicate reason must be a string`,
				};
			}
			const when = pred.when;
			if (when === null || typeof when !== "object" || Array.isArray(when)) {
				return {
					ok: false,
					reason: `toolRules[${tool}] predicate.when must be an ArgumentMatcher`,
				};
			}
			const matcher = when as Record<string, unknown>;
			if (typeof matcher.path !== "string" || matcher.path.length === 0) {
				return {
					ok: false,
					reason: `toolRules[${tool}] matcher.path must be a non-empty string`,
				};
			}
			for (const op of ["oneOf", "notOneOf"] as const) {
				if (matcher[op] !== undefined && !Array.isArray(matcher[op])) {
					return {
						ok: false,
						reason: `toolRules[${tool}] matcher.${op} must be an array`,
					};
				}
			}
			if (matcher.match !== undefined && typeof matcher.match !== "string") {
				return {
					ok: false,
					reason: `toolRules[${tool}] matcher.match must be a string`,
				};
			}
		}
	}
	return { ok: true };
}

/** Canonical policy hash: sha256 over the deep-sorted canonical JSON (FR-2, §7.4). */
export function canonicalPolicyHash(doc: PolicyDocument): string {
	return sha256Hex(canonicalJson(doc));
}

/** `SOR_POLICY_JSON_B64` encoder — UTF-8-safe base64 (sole codec for env + policy_sync.document). */
export function encodePolicyDocument(doc: PolicyDocument): string {
	return Buffer.from(JSON.stringify(doc), "utf8").toString("base64");
}

/** `SOR_POLICY_JSON_B64` decoder — inverse of `encodePolicyDocument`. */
export function decodePolicyDocument(b64: string): PolicyDocument {
	const raw = Buffer.from(b64, "base64").toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("policy document decode failed: invalid JSON");
	}
	const check = validatePolicyDocument(parsed);
	if (!check.ok) {
		throw new Error(`policy document decode failed: ${check.reason}`);
	}
	return parsed as PolicyDocument;
}

/** Zero-grant policy document for a role (FR-11: valid, grants nothing). */
export function emptyPolicy(role: string): PolicyDocument {
	return {
		schemaVersion: 1,
		meta: { subject_role: role },
		allowedTools: [],
		mcpAllow: [],
		toolRules: {},
	};
}

/** Capability snapshot seed (spec §9.4): `def.tools ∪ def.mcpAllow`, empty `toolRules`. */
export function capabilitySnapshot(
	def: FleetAgentDef,
	role: string,
): PolicyDocument {
	return {
		schemaVersion: 1,
		meta: { subject_role: role },
		allowedTools: [...def.tools],
		mcpAllow: [...def.mcpAllow],
		toolRules: {},
	};
}
