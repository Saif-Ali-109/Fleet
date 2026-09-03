import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentChunk, ContentDoc } from "../content.ts";
import { emitContentSyncNonFatal, upsertDocument } from "../contentStore.ts";

const TEST_KEY = "test-signing-key-for-content-store";
let savedKey: string | undefined;
let savedKeyId: string | undefined;
let savedKeyV1: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyId = process.env.SOR_KEY_ID;
	savedKeyV1 = process.env.SOR_KEY_V1;
	process.env.SOR_SIGNING_KEY = TEST_KEY;
	process.env.SOR_KEY_V1 = TEST_KEY;
	process.env.SOR_KEY_ID = "v1";
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env.SOR_SIGNING_KEY;
	} else {
		process.env.SOR_SIGNING_KEY = savedKey;
	}
	if (savedKeyId === undefined) {
		delete process.env.SOR_KEY_ID;
	} else {
		process.env.SOR_KEY_ID = savedKeyId;
	}
	if (savedKeyV1 === undefined) {
		delete process.env.SOR_KEY_V1;
	} else {
		process.env.SOR_KEY_V1 = savedKeyV1;
	}
});

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function recordingClient(
	rows: unknown[][],
	recorded: RecordedQuery[],
	shouldFail = false,
	failOnQuery?: string,
) {
	let queryIndex = 0;
	return {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);

			if (shouldFail && failOnQuery && q.text.includes(failOnQuery)) {
				throw new Error(`forced failure on ${failOnQuery}`);
			}

			// Return chain row for FOR UPDATE query (sor_chain lookup)
			if (q.text.includes("FOR UPDATE")) {
				return { rows: [{ seq: "0", hash: "genesis-hash", key_id: "v1" }] };
			}

			const result = rows[queryIndex] ?? [];
			queryIndex++;
			return { rows: result };
		},
		release: () => {},
	};
}

function recordingPool(
	rows: unknown[][],
	recorded: RecordedQuery[],
	shouldFail = false,
	failOnQuery?: string,
): Pool {
	const client = recordingClient(rows, recorded, shouldFail, failOnQuery);
	return {
		query: client.query,
		connect: async () => client,
	} as unknown as Pool;
}

function makeDoc(overrides: Partial<ContentDoc> = {}): ContentDoc {
	return {
		sorType: "content",
		sourceId: "fleet|content|md:test.md",
		namespace: "fleet",
		version: 1,
		hash: "abc123",
		status: "active",
		canonicalContent: "canonical content body",
		metadata: { source: "fleet", document: "test", title: "Test" },
		provenance: { acquiredAt: "2024-01-01T00:00:00Z" },
		...overrides,
	};
}

function makeChunk(overrides: Partial<ContentChunk> = {}): ContentChunk {
	return {
		docId: "fleet|content|md:test.md",
		version: 1,
		section: "root",
		chunkIndex: 0,
		text: "chunk text",
		contentHash: "chunkhash123",
		embedding: null,
		ref: {
			sorType: "content",
			sourceId: "fleet|content|md:test.md",
			version: 1,
			hash: "abc123",
		},
		...overrides,
	};
}

