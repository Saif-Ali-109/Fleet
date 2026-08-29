import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent, verifyChain } from "../../db/audit.ts";
import { pool } from "../../db/client.ts";
import type { SorEvent } from "../events.ts";
import { repairChainForPool } from "../repairChain.ts";
import { GENESIS_HASH, signEvent } from "../signer.ts";

const KEY = "repair-test-signing-key";
const CORRUPT = "b".repeat(64); // long enough to be a plausible-looking hash, deliberately wrong

function makeEvent(overrides: Partial<SorEvent> = {}): SorEvent {
	return {
		run_id: "repair-test",
		event_type: "phase",
		actor: "manager",
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		payload: { status: "test" },
		created_at: "2026-08-29T10:00:00.000Z",
		...overrides,
	};
}

async function resetChain(): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("TRUNCATE TABLE audit_events");
		await client.query(
			"UPDATE sor_chain SET seq = 0, hash = $1, key_id = 'v1', updated_at = now() WHERE id = 1",
			[GENESIS_HASH],
		);
		await client.query("COMMIT");
	} finally {
		client.release();
	}
}

async function insertCorruptRow(
	event: SorEvent,
	corruptHash: string,
): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO audit_events
        (run_id, seq, event_type, actor, backend, tool_name, tool_input, tool_output, payload, prev_hash, hash, key_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			[
				event.run_id,
				1,
				event.event_type,
				event.actor,
				event.backend,
				event.tool_name,
				event.tool_input,
				event.tool_output,
				event.payload,
				GENESIS_HASH,
				corruptHash,
				"v1",
				event.created_at,
			],
		);
		await client.query(
			"UPDATE sor_chain SET seq = 1, hash = $1, key_id = 'v1', updated_at = now() WHERE id = 1",
			[corruptHash],
		);
		await client.query("COMMIT");
	} finally {
		client.release();
	}
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SOR_SIGNING_KEY", "SOR_KEY_V1", "SOR_KEY_ID"] as const;

beforeEach(async () => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.SOR_SIGNING_KEY = KEY;
	process.env.SOR_KEY_V1 = KEY;
	process.env.SOR_KEY_ID = "v1";
	await resetChain();
});

afterEach(async () => {
	await resetChain();
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("repairChainForPool", () => {
	it("no-ops on an empty chain (F4.2)", async () => {
		const report = await repairChainForPool(pool);
		expect(report).toEqual({ total: 0, needsUpdate: 0, updated: 0, skipped: 0 });
	});

	it("reports a fully valid chain with needsUpdate 0 (F4.2)", async () => {
		await appendAuditEvent(pool, makeEvent({ payload: { status: "a" } }));
		await appendAuditEvent(
			pool,
			makeEvent({ payload: { status: "b" }, created_at: "2026-08-29T10:00:01.000Z" }),
		);

		const report = await repairChainForPool(pool);
		expect(report.total).toBe(2);
		expect(report.needsUpdate).toBe(0);
		expect(report.updated).toBe(0);
		expect(report.skipped).toBe(0);

		const result = await verifyChain(pool);
		expect(result.ok).toBe(true);
		expect(result.firstBadSeq).toBeNull();
	});

	it("repairs a corrupt row, updates it, and leaves sor:verify green (F1.1/F4.2)", async () => {
		const event = makeEvent();
		const correctHash = signEvent(KEY, GENESIS_HASH, event, "v1");
		await insertCorruptRow(event, CORRUPT);
		expect(
			(await pool.query("SELECT hash FROM audit_events WHERE seq = 1")).rows[0]
				.hash,
		).toBe(CORRUPT);

		const report = await repairChainForPool(pool);
		expect(report.total).toBe(1);
		expect(report.needsUpdate).toBe(1);
		expect(report.updated).toBe(1);
		expect(report.skipped).toBe(0);

		const row = await pool.query(
			"SELECT prev_hash, hash FROM audit_events WHERE seq = 1",
		);
		expect(row.rows[0].prev_hash).toBe(GENESIS_HASH);
		expect(row.rows[0].hash).toBe(correctHash);

		const result = await verifyChain(pool);
		expect(result.ok).toBe(true);
		expect(result.firstBadSeq).toBeNull();
	});

	it("leaves the append-only invariant intact after a real repair (F1.2)", async () => {
		await insertCorruptRow(makeEvent(), CORRUPT);
		const report = await repairChainForPool(pool);
		expect(report.updated).toBe(1);

		// a normal-session UPDATE must still raise the 011 trigger
		await expect(
			pool.query("UPDATE audit_events SET hash = 'x' WHERE seq = 1"),
		).rejects.toThrow(/append-only/);
	});

	it("rolls back the repair transaction and leaves the trigger enabled on failure (F1.3)", async () => {
		const event = makeEvent();
		await insertCorruptRow(event, CORRUPT);

		// Wrap a real connection and make its FIRST audit_events UPDATE throw,
		// simulating a mid-transaction failure after DISABLE ran.
		const realClient = await pool.connect();
		let threwOnce = false;
		const client: PoolClient = new Proxy(realClient, {
			get(target, prop, receiver) {
				if (prop === "query") {
					return async (...args: unknown[]) => {
						const text =
							typeof args[0] === "string"
								? args[0]
								: ((args[0] as { text?: string })?.text ?? "");
						if (text.startsWith("UPDATE audit_events SET") && !threwOnce) {
							threwOnce = true;
							throw new Error("simulated mid-transaction failure");
						}
						const pgQuery = target.query as (...q: unknown[]) => unknown;
						return pgQuery.apply(target, args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		const intercepted = {
			query: (sql: string, params?: unknown[]) => pool.query(sql, params),
			connect: async () => client,
		} as unknown as Pool;

		await expect(repairChainForPool(intercepted, "v1", KEY)).rejects.toThrow(
			"simulated mid-transaction failure",
		);
		expect(threwOnce).toBe(true);

		// ROLLBACK reverted the UPDATEs: the row is still corrupt
		const row = await pool.query("SELECT hash FROM audit_events WHERE seq = 1");
		expect(row.rows[0].hash).toBe(CORRUPT);

		// ...and the DISABLE was reverted too: the trigger is still enabled
		const trig = await pool.query(
			"SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_events_append_only_trigger'",
		);
		expect(trig.rows[0].tgenabled).toBe("O");
		await expect(
			pool.query("UPDATE audit_events SET hash = 'x' WHERE seq = 1"),
		).rejects.toThrow(/append-only/);
	});
});