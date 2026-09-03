// Fleet Content SoR — manager-side read-only retrieval service with provenance.
// Pure DB reads; no model calls. Used by MCP tools and CLI.

import type { Pool } from "pg";
import { appendAuditEvent } from "../db/audit.ts";
import type { SorEvent } from "../sor/events.ts";

export interface RetrievalItem {
	text: string;
	provenance: {
		source: string;
		document: string;
		section: string;
		version: number;
		content_hash: string;
	};
	score: number;
}

export type RetrievalResult =
	| { ok: true; kind: "hit"; items: RetrievalItem[] }
	| { ok: true; kind: "no-match"; query: string }
	| { ok: false; kind: "unavailable"; error: string };

export interface ListSourcesResult {
	source: string;
	document: string;
	version: number;
	status: string;
}

export interface GetDocumentParams {
	source: string;
	document: string;
	section?: string;
	version?: number;
}

export type GetDocumentResult =
	| { ok: true; item: RetrievalItem }
	| { ok: false; kind: "not-found" | "unavailable"; error?: string };

export interface ContentAccessAggregateParams {
	sessionId: string;
	mode: "aggregate" | "percall";
	count: number;
	topSources: string[];
}

function isVectorRankEnabled(): boolean {
	return process.env.CONTENT_EMBED_RANK === "true";
}

function buildFtsQuery(_query: string): string {
	// plainto_tsquery for deterministic lexical matching
	return `plainto_tsquery('english', $1)`;
}

export async function retrieveKnowledge(
	pool: Pool,
	params: {
		query: string;
		source?: string;
		limit?: number;
		queryEmbedding?: number[];
	},
): Promise<RetrievalResult> {
	const { query, source, limit = 10, queryEmbedding } = params;

	try {
		// Build the FTS query
		const ftsQuery = buildFtsQuery(query);
		const useVector =
			isVectorRankEnabled() &&
			queryEmbedding !== undefined &&
			queryEmbedding.length > 0;

		let sql: string;
		const values: unknown[] = [query];

		if (useVector) {
			// FTS rank primary, vector similarity as tiebreaker/rerank
			// We need to join content_chunks with content_sor to resolve provenance and filter invalid status
			sql = `
				SELECT
					cc.text,
					cc.section,
					cc.chunk_index,
					ts_rank_cd(to_tsvector('english', cc.text), ${ftsQuery}) AS fts_rank,
					(cc.embedding <=> $2) AS vector_dist,
					cs.metadata->>'source' AS source,
					cs.metadata->>'document' AS document,
					cs.version,
					cs.hash AS content_hash,
					cs.status
				FROM content_chunks cc
				JOIN content_sor cs
					ON cc.doc_id = cs.source_id
					AND cc.version = cs.version
				WHERE to_tsvector('english', cc.text) @@ ${ftsQuery}
					AND cs.status = 'active'
					${source ? "AND cs.metadata->>'source' = $3" : ""}
				ORDER BY fts_rank DESC, vector_dist ASC
				LIMIT ${limit}
			`;
			values.push(`[${queryEmbedding.join(",")}]`);
			if (source) values.push(source);
		} else {
			// FTS-only primary lookup
			sql = `
				SELECT
					cc.text,
					cc.section,
					cc.chunk_index,
					ts_rank_cd(to_tsvector('english', cc.text), ${ftsQuery}) AS fts_rank,
					cs.metadata->>'source' AS source,
					cs.metadata->>'document' AS document,
					cs.version,
					cs.hash AS content_hash,
					cs.status
				FROM content_chunks cc
				JOIN content_sor cs
					ON cc.doc_id = cs.source_id
					AND cc.version = cs.version
				WHERE to_tsvector('english', cc.text) @@ ${ftsQuery}
					AND cs.status = 'active'
					${source ? "AND cs.metadata->>'source' = $2" : ""}
				ORDER BY fts_rank DESC
				LIMIT ${limit}
			`;
			if (source) values.push(source);
		}

		const result = await pool.query(sql, values);

		if (result.rows.length === 0) {
			return { ok: true, kind: "no-match", query };
		}

		const items: RetrievalItem[] = result.rows.map((row) => ({
			text: row.text,
			provenance: {
				source: row.source,
				document: row.document,
				section: row.section,
				version: Number(row.version),
				content_hash: row.content_hash,
			},
			score: useVector
				? Number(row.fts_rank) * 0.7 + (1 - Number(row.vector_dist)) * 0.3
				: Number(row.fts_rank),
		}));

		return { ok: true, kind: "hit", items };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, kind: "unavailable", error: message };
	}
}