describe("upsertDocument — content store write path", () => {
	it("added: no prior row ⇒ inserts sor + chunks + emits content_sync added", async () => {
		const recorded: RecordedQuery[] = [];
		// No existing row
		const pool = recordingPool([[]], recorded);

		const doc = makeDoc({ version: 1 });
		const chunks = [makeChunk(), makeChunk({ chunkIndex: 1, text: "chunk 2" })];

		const result = await upsertDocument(pool, doc, chunks);
		expect(result).toEqual({ kind: "added", version: 1 });

		// Check INSERT INTO content_sor
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO content_sor"),
		);
		expect(insertSor).toBeDefined();
		expect(insertSor?.values).toEqual([
			doc.sourceId,
			doc.namespace,
			doc.version,
			doc.hash,
			doc.canonicalContent,
			JSON.stringify(doc.metadata),
			JSON.stringify(doc.provenance),
			doc.status,
		]);

		// Check DELETE FROM content_chunks
		const deleteChunks = recorded.find((q) =>
			q.text.includes("DELETE FROM content_chunks"),
		);
		expect(deleteChunks).toBeDefined();
		expect(deleteChunks?.values).toEqual([doc.sourceId, doc.version]);

		// Check INSERT INTO content_chunks (two chunks)
		const insertChunks = recorded.filter((q) =>
			q.text.includes("INSERT INTO content_chunks"),
		);
		expect(insertChunks).toHaveLength(2);

		// Check content_sync event appended (kind: "added")
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("added");
		expect(payload.status).toBe("active");
		expect(payload.sourceId).toBe(doc.sourceId);
		expect(payload.version).toBe(1);
	});

	it("updated: hash changed, version bump ⇒ deletes old chunks + inserts new + emits content_sync updated", async () => {
		const recorded: RecordedQuery[] = [];
		// Existing row with different hash
		const pool = recordingPool(
			[[{ hash: "different-hash" }]], // existing row
			recorded,
		);

		const doc = makeDoc({ version: 2, hash: "new-hash" });
		const chunks = [makeChunk({ version: 2 })];

		const result = await upsertDocument(pool, doc, chunks);
		expect(result).toEqual({ kind: "updated", version: 2 });

		// Check INSERT INTO content_sor
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO content_sor"),
		);
		expect(insertSor).toBeDefined();

		// Check DELETE FROM content_chunks
		const deleteChunks = recorded.find((q) =>
			q.text.includes("DELETE FROM content_chunks"),
		);
		expect(deleteChunks).toBeDefined();
		expect(deleteChunks?.values).toEqual([doc.sourceId, doc.version]);

		// Check INSERT INTO content_chunks
		const insertChunks = recorded.filter((q) =>
			q.text.includes("INSERT INTO content_chunks"),
		);
		expect(insertChunks).toHaveLength(1);

		// Check content_sync event (kind: "updated")
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("updated");
		expect(payload.version).toBe(2);
	});

	it("unchanged: same hash ⇒ NO writes, emits content_sync unchanged", async () => {
		const recorded: RecordedQuery[] = [];
		// Existing row with SAME hash
		const pool = recordingPool(
			[[{ hash: "abc123" }]], // existing row with matching hash
			recorded,
		);

		const doc = makeDoc({ version: 1, hash: "abc123" });
		const chunks = [makeChunk()];

		const result = await upsertDocument(pool, doc, chunks);
		expect(result).toEqual({ kind: "unchanged", version: 1 });

		// No INSERT INTO content_sor
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO content_sor"),
		);
		expect(insertSor).toBeUndefined();

		// No DELETE FROM content_chunks
		const deleteChunks = recorded.find((q) =>
			q.text.includes("DELETE FROM content_chunks"),
		);
		expect(deleteChunks).toBeUndefined();

		// No INSERT INTO content_chunks
		const insertChunks = recorded.filter((q) =>
			q.text.includes("INSERT INTO content_chunks"),
		);
		expect(insertChunks).toHaveLength(0);

		// But content_sync event IS emitted (kind: "unchanged")
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("unchanged");
		expect(payload.version).toBe(1);
	});

	it("NON-FATAL: forced query reject on audit append ⇒ warns + continues, no throw", async () => {
		const recorded: RecordedQuery[] = [];
		// Force failure on the audit_events insert
		const pool = recordingPool(
			[[]],
			recorded,
			true,
			"INSERT INTO audit_events",
		);

		const doc = makeDoc({ version: 1 });
		const chunks = [makeChunk()];

		// Should not throw
		const result = await upsertDocument(pool, doc, chunks);
		expect(result).toEqual({ kind: "added", version: 1 });

		// The sor row and chunks should still have been inserted
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO content_sor"),
		);
		expect(insertSor).toBeDefined();

		// The audit insert was attempted but failed
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
	});

	it("unparseable source ⇒ status:'invalid' row inserted, never served (via T2 status field)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[]], recorded);

		const doc = makeDoc({ status: "invalid", version: 1 });
		const chunks = [makeChunk()];

		const result = await upsertDocument(pool, doc, chunks);
		expect(result).toEqual({ kind: "added", version: 1 });

		// Check that status 'invalid' was persisted
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO content_sor"),
		);
		expect(insertSor).toBeDefined();
		expect(insertSor?.values?.[7]).toBe("invalid");

		// content_sync emits with status 'invalid'
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.status).toBe("invalid");
	});
});

describe("emitContentSyncNonFatal — NON-FATAL helper", () => {
	it("wraps appendAuditEvent in try/catch, warns on failure, never throws", async () => {
		const recorded: RecordedQuery[] = [];
		// Force failure on audit_events insert
		const pool = recordingPool(
			[[{ seq: "0", hash: "genesis" }]],
			recorded,
			true,
			"INSERT INTO audit_events",
		);

		// Should not throw
		await expect(
			emitContentSyncNonFatal(pool, {
				kind: "added",
				status: "active",
				sourceId: "test",
				version: 1,
			}),
		).resolves.toBeUndefined();

		// Audit insert was attempted
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
	});

	it("on success, appends content_sync event with correct payload shape", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[{ seq: "0", hash: "genesis" }]], recorded);

		await emitContentSyncNonFatal(pool, {
			kind: "updated",
			status: "active",
			sourceId: "fleet|content|md:doc.md",
			version: 3,
		});

		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("updated");
		expect(payload.status).toBe("active");
		expect(payload.sourceId).toBe("fleet|content|md:doc.md");
		expect(payload.version).toBe(3);
		expect(payload.sorType).toBe("content");
		expect(payload.namespace).toBe("fleet");
		expect(payload.actor).toBe("manager");
		expect(typeof payload.ts).toBe("string");
	});
});
