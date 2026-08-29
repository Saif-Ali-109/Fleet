// Signed System of Record DB layer — append/verify a tamper-evident audit log,
// plus the agent registry sync. Backed by migrations/004_sor.sql.
// run_id is the run-directory name (ctx.runId), NOT the run_outcomes UUID —
// it is the identifier shared by hooks, agentRunner, and orchestrator.

import type { Pool } from "pg";
import type { SorEvent, SorEventType } from "../sor/events.ts";
import { getCurrentKey, getCurrentKeyId, getKey } from "../sor/keyRegistry.ts";
import { GENESIS_HASH, signEvent } from "../sor/signer.ts";

export interface AgentRegistryRow {
	role: string;
	metadata: Record<string, unknown>;
	rules: Record<string, unknown>;
	source_hash: string; // sha256 hex of the source agents/<role>.md
}

interface ChainRow {
	seq: string;
	hash: string;
	key_id: string;
}

interface AuditEventRow {
	run_id: string | null;
	seq: string;
	event_type: string;
	actor: string;
	backend: string | null;
	tool_name: string | null;
	tool_input: unknown;
	tool_output: unknown;
	payload: Record<string, unknown>;
	prev_hash: string;
	hash: string;
	key_id: string;
	created_at: Date;
}

/** Coerce a value into something pg can bind to a JSONB column without loss.
 *  Primitives must be pre-serialized (a bare string would otherwise be cast by
 *  Postgres as raw JSON syntax and rejected); objects/arrays pass through for
 *  pg's own serialization; null stays null. */
export function toJsonbParam(v: unknown): unknown {
	if (v === undefined || v === null) return null;
	if (
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	) {
		return JSON.stringify(v);
	}
	return v;
}

function _requireSigningKey(): string {
	const key = process.env.SOR_SIGNING_KEY;
	if (!key || key.length === 0) {
		throw new Error(
			"SOR_SIGNING_KEY is not set. Configure it in .env or export it before appending/verifying audit events.",
		);
	}
	return key;
}

/** Idempotent: ensure the singleton sor_chain row exists (id=1, seq=0, hash=GENESIS_HASH).
 *  The genesis row records the CURRENT key id so a fresh install under a
 *  nonzero SOR_KEY_ID gets a consistent tail from the start. */
export async function ensureChain(pool: Pool): Promise<void> {
	await pool.query(
		"INSERT INTO sor_chain (id, seq, hash, key_id) VALUES (1, 0, $1, $2) ON CONFLICT (id) DO NOTHING",
		[GENESIS_HASH, getCurrentKeyId()],
	);
}

/** Single-writer append. Transactional; row-locks the chain tail before signing + inserting. */
export async function appendAuditEvent(
	pool: Pool,
	event: SorEvent,
): Promise<void> {
	const keyId = getCurrentKeyId();
	const key = getCurrentKey();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const chainResult = await client.query<ChainRow>(
			"SELECT seq, hash, key_id FROM sor_chain WHERE id = 1 FOR UPDATE",
		);
		const chain = chainResult.rows[0];
		if (!chain) {
			throw new Error(
				"sor_chain (id=1) missing — call ensureChain() before appending audit events",
			);
		}

		const nextSeq = Number(chain.seq) + 1;
		const normalized = {
			...event,
			created_at: new Date(event.created_at).toISOString(),
		};
		// Embed the same key id that is written to the row and to sor_chain
		// (chain.key_id is the OLD tail key until we commit). verifyChain
		// recomputes with row.key_id, so both must agree for the first
		// post-rotation append to verify.
		const hash = signEvent(key, chain.hash, normalized, keyId);

		await client.query(
			`INSERT INTO audit_events
        (run_id, seq, event_type, actor, backend, tool_name, tool_input, tool_output, payload, prev_hash, hash, key_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			[
				event.run_id,
				nextSeq,
				event.event_type,
				event.actor,
				event.backend,
				event.tool_name,
				toJsonbParam(event.tool_input),
				toJsonbParam(event.tool_output),
				toJsonbParam(event.payload),
				chain.hash,
				hash,
				keyId,
				normalized.created_at,
			],
		);

		await client.query(
			"UPDATE sor_chain SET seq = $1, hash = $2, key_id = $3, updated_at = now() WHERE id = 1",
			[nextSeq, hash, keyId],
		);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/** Upsert each row into agent_registry by role (single atomic multi-row upsert). */
export async function syncAgentRegistry(
	pool: Pool,
	rows: AgentRegistryRow[],
): Promise<void> {
	if (rows.length === 0) return;

	const params: unknown[] = [];
	const tuples: string[] = [];
	for (const row of rows) {
		const i = params.length;
		tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
		params.push(row.role, row.metadata, row.rules, row.source_hash);
	}

	await pool.query(
		`INSERT INTO agent_registry (role, metadata, rules, source_hash)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (role) DO UPDATE
       SET metadata = EXCLUDED.metadata,
           rules = EXCLUDED.rules,
           source_hash = EXCLUDED.source_hash,
           synced_at = now()`,
		params,
	);
}

function eventFromRow(row: AuditEventRow): SorEvent {
	return {
		run_id: row.run_id,
		event_type: row.event_type as SorEventType,
		actor: row.actor,
		backend: row.backend,
		tool_name: row.tool_name,
		tool_input: row.tool_input,
		tool_output: row.tool_output,
		payload: row.payload,
		created_at: row.created_at.toISOString(),
	};
}

/** Replay verification. Recomputes the hash chain and checks prev_hash linkage row by row. */
export async function verifyChain(pool: Pool): Promise<{
	ok: boolean;
	firstBadSeq: number | null;
	total: number;
	counts: Record<string, number>;
}> {
	const result = await pool.query<AuditEventRow>(
		`SELECT run_id, seq, event_type, actor, backend, tool_name,
            tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
     FROM audit_events
     ORDER BY seq ASC`,
	);
	const rows = result.rows;

	const counts: Record<string, number> = {};
	let prevHash = GENESIS_HASH;
	let firstBadSeq: number | null = null;

	for (const row of rows) {
		counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
		if (firstBadSeq !== null) continue; // already failed; keep tallying the rest

		if (row.prev_hash !== prevHash) {
			firstBadSeq = Number(row.seq);
			continue;
		}

		// Get the key for this row's key_id
		const key = getKey(row.key_id);
		if (!key) {
			firstBadSeq = Number(row.seq);
			continue;
		}

		const recomputed = signEvent(
			key,
			row.prev_hash,
			eventFromRow(row),
			row.key_id,
		);
		if (recomputed !== row.hash) {
			firstBadSeq = Number(row.seq);
			continue;
		}
		prevHash = row.hash;
	}

	return { ok: firstBadSeq === null, firstBadSeq, total: rows.length, counts };
}
