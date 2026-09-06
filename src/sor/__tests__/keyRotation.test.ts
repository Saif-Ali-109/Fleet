import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent, ensureChain, verifyChain } from "../../db/audit.ts";
import { pool } from "../../db/client.ts";
import type { SorEvent } from "../events.ts";
import { GENESIS_HASH } from "../signer.ts";

const KEY1 = "rotation-key-v1";
const KEY2 = "rotation-key-v2";
const KEY3 = "rotation-key-v3";

function makeEvent(i: number): SorEvent {
	return {
		run_id: `rotation-${i}`,
		event_type: "phase",
		actor: "manager",
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		payload: { step: i },
		created_at: new Date(Date.UTC(2026, 7, 29, 10, 0, i)).toISOString(),
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

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SOR_SIGNING_KEY", "SOR_KEY_V1", "SOR_KEY_ID"] as const;

beforeEach(async () => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.SOR_SIGNING_KEY = KEY1;
	process.env.SOR_KEY_V1 = KEY1;
	process.env.SOR_KEY_ID = "v1";
	delete process.env.SOR_KEY_V2;
	delete process.env.SOR_KEY_V3;
	await resetChain();
});

afterEach(async () => {
	await resetChain();
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete process.env.SOR_KEY_V2;
	delete process.env.SOR_KEY_V3;
});

describe("key rotation append + verify", () => {
	it("single-key v1 append + verify stays green (F2.2 regression)", async () => {
		await appendAuditEvent(pool, makeEvent(1));
		await appendAuditEvent(pool, makeEvent(2));

		const result = await verifyChain(pool);
		expect(result.ok).toBe(true);
		expect(result.firstBadSeq).toBeNull();
		expect(result.total).toBe(2);
	});

	it("rotate-then-append-then-verify: the first post-rotation row verifies (F2.1)", async () => {
		await appendAuditEvent(pool, makeEvent(1));

		process.env.SOR_KEY_V2 = KEY2;
		process.env.SOR_KEY_ID = "v2";
		await appendAuditEvent(pool, makeEvent(2)); // first v2 row

		const result = await verifyChain(pool);
		expect(result.ok).toBe(true);
		expect(result.firstBadSeq).toBeNull();
		expect(result.total).toBe(2);

		const rows = await pool.query<{ key_id: string }>(
			"SELECT key_id FROM audit_events ORDER BY seq ASC",
		);
		expect(rows.rows.map((r) => r.key_id)).toEqual(["v1", "v2"]);
	});

	it("multi-append across rotation boundaries verifies end-to-end (F2.3)", async () => {
		await appendAuditEvent(pool, makeEvent(1));
		await appendAuditEvent(pool, makeEvent(2));

		process.env.SOR_KEY_V2 = KEY2;
		process.env.SOR_KEY_ID = "v2";
		await appendAuditEvent(pool, makeEvent(3));
		await appendAuditEvent(pool, makeEvent(4));

		process.env.SOR_KEY_V3 = KEY3;
		process.env.SOR_KEY_ID = "v3";
		await appendAuditEvent(pool, makeEvent(5));

		const result = await verifyChain(pool);
		expect(result.ok).toBe(true);
		expect(result.firstBadSeq).toBeNull();
		expect(result.total).toBe(5);

		const rows = await pool.query<{ key_id: string }>(
			"SELECT key_id FROM audit_events ORDER BY seq ASC",
		);
		expect(rows.rows.map((r) => r.key_id)).toEqual([
			"v1",
			"v1",
			"v2",
			"v2",
			"v3",
		]);

		const tail = await pool.query<{ key_id: string; hash: string }>(
			"SELECT key_id, hash FROM sor_chain WHERE id = 1",
		);
		const lastRow = await pool.query<{ hash: string }>(
			"SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1",
		);
		expect(tail.rows[0]?.key_id).toBe("v3");
		expect(tail.rows[0]?.hash).toBe(lastRow.rows[0]?.hash);
	});
});

describe("ensureChain direct", () => {
	it("inserts genesis key_id v2 under SOR_KEY_ID=v2 and leaves an existing row untouched (F3.1/F4.3)", async () => {
		process.env.SOR_KEY_V2 = KEY2;
		process.env.SOR_KEY_ID = "v2";

		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("DELETE FROM sor_chain WHERE id = 1");
			await client.query("COMMIT");
		} finally {
			client.release();
		}

		// fresh install path: genesis row records the CURRENT key id
		await ensureChain(pool);
		const fresh = await pool.query<{ key_id: string; hash: string }>(
			"SELECT key_id, hash FROM sor_chain WHERE id = 1",
		);
		expect(fresh.rows[0]?.key_id).toBe("v2");
		expect(fresh.rows[0]?.hash).toBe(GENESIS_HASH);

		// conflict path: an existing row must be left untouched
		const client2 = await pool.connect();
		try {
			await client2.query("BEGIN");
			await client2.query(
				"UPDATE sor_chain SET seq = 5, hash = $1, key_id = 'v1', updated_at = now() WHERE id = 1",
				[GENESIS_HASH],
			);
			await client2.query("COMMIT");
		} finally {
			client2.release();
		}

		await ensureChain(pool);
		const existing = await pool.query<{ key_id: string; seq: string }>(
			"SELECT key_id, seq FROM sor_chain WHERE id = 1",
		);
		expect(existing.rows[0]?.key_id).toBe("v1");
		expect(existing.rows[0]?.seq).toBe("5");
	});
});
