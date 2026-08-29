import { describe, expect, it } from "vitest";
import {
	assertContentProvenance,
	contentProvenanceOf,
	freshnessOf,
	sourceRefOf,
	type ContentProvenance,
	type ContextProvenance,
} from "../provenance.ts";
import { RESERVED_NAMESPACE, type SorRecordIdentity } from "../types.ts";

function makeIdentity(): SorRecordIdentity {
	return {
		sorType: "content",
		sourceId: "doc-1",
		namespace: RESERVED_NAMESPACE,
		version: 12,
		hash: "c".repeat(64),
	};
}

describe("contentProvenanceOf / ContentProvenance (T8.1)", () => {
	it("builds the exact five-field tuple per FR-4/C3", () => {
		const ref = makeIdentity();
		const p = contentProvenanceOf({
			ref,
			source: "org-manual",
			document: "architecture",
			section: "overview",
		});
		expect(p).toEqual({
			source: "org-manual",
			document: "architecture",
			section: "overview",
			version: 12,
			contentHash: "c".repeat(64),
		});
		// exactly the five contract fields
		expect(Object.keys(p).sort()).toEqual([
			"contentHash",
			"document",
			"section",
			"source",
			"version",
		]);
	});

	it("sources version and contentHash from the record identity", () => {
		const ref: SorRecordIdentity = {
			sorType: "content",
			sourceId: "book",
			namespace: RESERVED_NAMESPACE,
			version: 7,
			hash: "d".repeat(64),
		};
		const p = contentProvenanceOf({
			ref,
			source: "s",
			document: "d",
			section: "sec",
		});
		expect(p.version).toBe(7);
		expect(p.contentHash).toBe("d".repeat(64));
	});
});

describe("assertContentProvenance (T8.2)", () => {
	const valid: ContentProvenance = {
		source: "org-manual",
		document: "architecture",
		section: "overview",
		version: 12,
		contentHash: "c".repeat(64),
	};

	it("accepts a well-formed tuple", () => {
		expect(() => assertContentProvenance(valid)).not.toThrow();
	});

	it("accepts an uppercase-hex contentHash", () => {
		expect(() =>
			assertContentProvenance({ ...valid, contentHash: "c".toUpperCase().repeat(64) }),
		).not.toThrow();
	});

	it("throws on a missing field", () => {
		for (const key of ["source", "document", "section", "version", "contentHash"]) {
			const { [key as keyof ContentProvenance]: _omit, ...rest } = valid;
			expect(() =>
				assertContentProvenance(rest as unknown as ContentProvenance),
			).toThrow();
		}
	});

	it("throws on a non-string source/document/section", () => {
		expect(() =>
			assertContentProvenance({
				...valid,
				source: 42 as unknown as string,
			}),
		).toThrow();
	});

	it("throws on a non-numeric version", () => {
		expect(() =>
			assertContentProvenance({
				...valid,
				version: "12" as unknown as number,
			}),
		).toThrow();
	});

	it("throws on a non-hex contentHash", () => {
		expect(() =>
			assertContentProvenance({ ...valid, contentHash: "not-hex" }),
		).toThrow();
		expect(() =>
			assertContentProvenance({ ...valid, contentHash: "" }),
		).toThrow();
	});

	it("throws on non-object input", () => {
		expect(() =>
			assertContentProvenance(null as unknown as ContentProvenance),
		).toThrow();
	});
});

describe("freshnessOf (T8.3)", () => {
	const updatedAt = "2026-08-29T00:00:00.000Z";
	const ttlMs = 60_000;

	it("returns fresh: true strictly before the stale point", () => {
		const now = "2026-08-29T00:00:59.999Z";
		const p = freshnessOf({ updatedAt, ttlMs, now });
		expect(p.fresh).toBe(true);
	});

	it("returns fresh: false at the exact stale point (now == staleAfter)", () => {
		const staleAfter = new Date(Date.parse(updatedAt) + ttlMs).toISOString();
		expect(freshnessOf({ updatedAt, ttlMs, now: staleAfter }).fresh).toBe(false);
	});

	it("returns fresh: false beyond the stale point", () => {
		const now = "2026-08-29T00:01:00.001Z";
		expect(freshnessOf({ updatedAt, ttlMs, now }).fresh).toBe(false);
	});

	it("emits an ISO-8601 staleAfter equal to updatedAt + ttlMs", () => {
		const p: ContextProvenance = freshnessOf({ updatedAt, ttlMs });
		expect(p.staleAfter).toBe(
			new Date(Date.parse(updatedAt) + ttlMs).toISOString(),
		);
		expect(() => new Date(p.staleAfter).toISOString()).not.toThrow();
	});

	it("throws on an invalid updatedAt", () => {
		expect(() =>
			freshnessOf({ updatedAt: "not-a-date", ttlMs }),
		).toThrow();
	});
});

describe("sourceRefOf (T8.4)", () => {
	it("drops the namespace field from the ref", () => {
		const identity = makeIdentity();
		const ref = sourceRefOf(identity);
		expect(ref).toEqual({
			sorType: "content",
			sourceId: "doc-1",
			version: 12,
			hash: "c".repeat(64),
		});
		expect("namespace" in ref).toBe(false);
	});
});
