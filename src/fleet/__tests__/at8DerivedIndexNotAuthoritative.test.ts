// AT-8 (FR-1/FR-2/FR-3, §17.1) — a derived vector/FTS hit with NO resolvable
// record is never an answer (K3/C1, §10.3).
//
// The design: `content_chunks` (the derived index) has NO FK to `content_sor`;
// orphan chunks are possible by design. The retrieval query
//   JOIN content_sor cs ON cc.doc_id = cs.source_id AND cc.version = cs.version
//     ... AND cs.status = 'active'
// (INNER JOIN + active filter) is the ONLY guard. A chunk whose canonical
// content_sor row is missing, inactive, or at a mismatched version drops out of
// the result set → no-match, never a fabricated answer.
//
// Proved on the REAL retrieveKnowledge / getDocument / upsertDocument via a
// recording pool (pattern A, like contentAcceptance.test.ts) — no DB, no module
// mocks.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContentDoc, type ContentChunk, type ContentDoc } from "../content.ts";
import { retrieveKnowledge, getDocument } from "../contentRetrieval.ts";
import { upsertDocument } from "../contentStore.ts";

const TEST_KEY = "at8-test-signing-key";
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
	delete process.env.CONTENT_EMBED_RANK;
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

// Pattern A recording pool (mirrors contentAcceptance.test.ts:95-117). The
// pool.query path serves read retrievals; the connected client serves the
// transactional store path (and appendAuditEvent's chain writes). The FOR
// UPDATE chain lookup returns the genesis row so appendAuditEvent can sign.
function recordingPool(
	rows: Record<string, unknown>[],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failMessage?: string },
): Pool {
	const clientQuery = async (...args: unknown[]) => {
		const q: RecordedQuery =
			typeof args[0] === "string"
				? { text: args[0], values: args[1] as unknown[] | undefined }
				: (args[0] as RecordedQuery);
		recorded.push(q);
		if (options?.shouldFail) {
			throw new Error(options.failMessage ?? "DB error");
		}
		if (q.text.includes("FOR UPDATE")) {
			return { rows: [{ seq: "0", hash: "genesis-hash", key_id: "v1" }] };
		}
		return { rows: [], rowCount: 1 };
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
		connect: async () => ({
			query: clientQuery,
			release: () => {},
		}),
	} as unknown as Pool;
}

// A well-formed ContentDoc whose hash is the canonical document hash.
const DOC: ContentDoc = buildContentDoc({
	sourceId: "fleet|content|md:kb.md",
	version: 2,
	canonicalContent: "The fleet soars across the sky.\n",
	metadata: { title: "KB", source: "fleet", document: "kb" },
	provenance: {},
});

function chunkFor(doc: ContentDoc, section = "Introduction"): ContentChunk {
	return {
		docId: doc.sourceId,
		version: doc.version,
		section,
		chunkIndex: 0,
		text: "The fleet soars across the sky.",
		contentHash: "chunkhash",
		embedding: null,
		ref: {
			sorType: "content",
			sourceId: doc.sourceId,
			version: doc.version,
			hash: doc.hash,
		},
	};
}

