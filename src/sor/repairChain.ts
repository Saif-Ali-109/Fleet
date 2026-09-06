// Re-sign rows matching the current key_id in audit_events, rebuilding the
// hash chain for those rows in place (partial repair by key_id). The thin CLI
// wrapper lives in repairCli.ts (owns pool + process.exit) so this module
// stays importable for unit tests against an injected pool.

import type { Pool } from "pg";
import type { SorEvent, SorEventType } from "./events.ts";
import { getCurrentKeyId, getKey } from "./keyRegistry.ts";
import { GENESIS_HASH, signEvent } from "./signer.ts";

export interface RepairReport {
	total: number;
	needsUpdate: number;
	updated: number;
	skipped: number;
	/** First/last seq among rows that need updating (CLI report fodder). */
	firstSeq?: number;
	lastSeq?: number;
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

function resolveSigningKey(keyId: string, key?: string): string {
	const signingKey = key ?? getKey(keyId);
	if (!signingKey) {
		throw new Error(
			`SOR_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")} is not set. ` +
				"Set it in .env or export it before repairing the audit chain.",
		);
	}
	return signingKey;
}

/** Re-sign rows matching `keyId` (default: the current key id) in audit_events,
 *  rebuilding the hash chain for those rows in place. `key` may be injected for
 *  tests; otherwise it is resolved from the environment. Returns a repair report;
 *  callers decide how to surface it (the CLI prints it).
 *
 *  When updates are needed, they run in a single transaction that takes an
 *  ACCESS EXCLUSIVE lock on audit_events and temporarily DISABLEs migration
 *  011's append-only trigger — the ONLY code path allowed to rewrite the chain.
 *  The trigger is re-enabled in a `finally` before COMMIT, and a ROLLBACK on
 *  error reverts the DISABLE, so the invariant is never left suspended. */
export async function repairChainForPool(
	pool: Pool,
	keyId?: string,
	key?: string,
): Promise<RepairReport> {
	const currentKeyId = keyId ?? getCurrentKeyId();
	const signingKey = resolveSigningKey(currentKeyId, key);

	const result = await pool.query<AuditEventRow>(
		`SELECT run_id, seq, event_type, actor, backend, tool_name,
            tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
     FROM audit_events
     WHERE key_id = $1
     ORDER BY seq ASC`,
		[currentKeyId],
	);
	const rows = result.rows;

	interface Update {
		seq: number;
		prevHash: string;
		hash: string;
	}

	const updates: Update[] = [];
	let skipped = 0;
	let prevHash = GENESIS_HASH;

	for (const row of rows) {
		// Verify the row's key_id matches the target (should be true due to the
		// WHERE clause, but double-check)
		if (row.key_id !== currentKeyId) {
			skipped++;
			prevHash = row.hash; // Still advance the hash chain with the existing hash
			continue;
		}

		const event = eventFromRow(row);
		const correctHash = signEvent(signingKey, prevHash, event, currentKeyId);
		if (row.prev_hash !== prevHash || row.hash !== correctHash) {
			updates.push({ seq: Number(row.seq), prevHash, hash: correctHash });
		}
		prevHash = correctHash;
	}

	if (updates.length === 0) {
		return { total: rows.length, needsUpdate: 0, updated: 0, skipped };
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
		// migration 011 blocks UPDATE/DELETE on audit_events via an append-only
		// trigger. Repair is the ONLY path allowed to rewrite the chain, so
		// disable that one named trigger inside this ACCESS EXCLUSIVE
		// transaction. The ENABLE below always runs before COMMIT; a ROLLBACK on
		// error reverts the DISABLE too.
		await client.query(
			"ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_trigger",
		);

		try {
			for (const u of updates) {
				await client.query(
					"UPDATE audit_events SET prev_hash = $1, hash = $2 WHERE seq = $3",
					[u.prevHash, u.hash, u.seq],
				);
			}

			const last = updates[updates.length - 1];
			if (last) {
				// sor_chain has no append-only trigger, so no DISABLE/ENABLE is
				// needed around this UPDATE.
				await client.query(
					"UPDATE sor_chain SET seq = $1, hash = $2, key_id = $3, updated_at = now() WHERE id = 1",
					[last.seq, last.hash, currentKeyId],
				);
			}
		} finally {
			await client.query(
				"ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only_trigger",
			);
		}

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	const first = updates[0];
	const last = updates[updates.length - 1];
	return {
		total: rows.length,
		needsUpdate: updates.length,
		updated: updates.length,
		skipped,
		firstSeq: first?.seq,
		lastSeq: last?.seq,
	};
}
