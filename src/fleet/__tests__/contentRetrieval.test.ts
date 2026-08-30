// Tests for manager-side content retrieval with provenance.
// Recording-pool mock + optional real-DB pattern.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock appendAuditEvent at the top level using vi.hoisted so it's available before imports
const { mockAppendAuditEvent } = vi.hoisted(() => ({
	mockAppendAuditEvent: vi.fn(),
}));

vi.mock("../../db/audit.ts", () => ({
	appendAuditEvent: mockAppendAuditEvent,
}));

import {
	emitContentAccessAggregate,
	getDocument,
	listSources,
	retrieveKnowledge,
} from "../contentRetrieval.ts";
import type { SorEvent } from "../../sor/events.ts";

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

describe("retrieveKnowledge — FTS primary, provenance, unavailable≠no-match", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		delete process.env.CONTENT_EMBED_RANK;
		mockAppendAuditEvent.mockReset();
	});

	afterEach(() => {
		delete process.env.CONTENT_EMBED_RANK;
	});

	it("builds correct FTS SQL with plainto_tsquery and ts_rank_cd", async () => {
		const pool = recordingPool(
			[
				{
					text: "chunk text",
					section: "Section One",
					chunk_index: 0,
					fts_rank: "0.5",
					source: "fleet",
					document: "guide",
					version: 1,
					content_hash: "dochash123",
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "test query", limit: 5 });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.text).toBe("chunk text");
		}

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert).toBeDefined();
		expect(insert?.text).toContain("plainto_tsquery('english', $1)");
		expect(insert?.text).toContain("ts_rank_cd(to_tsvector('english', cc.text)");
		expect(insert?.text).toContain("JOIN content_sor cs");
		expect(insert?.text).toContain("cs.status = 'active'");
	});

	it("provenance tuple has exact 5 fields with content_hash = doc hash", async () => {
		const pool = recordingPool(
			[
				{
					text: "content",
					section: "Section A",
					chunk_index: 0,
					fts_rank: "0.8",
					source: "fleet",
					document: "doc1",
					version: 2,
					content_hash: "canonicaldochash456",
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "content" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			const item = result.items[0]!;
			expect(item.provenance).toEqual({
				source: "fleet",
				document: "doc1",
				section: "Section A",
				version: 2,
				content_hash: "canonicaldochash456",
			});
			// content_hash must be the canonical document hash, not chunk hash
			expect(item.provenance.content_hash).toBe("canonicaldochash456");
		}
	});

	it("returns no-match when zero hits (ok=true, kind=no-match)", async () => {
		const pool = recordingPool([], recorded);

		const result = await retrieveKnowledge(pool, { query: "nonexistent" });

		expect(result).toEqual({ ok: true, kind: "no-match", query: "nonexistent" });
	});

	it("returns unavailable on DB error (ok=false, kind=unavailable)", async () => {
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "connection timeout",
		});

		const result = await retrieveKnowledge(pool, { query: "test" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unavailable");
			expect(result.error).toContain("connection timeout");
		}
	});

	it("filters out chunks whose content_sor row has status='invalid' (K3/C1)", async () => {
		const pool = recordingPool(
			[
				{
					text: "valid chunk",
					section: "Section A",
					chunk_index: 0,
					fts_rank: "0.6",
					source: "fleet",
					document: "valid",
					version: 1,
					content_hash: "validhash",
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "chunk" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.provenance.document).toBe("valid");
		}
		// Verify the SQL includes the status filter
		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("cs.status = 'active'");
	});

	it("applies source filter when provided", async () => {
		const pool = recordingPool(
			[
				{
					text: "source specific",
					section: "Sec",
					chunk_index: 0,
					fts_rank: "0.7",
					source: "fleet",
					document: "doc",
					version: 1,
					content_hash: "hash1",
					status: "active",
				},
			],
			recorded,
		);

		await retrieveKnowledge(pool, { query: "test", source: "fleet" });

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("cs.metadata->>'source' = $");
		expect(insert?.values).toContain("fleet");
	});

	it("vector ranking opt-in via CONTENT_EMBED_RANK=true with queryEmbedding", async () => {
		process.env.CONTENT_EMBED_RANK = "true";

		const pool = recordingPool(
			[
				{
					text: "vector ranked",
					section: "Sec",
					chunk_index: 0,
					fts_rank: "0.5",
					vector_dist: "0.1",
					source: "fleet",
					document: "doc",
					version: 1,
					content_hash: "hash1",
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, {
			query: "test",
			queryEmbedding: [0.1, 0.2, 0.3],
		});

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items[0]!.score).toBeGreaterThan(0);
		}

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("cc.embedding <=> $2");
		expect(insert?.text).toContain("ORDER BY fts_rank DESC, vector_dist ASC");
		expect(insert?.values?.[1]).toBe("[0.1,0.2,0.3]");
	});

	it("vector ranking disabled by default (no CONTENT_EMBED_RANK)", async () => {
		const pool = recordingPool(
			[
				{
					text: "fts only",
					section: "Sec",
					chunk_index: 0,
					fts_rank: "0.5",
					source: "fleet",
					document: "doc",
					version: 1,
					content_hash: "hash1",
					status: "active",
				},
			],
			recorded,
		);

		// Even with queryEmbedding provided, vector ranking should not apply without env
		await retrieveKnowledge(pool, {
			query: "test",
			queryEmbedding: [0.1, 0.2, 0.3],
		});

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).not.toContain("cc.embedding <=>");
		expect(insert?.text).toContain("ORDER BY fts_rank DESC");
	});
});

