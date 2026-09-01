// Tests for manager-side context retrieval with freshness.
// Recording-pool mock mirrors contentRetrieval.test.ts patterns.
// Reads emit NO audit events — assert only SELECTs are recorded.

import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
	getContext,
	getOrgConstraints,
	listContexts,
} from "../contextRetrieval.ts";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function recordingPool(
	rows: Record<string, unknown>[],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failMessage?: string },
): Pool {
	const client = {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (options?.shouldFail) {
				throw new Error(options.failMessage ?? "DB error");
			}
			return { rows };
		},
		release: () => {},
	};
	return {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (options?.shouldFail) {
				throw new Error(options.failMessage ?? "DB error");
			}
			return { rows };
		},
		connect: async () => client,
	} as unknown as Pool;
}

function activeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		source_id: "run:abc123",
		category: "run",
		version: 3,
		hash: "abc123",
		operational_state: { mood: "calm" },
		fresh_until: new Date(Date.now() + 60_000).toISOString(),
		stale_after: new Date(Date.now() + 60_000).toISOString(),
		status: "active",
		created_at: new Date(Date.now() - 60_000).toISOString(),
		...overrides,
	};
}

function onlySelects(recorded: RecordedQuery[]): boolean {
	return recorded.every((q) => /^\s*SELECT/i.test(q.text));
}

describe("getContext — retrieval with freshness and status/version filters", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
	});

	it("hit fresh: returns state, fresh:true, staleAfter, version within TTL stamp", async () => {
		const pool = recordingPool([activeRow()], recorded);
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.state).toEqual({ mood: "calm" });
		expect(res.item.fresh).toBe(true);
		expect(res.item.version).toBe(3);
		expect(res.item.staleAfter).toBeTruthy();
		expect(onlySelects(recorded)).toBe(true);
	});

	it("hit stale: row past its stamp returns state with fresh:false", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const pool = recordingPool(
			[activeRow({ fresh_until: past, stale_after: past })],
			recorded,
		);
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.fresh).toBe(false);
		expect(res.item.state).toEqual({ mood: "calm" });
		expect(res.item.staleAfter).toBeTruthy();
	});

	it("no fresh_until stamp: treated as stale with staleAfter from category TTL", async () => {
		const pool = recordingPool([activeRow({ fresh_until: undefined, stale_after: undefined })], recorded);
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.fresh).toBe(false);
		expect(res.item.staleAfter).toBeTruthy();
		expect(res.item.version).toBe(3);
	});

	it("not-found: no row returns kind not-found", async () => {
		const pool = recordingPool([], recorded);
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe("not-found");
	});

	it("unavailable: DB error maps to unavailable (distinct from not-found)", async () => {
		const pool = recordingPool([], recorded, { shouldFail: true, failMessage: "boom" });
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe("unavailable");
		expect(res.error).toBe("boom");
	});

	it("version lookup: specific version requested, status filter not enforced", async () => {
		const pool = recordingPool([activeRow({ version: 2, status: "superseded" })], recorded);
		const res = await getContext(pool, { category: "run", version: 2 });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.version).toBe(2);
		// version specified ⇒ no status='active' filter in the query
		expect(recorded.some((q) => /status\s*=\s*'active'/i.test(q.text))).toBe(false);
	});

	it("latest lookup filters by status='active'", async () => {
		const pool = recordingPool([activeRow()], recorded);
		const res = await getContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		expect(recorded.some((q) => /status\s*=\s*'active'/i.test(q.text))).toBe(true);
	});
});

describe("listContexts — distinct latest per sourceId", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
	});

	it("returns latest-per-source rows with shapes and only SELECTs", async () => {
		const pool = recordingPool(
			[
				{ source_id: "a", category: "run", version: 2, status: "active" },
				{ source_id: "b", category: "org-constraints", version: 1, status: "active" },
			],
			recorded,
		);
		const res = await listContexts(pool);

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.items).toHaveLength(2);
		expect(res.items[0]).toEqual({ sourceId: "a", category: "run", version: 2, status: "active" });
		expect(res.items[1]).toEqual({ sourceId: "b", category: "org-constraints", version: 1, status: "active" });
		expect(onlySelects(recorded)).toBe(true);
	});

	it("filters by category when provided", async () => {
		const pool = recordingPool([], recorded);
		await listContexts(pool, { category: "org-constraints" });

		expect(recorded[0]?.values).toContain("org-constraints");
		expect(onlySelects(recorded)).toBe(true);
	});

	it("unavailable: DB error returns unavailable", async () => {
		const pool = recordingPool([], recorded, { shouldFail: true, failMessage: "nope" });
		const res = await listContexts(pool);

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe("unavailable");
		expect(res.error).toBe("nope");
	});
});

describe("getOrgConstraints — thin wrapper over getContext", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
	});

	it("returns latest active org-constraints freshness item", async () => {
		const pool = recordingPool(
			[activeRow({ category: "org-constraints", source_id: "org-acme" })],
			recorded,
		);
		const res = await getOrgConstraints(pool);

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.version).toBe(3);
		expect(recorded[0]?.values).toContain("org-constraints");
		expect(onlySelects(recorded)).toBe(true);
	});
});
