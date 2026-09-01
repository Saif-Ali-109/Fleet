import { describe, expect, it } from "vitest";
import {
	baseTtlMs,
	computeContextHash,
	contextFreshness,
	ttlForCategory,
	type ContextCategory,
	type ContextDoc,
	type ContextReadResult,
} from "../context.ts";
import { sha256Hex, canonicalizeText } from "../../sor/kernel/hash.ts";

const BASE_HOURS = 24;
const MS_PER_HOUR = 3600_000;

describe("baseTtlMs", () => {
	it("returns 24h in milliseconds by default", () => {
		expect(baseTtlMs()).toBe(BASE_HOURS * MS_PER_HOUR);
	});

	it("respects CONTEXT_TTL_HOURS env override", () => {
		expect(baseTtlMs({ CONTEXT_TTL_HOURS: "8" })).toBe(8 * MS_PER_HOUR);
	});

	it("falls back to default when env is invalid (<=0)", () => {
		expect(baseTtlMs({ CONTEXT_TTL_HOURS: "0" })).toBe(BASE_HOURS * MS_PER_HOUR);
		expect(baseTtlMs({ CONTEXT_TTL_HOURS: "-5" })).toBe(BASE_HOURS * MS_PER_HOUR);
		expect(baseTtlMs({ CONTEXT_TTL_HOURS: "abc" })).toBe(BASE_HOURS * MS_PER_HOUR);
	});
});

describe("ttlForCategory", () => {
	it("returns base TTL when no per-category env override", () => {
		expect(ttlForCategory("run")).toBe(BASE_HOURS * MS_PER_HOUR);
		expect(ttlForCategory("org-constraints")).toBe(BASE_HOURS * MS_PER_HOUR);
	});

	it("honors per-category override (run)", () => {
		expect(ttlForCategory("run", { CONTEXT_TTL_RUN_HOURS: "2" })).toBe(2 * MS_PER_HOUR);
	});

	it("honors per-category override (org-constraints)", () => {
		expect(ttlForCategory("org-constraints", { CONTEXT_TTL_ORG_HOURS: "48" })).toBe(
			48 * MS_PER_HOUR,
		);
	});

	it("falls back to base when per-category env is invalid", () => {
		expect(ttlForCategory("run", { CONTEXT_TTL_RUN_HOURS: "0" })).toBe(
			BASE_HOURS * MS_PER_HOUR,
		);
		expect(ttlForCategory("run", { CONTEXT_TTL_RUN_HOURS: "abc" })).toBe(
			BASE_HOURS * MS_PER_HOUR,
		);
	});

	it("base override propagates into per-category default", () => {
		const env = { CONTEXT_TTL_HOURS: "12" };
		expect(ttlForCategory("run", env)).toBe(12 * MS_PER_HOUR);
		expect(ttlForCategory("org-constraints", env)).toBe(12 * MS_PER_HOUR);
	});

	it("per-category override takes precedence over base", () => {
		const env = { CONTEXT_TTL_HOURS: "12", CONTEXT_TTL_RUN_HOURS: "2" };
		expect(ttlForCategory("run", env)).toBe(2 * MS_PER_HOUR);
		expect(ttlForCategory("org-constraints", env)).toBe(12 * MS_PER_HOUR);
	});
});