export async function listSources(pool: Pool): Promise<ListSourcesResult[]> {
	try {
		const sql = `
			SELECT DISTINCT
				metadata->>'source' AS source,
				metadata->>'document' AS document,
				version,
				status
			FROM content_sor
			WHERE status = 'active'
			ORDER BY source, document, version DESC
		`;
		const result = await pool.query(sql);
		return result.rows.map((row) => ({
			source: row.source,
			document: row.document,
			version: Number(row.version),
			status: row.status,
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[contentRetrieval] listSources failed: ${message}`);
		return [];
	}
}

export async function getDocument(
	pool: Pool,
	params: GetDocumentParams,
): Promise<GetDocumentResult> {
	const { source, document, section, version } = params;

	try {
		let sql = `
			SELECT
				cc.text,
				cc.section,
				cc.chunk_index,
				cs.metadata->>'source' AS source,
				cs.metadata->>'document' AS document,
				cs.version,
				cs.hash AS content_hash,
				cs.status
			FROM content_chunks cc
			JOIN content_sor cs
				ON cc.doc_id = cs.source_id
				AND cc.version = cs.version
			WHERE cs.metadata->>'source' = $1
				AND cs.metadata->>'document' = $2
				AND cs.status = 'active'
		`;
		const values: unknown[] = [source, document];

		if (version !== undefined) {
			sql += ` AND cs.version = $${values.length + 1}`;
			values.push(version);
		} else {
			// Latest active version
			sql += ` AND cs.version = (SELECT MAX(version) FROM content_sor WHERE metadata->>'source' = $1 AND metadata->>'document' = $2 AND status = 'active')`;
		}

		if (section !== undefined) {
			sql += ` AND cc.section = $${values.length + 1}`;
			values.push(section);
		}

		sql += ` ORDER BY cc.chunk_index ASC`;

		const result = await pool.query(sql, values);

		if (result.rows.length === 0) {
			return { ok: false, kind: "not-found" };
		}

		// Return the first chunk as the representative item (or concatenate if needed)
		// For v1, return the first matching chunk with full provenance
		const row = result.rows[0];
		const item: RetrievalItem = {
			text: row.text,
			provenance: {
				source: row.source,
				document: row.document,
				section: row.section,
				version: Number(row.version),
				content_hash: row.content_hash,
			},
			score: 1.0,
		};

		return { ok: true, item };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, kind: "unavailable", error: message };
	}
}

export function emitContentAccessAggregate(
	pool: Pool,
	params: ContentAccessAggregateParams,
): void {
	// NON-FATAL: fire and forget with warn on failure
	const event: SorEvent = {
		run_id: null,
		event_type: "content_access",
		actor: "manager",
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		payload: {
			sorType: "content",
			sourceId: "aggregate",
			namespace: "fleet",
			version: 1,
			hash: "aggregate",
			actor: "manager",
			ts: new Date().toISOString(),
			sessionId: params.sessionId,
			mode: params.mode,
			count: params.count,
			topSources: params.topSources,
		},
		created_at: new Date().toISOString(),
	};

	appendAuditEvent(pool, event).catch((err) => {
		console.warn(
			`[contentRetrieval] content_access aggregate emit failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	});
}
