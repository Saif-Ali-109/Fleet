// Fleet Content SoR — manager-side DB write path (NON-FATAL appends).

import type { Pool } from "pg";
import { appendAuditEvent } from "../db/audit.ts";
import type { ContentDoc, ContentChunk, SyncKind } from "./content.ts";

export interface ContentSyncPayload {
	kind: SyncKind;
	status: ContentDoc["status"];
	sourceId: string;
	version: number;
}

/** NON-FATAL `content_sync` append via `appendAuditEvent`. Warns and continues on failure. */
export async function emitContentSyncNonFatal(
	pool: Pool,
	payload: ContentSyncPayload,
): Promise<void> {
	try {
		const event = {
			run_id: null,
			event_type: "content_sync" as const,
			actor: "manager",
			backend: null,
			tool_name: null,
			tool_input: null,
			tool_output: null,
			payload: {
				sorType: "content",
				sourceId: payload.sourceId,
				namespace: "fleet",
				version: payload.version,
				hash: "", // will be filled by caller if needed; content_sync payload per §12.2 doesn't require hash
				actor: "manager",
				ts: new Date().toISOString(),
				kind: payload.kind,
				status: payload.status,
			},
			created_at: new Date().toISOString(),
		};
		await appendAuditEvent(pool, event);
	} catch (err) {
		console.warn(
			`[sor] content_sync skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Upserts a document and its chunks into content_sor + content_chunks.
 * - If doc hash already exists (UNIQUE on source_id, version): unchanged — emit content_sync unchanged, no writes.
 * - For added/updated: transactional insert sor row, delete old chunks, insert new chunks, emit content_sync.
 * Returns { kind, version }.
 */
export async function upsertDocument(
	pool: Pool,
	doc: ContentDoc,
	chunks: ContentChunk[],
): Promise<{ kind: "added" | "updated" | "unchanged"; version: number }> {
	// Check if this exact (source_id, version) already exists
	const existing = await pool.query<{ hash: string }>(
		"SELECT hash FROM content_sor WHERE source_id = $1 AND version = $2",
		[doc.sourceId, doc.version],
	);

	if (existing.rows.length > 0) {
		const existingHash = existing.rows[0]!.hash;
		if (existingHash === doc.hash) {
			// Unchanged — emit content_sync and return
			await emitContentSyncNonFatal(pool, {
				kind: "unchanged",
				status: doc.status,
				sourceId: doc.sourceId,
				version: doc.version,
			});
			return { kind: "unchanged", version: doc.version };
		}
		// Different hash for same version — treat as updated (caller should bump version via syncOutcome)
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Insert the content_sor row
		await client.query(
			`INSERT INTO content_sor (source_id, namespace, version, hash, canonical_content, metadata, provenance, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
			[
				doc.sourceId,
				doc.namespace,
				doc.version,
				doc.hash,
				doc.canonicalContent,
				JSON.stringify(doc.metadata),
				JSON.stringify(doc.provenance),
				doc.status,
			],
		);

		// Delete old chunks for this doc_id + version
		await client.query(
			"DELETE FROM content_chunks WHERE doc_id = $1 AND version = $2",
			[doc.sourceId, doc.version],
		);

		// Insert new chunks
		for (const chunk of chunks) {
			await client.query(
				`INSERT INTO content_chunks (doc_id, version, section, chunk_index, text, content_hash, embedding, ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[
					chunk.docId,
					chunk.version,
					chunk.section,
					chunk.chunkIndex,
					chunk.text,
					chunk.contentHash,
					chunk.embedding,
					JSON.stringify(chunk.ref),
				],
			);
		}

		await client.query("COMMIT");

		const kind: "added" | "updated" = existing.rows.length > 0 ? "updated" : "added";
		await emitContentSyncNonFatal(pool, {
			kind,
			status: doc.status,
			sourceId: doc.sourceId,
			version: doc.version,
		});

		return { kind, version: doc.version };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}