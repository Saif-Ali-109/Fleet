// Fleet Context SoR — manager-side read-only retrieval service with freshness.
// Pure DB reads; no model calls. Used by MCP tools and CLI. Reads emit no audit events.

import type { Pool } from "pg";
import {
	type ContextCategory,
	type ContextReadResult,
	contextFreshness,
} from "./context.ts";

export interface ContextSourceRow {
	source_id: string;
	category: ContextCategory;
	version: number;
	hash: string;
	operational_state: unknown;
	fresh_until?: string;
	stale_after?: string;
	status: string;
	created_at: string;
}

export interface ListContextsResult {
	ok: true;
	items: {
		sourceId: string;
		category: ContextCategory;
		version: number;
		status: string;
	}[];
}

export type ListContextsResponse =
	| ListContextsResult
	| { ok: false; kind: "unavailable"; error: string };

export function resolveFreshness(row: ContextSourceRow): {
	fresh: boolean;
	staleAfter: string;
} {
	// Prefer explicit stamps; treat the stamp as authoritative when present.
	const stamp = row.fresh_until ?? row.stale_after;
	if (stamp) {
		const ts = Date.parse(stamp);
		const staleAfter = new Date(ts).toISOString();
		return { fresh: ts > Date.now(), staleAfter };
	}
	// No stamp: non-authoritative (fresh: false), staleAfter falls back to the category TTL.
	const fallback = contextFreshness({
		updatedAt: row.created_at,
		category: row.category,
	});
	return { fresh: false, staleAfter: fallback.staleAfter };
}

export async function getContext(
	pool: Pool,
	params: { sourceId?: string; category: ContextCategory; version?: number },
): Promise<ContextReadResult> {
	const { sourceId, category, version } = params;

	try {
		let sql = `
			SELECT
				source_id,
				category,
				version,
				hash,
				operational_state,
				fresh_until,
				stale_after,
				status,
				created_at
			FROM context_sor
			WHERE category = $1
		`;
		const values: unknown[] = [category];

		if (sourceId !== undefined) {
			sql += ` AND source_id = $${values.length + 1}`;
			values.push(sourceId);
		}
		if (version !== undefined) {
			sql += ` AND version = $${values.length + 1}`;
			values.push(version);
		} else {
			sql += ` AND status = 'active'`;
		}

		sql += ` ORDER BY version DESC LIMIT 1`;

		const result = await pool.query(sql, values);

		if (result.rows.length === 0) {
			return { ok: false, kind: "not-found" };
		}

		const row = result.rows[0] as ContextSourceRow;
		const { fresh, staleAfter } = resolveFreshness(row);

		return {
			ok: true,
			item: {
				state: row.operational_state,
				fresh,
				staleAfter,
				version: Number(row.version),
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, kind: "unavailable", error: message };
	}
}

export async function listContexts(
	pool: Pool,
	params?: { category?: ContextCategory },
): Promise<ListContextsResponse> {
	const { category } = params ?? {};
	try {
		let sql = `
			SELECT DISTINCT ON (source_id)
				source_id,
				category,
				version,
				status
			FROM context_sor
			WHERE status = 'active'
		`;
		const values: unknown[] = [];
		if (category !== undefined) {
			sql += ` AND category = $${values.length + 1}`;
			values.push(category);
		}
		sql += ` ORDER BY source_id, version DESC`;

		const result = await pool.query(sql, values);

		return {
			ok: true,
			items: result.rows.map((row) => ({
				sourceId: row.source_id,
				category: row.category as ContextCategory,
				version: Number(row.version),
				status: row.status,
			})),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, kind: "unavailable", error: message };
	}
}

export async function getOrgConstraints(
	pool: Pool,
): Promise<ContextReadResult> {
	return getContext(pool, { category: "org-constraints" });
}
