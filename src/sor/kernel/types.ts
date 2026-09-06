// SoR Kernel — identity, record, and reference types (FR-1, FR-3, K2, K3).

export const RESERVED_NAMESPACE = "fleet" as const; // contract constant, not a DB column
export type Namespace = typeof RESERVED_NAMESPACE;

export type SorType = "content" | "policy" | "context";
export type SorStatus = "active" | "superseded" | "stale" | "invalid";

export interface SourceProvenance {
	externalRef?: string;
	acquiredAt?: string; // ISO timestamp
	sourceHash?: string;
	acquiredBy?: string;
	acquiredFrom?: string;
}

export interface SorRecordIdentity {
	// FR-1 / K2: universal identity
	sorType: SorType;
	sourceId: string;
	namespace: Namespace; // always "fleet" in v1
	version: number; // ordinal per sourceId
	hash: string; // canonical self-hash (FR-2)
}

export interface SorRecord extends SorRecordIdentity {
	status: SorStatus;
	sourceVersion?: string;
	sourceHash?: string;
	provenance: SourceProvenance;
	createdAt: string; // ISO
	syncedAt?: string; // ISO
}

export interface SourceRef {
	// K3 / FR-3: resolvable reference on derived artifacts
	sorType: SorType;
	sourceId: string;
	version: number;
	hash: string;
}

export function isSorRecordIdentity(x: unknown): x is SorRecordIdentity {
	if (x === null || typeof x !== "object") {
		return false;
	}
	const cand = x as Record<string, unknown>;
	return (
		typeof cand.sorType === "string" &&
		(cand.sorType === "content" ||
			cand.sorType === "policy" ||
			cand.sorType === "context") &&
		typeof cand.sourceId === "string" &&
		cand.namespace === RESERVED_NAMESPACE &&
		typeof cand.version === "number" &&
		typeof cand.hash === "string"
	);
}

// ---- Policy SoR contracts (spec §9.3; FR-6..FR-11) ----

/** Exactly one enforcement mode is resolved at spawn and immutable per session (P-I4). */
export type PolicyMode = "sor" | "compatibility" | "fail-closed";

/** Minimal v1 `ArgumentMatcher` DSL (plan-sor.md "Spec ambiguities" #3):
 *  `{ path, oneOf|notOneOf|match }` against parsed tool input. */
export interface ArgumentMatcher {
	path: string;
	oneOf?: readonly unknown[];
	notOneOf?: readonly unknown[];
	match?: string; // RegExp source; tested against the stringified value at `path`
}

export type RulePredicate =
	| { op: "deny"; when: ArgumentMatcher; reason?: string }
	| { op: "require"; when: ArgumentMatcher; reason?: string };

/** Authoritative policy document, stored in `agent_registry.rules` (§9.2/§9.3, locked). */
export interface PolicyDocument {
	schemaVersion: 1; // document format version — literal 1 in v1
	meta: { subject_role: string }; // must equal agent_registry.role
	allowedTools: string[]; // granted fleet registry tool names
	mcpAllow: string[]; // granted MCP tool names
	toolRules: Record<string, RulePredicate[]>; // input-level predicates
}

/** The per-session enforcement bundle the worker enforces (ceiling ∩ grant + rules). */
export interface EffectivePolicy {
	mode: PolicyMode;
	allowedTools: readonly string[];
	mcpAllow: readonly string[];
	toolRules: Record<string, RulePredicate[]>;
}

/** Seed-time snapshot of the current `FleetAgentDef` capability ceiling (§9.4). */
export interface CapabilitySnapshot {
	tools: string[];
	mcp: string[];
	systemPromptSha?: string;
	skillsDir?: string;
}

/** A single granted tool binding on the policy path. */
export interface Grant {
	namespace: Namespace;
	role: string;
	tool: string;
	via: "policy" | "seed";
	sourceHash: string;
}

/** Denormalized tool → predicates pairing derived from `PolicyDocument.toolRules`. */
export interface ToolRule {
	tool: string;
	rules: RulePredicate[];
}