describe("listSources — distinct sources from content_sor", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		mockAppendAuditEvent.mockReset();
	});

	it("returns distinct source/document/version/status for active rows", async () => {
		const pool = recordingPool(
			[
				{ source: "fleet", document: "guide", version: "2", status: "active" },
				{ source: "fleet", document: "api", version: "1", status: "active" },
				{ source: "external", document: "spec", version: "3", status: "active" },
			],
			recorded,
		);

		const result = await listSources(pool);

		expect(result).toHaveLength(3);
		expect(result[0]!).toEqual({
			source: "fleet",
			document: "guide",
			version: 2,
			status: "active",
		});
		expect(result[2]!).toEqual({
			source: "external",
			document: "spec",
			version: 3,
			status: "active",
		});
	});

	it("returns empty array on DB error (NON-FATAL, warns)", async () => {
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "pool exhausted",
		});

		const result = await listSources(pool);

		expect(result).toEqual([]);
	});
});

describe("getDocument — exact document lookup with provenance", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		mockAppendAuditEvent.mockReset();
	});

	it("returns item with full provenance when found", async () => {
		const pool = recordingPool(
			[
				{
					text: "document content",
					section: "Introduction",
					chunk_index: 0,
					source: "fleet",
					document: "guide",
					version: "1",
					content_hash: "dochash789",
					status: "active",
				},
			],
			recorded,
		);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "guide",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.provenance).toEqual({
				source: "fleet",
				document: "guide",
				section: "Introduction",
				version: 1,
				content_hash: "dochash789",
			});
			expect(result.item.text).toBe("document content");
			expect(result.item.score).toBe(1.0);
		}
	});

	it("uses latest active version when version omitted", async () => {
		const pool = recordingPool(
			[
				{
					text: "latest version content",
					section: "Intro",
					chunk_index: 0,
					source: "fleet",
					document: "guide",
					version: "3",
					content_hash: "latesthash",
					status: "active",
				},
			],
			recorded,
		);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "guide",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.provenance.version).toBe(3);
		}

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("MAX(version)");
	});

	it("filters by specific version when provided", async () => {
		const pool = recordingPool(
			[
				{
					text: "v2 content",
					section: "Intro",
					chunk_index: 0,
					source: "fleet",
					document: "guide",
					version: "2",
					content_hash: "v2hash",
					status: "active",
				},
			],
			recorded,
		);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "guide",
			version: 2,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.provenance.version).toBe(2);
		}

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("cs.version = $3");
		expect(insert?.values).toContain(2);
	});

	it("filters by section when provided", async () => {
		const pool = recordingPool(
			[
				{
					text: "section content",
					section: "API Reference",
					chunk_index: 5,
					source: "fleet",
					document: "guide",
					version: "1",
					content_hash: "hash",
					status: "active",
				},
			],
			recorded,
		);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "guide",
			section: "API Reference",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.provenance.section).toBe("API Reference");
		}

		const insert = recorded.find((q) =>
			q.text.includes("FROM content_chunks cc"),
		);
		expect(insert?.text).toContain("cc.section = $");
		expect(insert?.values).toContain("API Reference");
	});

	it("returns not-found when no matching document", async () => {
		const pool = recordingPool([], recorded);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "nonexistent",
		});

		expect(result).toEqual({ ok: false, kind: "not-found" });
	});

	it("returns unavailable on DB error", async () => {
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "connection refused",
		});

		const result = await getDocument(pool, {
			source: "fleet",
			document: "guide",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unavailable");
			expect(result.error).toContain("connection refused");
		}
	});
});

