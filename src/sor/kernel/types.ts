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
		(typeof cand.sorType === "string" &&
			(cand.sorType === "content" ||
				cand.sorType === "policy" ||
				cand.sorType === "context")) &&
		typeof cand.sourceId === "string" &&
		cand.namespace === RESERVED_NAMESPACE &&
		typeof cand.version === "number" &&
		typeof cand.hash === "string"
	);
}
