// CLI entry for `npm run sor:repair` — re-signs rows matching current key_id in audit_events,
// rebuilding the hash chain for those rows in place (partial repair by key_id).

import { pool } from "../db/client.ts";
import type { SorEvent, SorEventType } from "./events.ts";
import { getCurrentKeyId, getKey } from "./keyRegistry.ts";
import { GENESIS_HASH, signEvent } from "./signer.ts";

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

function requireCurrentKey(): string {
	const keyId = getCurrentKeyId();
	const key = getKey(keyId);
	if (!key) {
		throw new Error(
			`SOR_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")} is not set. ` +
				"Set it in .env or export it before repairing the audit chain.",
		);
	}
	return key;
}

let code: number;
try {
	const currentKeyId = getCurrentKeyId();
	const currentKey = requireCurrentKey();

	const result = await pool.query<AuditEventRow>(
		`SELECT run_id, seq, event_type, actor, backend, tool_name,
            tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
     FROM audit_events
     WHERE key_id = $1
     ORDER BY seq ASC`,
		[currentKeyId],
	);
	const rows = result.rows;

	if (rows.length === 0) {
		console.log(
			`no audit events found for key_id="${currentKeyId}" — nothing to repair`,
		);
		code = 0;
	} else {
		interface Update {
			seq: number;
			prevHash: string;
			hash: string;
		}

		const updates: Update[] = [];
		let prevHash = GENESIS_HASH;

		for (const row of rows) {
			// Verify the row's key_id matches current (should be true due to WHERE clause, but double-check)
			if (row.key_id !== currentKeyId) {
				console.warn(
					`skipping seq ${row.seq}: key_id mismatch (expected ${currentKeyId}, got ${row.key_id})`,
				);
				prevHash = row.hash; // Still advance the hash chain with the existing hash
				continue;
			}

			const event = eventFromRow(row);
			const correctHash = signEvent(currentKey, prevHash, event, currentKeyId);
			if (row.prev_hash !== prevHash || row.hash !== correctHash) {
				updates.push({ seq: Number(row.seq), prevHash, hash: correctHash });
			}
			prevHash = correctHash;
		}

		const total = rows.length;
		const needsUpdate = updates.length;
		const alreadyCorrect = total - needsUpdate;

		console.log(`chain repair report for key_id="${currentKeyId}"`);
		console.log("---------------------");
		console.log("total rows scanned:", total);
		console.log("rows already correct:", alreadyCorrect);
		console.log("rows needing update:", needsUpdate);
		if (needsUpdate > 0) {
			const first = updates[0];
			const last = updates[updates.length - 1];
			if (first && last) {
				console.log("first seq to update:", first.seq);
				console.log("last seq to update:", last.seq);
			}
		}

		if (needsUpdate === 0) {
			console.log("chain is already valid — no changes made");
			code = 0;
		} else {
			console.log("\napplying updates in a single transaction...");

			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
				// migration 011 blocks UPDATE/DELETE on audit_events via an
				// append-only trigger. Repair is the ONLY path allowed to rewrite
				// the chain, so disable that one named trigger inside this
				// ACCESS EXCLUSIVE transaction. The ENABLE below always runs
				// before COMMIT; a ROLLBACK on error reverts the DISABLE too.
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
						// sor_chain has no append-only trigger, so no
						// DISABLE/ENABLE is needed around this UPDATE.
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
				console.log("repair committed successfully");
				code = 0;
			} catch (err) {
				await client.query("ROLLBACK");
				throw err;
			} finally {
				client.release();
			}
		}
	}
} catch (err: unknown) {
	console.error(
		"[sor] repair failed:",
		err instanceof Error ? err.message : String(err),
	);
	code = 1;
}
await pool.end();
process.exit(code);