describe("emitContentAccessAggregate — NON-FATAL session aggregate event", () => {
	let recorded: RecordedQuery[];
	let savedKey: string | undefined;
	let savedKeyId: string | undefined;

	beforeEach(() => {
		recorded = [];
		savedKey = process.env.SOR_SIGNING_KEY;
		savedKeyId = process.env.SOR_KEY_ID;
		process.env.SOR_SIGNING_KEY = "test-signing-key";
		process.env.SOR_KEY_V1 = "test-signing-key";
		process.env.SOR_KEY_ID = "v1";
		mockAppendAuditEvent.mockReset();
		mockAppendAuditEvent.mockResolvedValue(undefined);
	});

	afterEach(() => {
		if (savedKey === undefined) delete process.env.SOR_SIGNING_KEY;
		else process.env.SOR_SIGNING_KEY = savedKey;
		if (savedKeyId === undefined) delete process.env.SOR_KEY_ID;
		else process.env.SOR_KEY_ID = savedKeyId;
	});

	it("calls appendAuditEvent with content_access event shape (G5 locked)", async () => {
		const pool = recordingPool([], recorded);
		emitContentAccessAggregate(pool, {
			sessionId: "sess-123",
			mode: "aggregate",
			count: 5,
			topSources: ["fleet", "external"],
		});

		// Give the microtask queue a tick
		await new Promise((r) => setTimeout(r, 10));

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const calledEvent = mockAppendAuditEvent.mock.calls[0]?.[1] as SorEvent;
		expect(calledEvent.event_type).toBe("content_access");
		expect(calledEvent.actor).toBe("manager");
		expect(calledEvent.payload).toMatchObject({
			sorType: "content",
			sourceId: "aggregate",
			namespace: "fleet",
			sessionId: "sess-123",
			mode: "aggregate",
			count: 5,
			topSources: ["fleet", "external"],
		});
	});

	it("supports percall mode opt-in", async () => {
		const pool = recordingPool([], recorded);
		emitContentAccessAggregate(pool, {
			sessionId: "sess-456",
			mode: "percall",
			count: 1,
			topSources: ["fleet"],
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const calledEvent = mockAppendAuditEvent.mock.calls[0]?.[1] as SorEvent;
		expect(calledEvent.payload.mode).toBe("percall");
	});

	it("never throws — failures are caught and warned (NON-FATAL)", async () => {
		mockAppendAuditEvent.mockRejectedValue(new Error("chain locked"));

		const pool = recordingPool([], recorded);
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Should not throw
		await emitContentAccessAggregate(pool, {
			sessionId: "sess-789",
			mode: "aggregate",
			count: 1,
			topSources: [],
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[contentRetrieval] content_access aggregate emit failed"),
		);

		consoleWarn.mockRestore();
	});
});