describe("computeContextHash", () => {
	it("returns a 64-char hex digest", () => {
		expect(computeContextHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic — same state ⇒ same hash", () => {
		const state = { key: "value", nested: { x: 1 } };
		expect(computeContextHash(state)).toBe(computeContextHash(state));
	});

	it("differs for different state", () => {
		expect(computeContextHash({ a: 1 })).not.toBe(computeContextHash({ a: 2 }));
	});

	it("matches sha256Hex(canonicalizeText(JSON.stringify(state)))", () => {
		const state = { hello: "world" };
		const expected = sha256Hex(canonicalizeText(JSON.stringify(state)));
		expect(computeContextHash(state)).toBe(expected);
	});
});

describe("contextFreshness", () => {
	it("returns fresh:true for a recently updated doc", () => {
		const updatedAt = new Date(Date.now() - 60_000).toISOString();
		const result = contextFreshness(
			{ updatedAt, category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "1" },
		);
		expect(result.fresh).toBe(true);
	});

	it("returns fresh:false for a doc updated far beyond the TTL", () => {
		const updatedAt = new Date(Date.now() - 48 * MS_PER_HOUR).toISOString();
		const result = contextFreshness(
			{ updatedAt, category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "1" },
		);
		expect(result.fresh).toBe(false);
	});

	it("mirrors kernel semantics: staleAfter = updatedAt + ttlMs", () => {
		const updatedAt = new Date(Date.now() - 1000).toISOString();
		const result = contextFreshness(
			{ updatedAt, category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "2" },
		);
		expect(result.staleAfter).toBe(
			new Date(Date.parse(updatedAt) + 2 * MS_PER_HOUR).toISOString(),
		);
	});

	it("returns staleAfter as ISO string", () => {
		const updatedAt = new Date().toISOString();
		const result = contextFreshness({ updatedAt, category: "run" });
		expect(() => new Date(result.staleAfter).toISOString()).not.toThrow();
	});

	it("boundary: now == staleAfter ⇒ fresh:false", () => {
		const updatedAt = new Date(Date.now() - 60_000).toISOString();
		// 1h TTL, elapsed 60s ⇒ strictly fresh
		const fresh = contextFreshness(
			{ updatedAt, category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "1" },
		);
		expect(fresh.fresh).toBe(true);
		// TTL of ~0 means the doc is immediately at/over the boundary;
		// the kernel reports fresh:false at now == staleAfter
		const boundary = contextFreshness(
			{ updatedAt: new Date(Date.now() - 1).toISOString(), category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "0.0000000000001" },
		);
		expect(boundary.fresh).toBe(false);
	});

	it("plugs per-category TTL through to freshness", () => {
		const updatedAt = new Date(Date.now() - 3600_000).toISOString();

		// run with 2h TTL: still fresh at ~1h elapsed
		const run2h = contextFreshness(
			{ updatedAt, category: "run" },
			{ CONTEXT_TTL_RUN_HOURS: "2" },
		);
		expect(run2h.fresh).toBe(true);

		// org with default 24h TTL: still fresh at ~1h elapsed
		const orgDefault = contextFreshness({ updatedAt, category: "org-constraints" });
		expect(orgDefault.fresh).toBe(true);
	});
});

describe("ContextDoc / ContextReadResult type fixtures", () => {
	it("ContextDoc accepts well-typed fixture", () => {
		const doc: ContextDoc = {
			sorType: "context",
			sourceId: "fleet|run|abc123",
			namespace: "fleet",
			version: 1,
			hash: "a".repeat(64),
			category: "run",
			state: { runId: "abc123", repo: "https://github.com/test/repo" },
			freshUntil: "2026-08-29T24:00:00.000Z",
			staleAfter: "2026-08-29T24:00:00.000Z",
			status: "active",
		};
		expect(doc.sorType).toBe("context");
		expect(doc.category).toBe("run");
	});

	it("ContextDoc with optional fields omitted", () => {
		const doc: ContextDoc = {
			sorType: "context",
			sourceId: "fleet|org|default",
			namespace: "fleet",
			version: 1,
			hash: "b".repeat(64),
			category: "org-constraints",
			state: { allowedHosts: ["github.com"] },
			status: "active",
		};
		expect(doc.freshUntil).toBeUndefined();
		expect(doc.staleAfter).toBeUndefined();
	});

	it("ContextReadResult ok variant", () => {
		const result: ContextReadResult = {
			ok: true,
			item: { state: { x: 1 }, fresh: true, staleAfter: "2026-08-29T24:00:00.000Z", version: 1 },
		};
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.fresh).toBe(true);
		}
	});

	it("ContextReadResult not-found variant", () => {
		const result: ContextReadResult = { ok: false, kind: "not-found" };
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("not-found");
		}
	});
});