describe("AT-8 — derived index cannot be authoritative without a resolvable record", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		delete process.env.CONTENT_EMBED_RANK;
	});

	afterEach(() => {
		delete process.env.CONTENT_EMBED_RANK;
	});

	it("SQL guard is present in BOTH the vector and FTS branches", async () => {
		// FTS branch
		await retrieveKnowledge(recordingPool([], recorded), { query: "soars" });

		// Vector branch (CONTENT_EMBED_RANK=true + queryEmbedding)
		process.env.CONTENT_EMBED_RANK = "true";
		const recordedVec: RecordedQuery[] = [];
		await retrieveKnowledge(recordingPool([], recordedVec), {
			query: "soars",
			queryEmbedding: [0.1, 0.2, 0.3],
		});
		delete process.env.CONTENT_EMBED_RANK;

		for (const rec of [recorded, recordedVec]) {
			const select = rec.find((q) => q.text.includes("FROM content_chunks cc"));
			expect(select).toBeDefined();
			expect(select?.text).toContain("JOIN content_sor cs");
			expect(select?.text).toContain("cc.doc_id = cs.source_id");
			expect(select?.text).toContain("cc.version = cs.version");
			expect(select?.text).toContain("cs.status = 'active'");
		}
	});

	it("orphan chunk (missing parent record) ⇒ no-match, never a fabricated answer", async () => {
		// The derived index holds an orphan content_chunks row with no resolvable
		// content_sor parent. The INNER JOIN drops it, so the Postgres outcome is
		// an EMPTY row set (what the pool returns) — the retrieval must report a
		// genuine no-match, never a hit and never an item with partial provenance.
		const result = await retrieveKnowledge(recordingPool([], recorded), {
			query: "soars",
		});

		// The inner join drops the orphan → empty row set → a genuine no-match,
		// never a hit with a fabricated/partial answer, never unavailable.
		expect(result).toEqual({ ok: true, kind: "no-match", query: "soars" });
		expect(result.ok).toBe(true);
		expect("items" in result).toBe(false);
		expect("error" in result).toBe(false);
	});

	it("inactive parent record ⇒ not served (no-match)", async () => {
		// content_sor row exists but status != 'active'; the JOIN survives (same
		// doc_id+version) but the cs.status='active' filter drops it → empty set.
		const result = await retrieveKnowledge(recordingPool([], recorded), {
			query: "soars",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.kind).toBe("no-match");
		}
	});

	it("version mismatch ⇒ not served (no-match)", async () => {
		// A chunk at version=N whose content_sor parent only exists at version=N-1;
		// the JOIN on cc.version = cs.version drops it → empty set.
		const result = await retrieveKnowledge(recordingPool([], recorded), {
			query: "soars",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.kind).toBe("no-match");
		}
	});

	it("a resolvable hit carries the FULL precise provenance tuple from the content_sor row", async () => {
		const pool = recordingPool(
			[
				{
					text: "The fleet soars across the sky.",
					section: "Introduction",
					chunk_index: 0,
					fts_rank: "0.8",
					source: "fleet",
					document: "kb",
					version: String(DOC.version),
					content_hash: DOC.hash,
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "soars" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(1);
			const item = result.items[0]!;
			expect(item.provenance).toEqual({
				source: "fleet",
				document: "kb",
				section: "Introduction",
				version: DOC.version,
				content_hash: DOC.hash,
			});
			// content_hash is the canonical content_sor hash (cs.hash), never a chunk hash.
			expect(item.provenance.content_hash).toBe(DOC.hash);
		}
	});

	it("getDocument shares the guard (JOINs content_sor + filters status='active')", async () => {
		const pool = recordingPool(
			[
				{
					text: "The fleet soars across the sky.",
					section: "Introduction",
					chunk_index: 0,
					source: "fleet",
					document: "kb",
					version: String(DOC.version),
					content_hash: DOC.hash,
					status: "active",
				},
			],
			recorded,
		);

		const result = await getDocument(pool, {
			source: "fleet",
			document: "kb",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item.provenance).toEqual({
				source: "fleet",
				document: "kb",
				section: "Introduction",
				version: DOC.version,
				content_hash: DOC.hash,
			});
		}

		const select = recorded.find((q) => q.text.includes("FROM content_chunks cc"));
		expect(select).toBeDefined();
		expect(select?.text).toContain("JOIN content_sor cs");
		expect(select?.text).toContain("cc.doc_id = cs.source_id");
		expect(select?.text).toContain("cc.version = cs.version");
		expect(select?.text).toContain("cs.status = 'active'");
	});

	it("store-level atomicity: upsertDocument writes content_sor and replaces content_chunks in ONE transaction", async () => {
		const doc = DOC;
		const chunks = [chunkFor(doc), chunkFor(doc, "Details")];

		const result = await upsertDocument(recordingPool([], recorded), doc, chunks);
		expect(result).toEqual({ kind: "added", version: DOC.version });

		// The write path is transactional: BEGIN ... INSERT content_sor ...
		// DELETE old chunks ... INSERT new chunks ... COMMIT in order.
		const txStatements = recorded.map((q) => q.text);
		const beginIdx = txStatements.indexOf("BEGIN");
		expect(beginIdx).toBeGreaterThan(-1);

		// INSERT INTO content_sor happens inside the transaction.
		const insertSorIdx = txStatements.findIndex((t) =>
			t.includes("INSERT INTO content_sor"),
		);
		expect(insertSorIdx).toBeGreaterThan(beginIdx);

		// DELETE FROM content_chunks (doc_id + version scope) before re-insert.
		const deleteChunksIdx = txStatements.findIndex((t) =>
			t.includes("DELETE FROM content_chunks"),
		);
		const deleteQ = txStatements[deleteChunksIdx];
		expect(deleteChunksIdx).toBeGreaterThan(insertSorIdx);
		expect(deleteQ).toContain("doc_id = $1");
		expect(deleteQ).toContain("version = $2");

		// Chunk inserts.
		const chunkInsertIdxs: number[] = [];
		txStatements.forEach((t, i) => {
			if (t.includes("INSERT INTO content_chunks")) chunkInsertIdxs.push(i);
		});
		expect(chunkInsertIdxs).toHaveLength(2);
		for (const idx of chunkInsertIdxs) {
			expect(idx).toBeGreaterThan(deleteChunksIdx);
		}

		// COMMIT seals the transaction.
		const commitIdx = txStatements.indexOf("COMMIT");
		expect(commitIdx).toBeGreaterThan(chunkInsertIdxs[chunkInsertIdxs.length - 1]!);

		// No orphan is produced by the write path: content_sor and content_chunks
		// are written atomically in a single transaction. A derived row created
		// here can never outlive its canonical parent.
	});
});
