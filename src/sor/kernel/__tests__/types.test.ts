import { describe, expect, it } from "vitest";
import {
	isSorRecordIdentity,
	RESERVED_NAMESPACE,
	type Namespace,
	type SorRecord,
	type SorRecordIdentity,
	type SourceProvenance,
	type SourceRef,
} from "../types.ts";

function makeIdentity(): SorRecordIdentity {
	return {
		sorType: "policy",
		sourceId: "coder",
		namespace: RESERVED_NAMESPACE,
		version: 8,
		hash: "a".repeat(64),
	};
}

describe("RESERVED_NAMESPACE", () => {
	it("is the literal 'fleet'", () => {
		expect(RESERVED_NAMESPACE).toBe("fleet");
	});

	it("types the namespace field as the literal 'fleet', not a runtime string", () => {
		const ns: Namespace = RESERVED_NAMESPACE;
		expect(ns).toBe("fleet");
		// any other literal is rejected at compile time
	});
});

describe("SorRecordIdentity shape (T6.1)", () => {
	it("carries the five-field identity tuple FR-1/K2", () => {
		const id = makeIdentity();
		expect(id).toEqual({
			sorType: "policy",
			sourceId: "coder",
			namespace: "fleet",
			version: 8,
			hash: "a".repeat(64),
		});
	});

	it("is recognized by the isSorRecordIdentity guard", () => {
		expect(isSorRecordIdentity(makeIdentity())).toBe(true);
	});

	it("types SorRecord as an extension of SorRecordIdentity", () => {
		const record: SorRecord = {
			...makeIdentity(),
			status: "active",
			provenance: {},
			createdAt: "2026-08-29T00:00:00.000Z",
		};
		expect(record.namespace).toBe("fleet");
		expect(record.status).toBe("active");
		expect(record.provenance).toEqual({});
	});

	it("accepts optional provenance-source fields on SourceProvenance", () => {
		const prov: SourceProvenance = {
			externalRef: "ref-1",
			acquiredAt: "2026-08-29T00:00:00.000Z",
			sourceHash: "b".repeat(64),
			acquiredBy: "cli",
			acquiredFrom: "org-mirror",
		};
		expect(prov.acquiredBy).toBe("cli");
	});
});

describe("isSorRecordIdentity guard (T6.2)", () => {
	it("accepts a well-formed identity", () => {
		expect(isSorRecordIdentity(makeIdentity())).toBe(true);
	});

	it("accepts an identity with each sorType", () => {
		for (const sorType of ["content", "policy", "context"] as const) {
			expect(isSorRecordIdentity({ ...makeIdentity(), sorType })).toBe(true);
		}
	});

	it("rejects non-objects and null", () => {
		expect(isSorRecordIdentity(null)).toBe(false);
		expect(isSorRecordIdentity(undefined)).toBe(false);
		expect(isSorRecordIdentity("policy")).toBe(false);
		expect(isSorRecordIdentity(42)).toBe(false);
	});

	it("rejects a wrong namespace", () => {
		expect(
			isSorRecordIdentity({ ...makeIdentity(), namespace: "acme" }),
		).toBe(false);
	});

	it("rejects a missing or non-string hash", () => {
		expect(isSorRecordIdentity({ ...makeIdentity(), hash: undefined })).toBe(
			false,
		);
		expect(isSorRecordIdentity({ ...makeIdentity(), hash: 42 })).toBe(false);
	});

	it("rejects an unknown sorType", () => {
		expect(
			isSorRecordIdentity({ ...makeIdentity(), sorType: "bogus" }),
		).toBe(false);
	});

	it("rejects a missing or non-number version", () => {
		expect(
			isSorRecordIdentity({ ...makeIdentity(), version: undefined }),
		).toBe(false);
		expect(isSorRecordIdentity({ ...makeIdentity(), version: "8" })).toBe(
			false,
		);
	});

	it("rejects a missing sourceId", () => {
		expect(
			isSorRecordIdentity({ ...makeIdentity(), sourceId: undefined }),
		).toBe(false);
	});
});

describe("SourceRef tuple (T6.3)", () => {
	it("carries the four-field reference (sorType, sourceId, version, hash) with no namespace", () => {
		const ref: SourceRef = {
			sorType: "content",
			sourceId: "book",
			version: 12,
			hash: "c".repeat(64),
		};
		expect(ref).toEqual({
			sorType: "content",
			sourceId: "book",
			version: 12,
			hash: "c".repeat(64),
		});
		expect("namespace" in ref).toBe(false);
	});
});
