// Fleet Context SoR — manager-side controlled write path (NON-FATAL audit appends,
// §11.5). Agents never write: any `actor:"agent"` call is rejected here, in the
// service, before any DB interaction.

import type { Pool } from "pg";
import { appendAuditEvent } from "../db/audit.ts";
import { computeContextHash, ttlForCategory } from "./context.ts";
import type { ContextCategory } from "./context.ts";

export interface ContextUpdatePayload {
	sourceId: string;
	version: number;
	hash: string;
	prevVersion: number;
}

/** NON-FATAL `context_update` append via `appendAuditEvent`. Warns and continues on failure. */
export async function emitContextUpdateNonFatal(
	pool: Pool,
	payload: ContextUpdatePayload,
): Promise<void> {
	try {
		const event = {
			run_id: null,
			event_type: "context_update" as const,
			actor: "manager",
			backend: null,
			tool_name: null,
			tool_input: null,
			tool_output: null,
			payload: {
				sorType: "context",
				sourceId: payload.sourceId,
				namespace: "fleet",
				version: payload.version,
				hash: payload.hash,
				actor: "manager",
				ts: new Date().toISOString(),
				prevVersion: payload.prevVersion,
			},
			created_at: new Date().toISOString(),
		};
		await appendAuditEvent(pool, event);
	} catch (err) {
		console.warn(
			`[sor] context_update skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export interface PutContextInput {
	sourceId: string;
	category: ContextCategory;
	state: unknown;
	actor: "manager" | "agent";
	version?: number;
	now?: string;
}

export type PutContextResult =
	| { ok: true; kind: "added" | "updated" | "unchanged"; version: number }
	| { ok: false; reason: string };

interface ContextSorRow {
	version: number;
	hash: string;
}

/** Reject state that cannot be canonically serialized/hashed before any DB work.
 *  `undefined`, functions, and circular structures would otherwise surface as an
 *  opaque crash during hash computation (§4.4, FR-17). */
function validateContextState(state: unknown): string | null {
	if (
		state === undefined ||
		state === null ||
		typeof state === "function" ||
		typeof state === "symbol"
	) {
		return "malformed context state: not a valid operational_state object";
	}
	try {
		const serialized = JSON.stringify(state);
		if (typeof serialized !== "string") {
			return "malformed context state: not JSON-serializable";
		}
	} catch {
		return "malformed context state: not JSON-serializable";
	}
	return null;
}

/** Controlled write (§11.5). Rejects agents before touching the DB; rejects
 *  malformed state before any write. Emits NON-FATAL `context_update` on every
 *  versioned write AND on no-op unchanged writes; the audit append lives outside
 *  the context_sor transaction and never aborts the write. */
export async function putContext(
	pool: Pool,
	input: PutContextInput,
): Promise<PutContextResult> {
	if (input.actor === "agent") {
		return { ok: false, reason: "agents cannot write context" };
	}

	const malformed = validateContextState(input.state);
	if (malformed !== null) {
		return { ok: false, reason: malformed };
	}

	const hash = computeContextHash(input.state);

	const latest = await pool.query<ContextSorRow>(
		"SELECT version, hash FROM context_sor WHERE source_id = $1 ORDER BY version DESC LIMIT 1",
		[input.sourceId],
	);
	const prev = latest.rows[0] ?? null;

	if (prev !== null && prev.hash === hash) {
		await emitContextUpdateNonFatal(pool, {
			sourceId: input.sourceId,
			version: prev.version,
			hash,
			prevVersion: prev.version,
		});
		return { ok: true, kind: "unchanged", version: prev.version };
	}

	const nextVersion =
		prev === null
			? 1
			: input.version !== undefined && input.version > prev.version
				? input.version
				: prev.version + 1;

	const nowStr = input.now ?? new Date().toISOString();
	const ttlMs = ttlForCategory(input.category);
	const nowMs = Date.parse(nowStr);
	const staleAfter = new Date(nowMs + ttlMs).toISOString();

	const kind: "added" | "updated" = prev === null ? "added" : "updated";

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO context_sor
        (source_id, namespace, version, hash, category, operational_state, fresh_until, stale_after, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				input.sourceId,
				"fleet",
				nextVersion,
				hash,
				input.category,
				JSON.stringify(input.state),
				nowStr,
				staleAfter,
				"active",
				nowStr,
			],
		);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	await emitContextUpdateNonFatal(pool, {
		sourceId: input.sourceId,
		version: nextVersion,
		hash,
		prevVersion: prev?.version ?? 0,
	});

	return { ok: true, kind, version: nextVersion };
}
