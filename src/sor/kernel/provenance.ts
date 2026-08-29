// SoR Kernel — provenance output contract and freshness (FR-4, C3, X2).

import type { SorRecordIdentity, SourceRef } from "./types.ts";

export interface ContentProvenance {
	source: string;
	document: string;
	section: string;
	version: number;
	contentHash: string;
}

export interface ContextProvenance {
	state: unknown;
	fresh: boolean;
	staleAfter: string;
}

export function contentProvenanceOf(input: {
	ref: SorRecordIdentity;
	source: string;
	document: string;
	section: string;
}): ContentProvenance {
	return {
		source: input.source,
		document: input.document,
		section: input.section,
		version: input.ref.version,
		contentHash: input.ref.hash,
	};
}

export function assertContentProvenance(p: ContentProvenance): void {
	if (typeof p !== "object" || p === null) {
		throw new Error("content provenance must be an object");
	}
	if (typeof p.source !== "string" || p.source.length === 0) {
		throw new Error("content provenance requires a non-empty source");
	}
	if (typeof p.document !== "string" || p.document.length === 0) {
		throw new Error("content provenance requires a non-empty document");
	}
	if (typeof p.section !== "string" || p.section.length === 0) {
		throw new Error("content provenance requires a non-empty section");
	}
	if (typeof p.version !== "number") {
		throw new Error("content provenance requires a numeric version");
	}
	if (typeof p.contentHash !== "string" || !/^[0-9a-f]+$/i.test(p.contentHash)) {
		throw new Error("content provenance requires a hex contentHash");
	}
}

export function freshnessOf(input: {
	updatedAt: string;
	ttlMs: number;
	now?: string;
}): ContextProvenance {
	const updated = Date.parse(input.updatedAt);
	if (Number.isNaN(updated)) {
		throw new Error("freshnessOf requires a valid updatedAt timestamp");
	}
	const nowMs = Date.parse(input.now ?? new Date(Date.now()).toISOString());
	const staleAfterMs = updated + input.ttlMs;
	const staleAfter = new Date(staleAfterMs).toISOString();
	// strict: now == staleAfter ⇒ fresh: false
	const fresh = nowMs < staleAfterMs;
	return { state: { updatedAt: input.updatedAt, ttlMs: input.ttlMs }, fresh, staleAfter };
}

export function sourceRefOf(identity: SorRecordIdentity): SourceRef {
	return {
		sorType: identity.sorType,
		sourceId: identity.sourceId,
		version: identity.version,
		hash: identity.hash,
	};
}
