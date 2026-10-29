import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db/client.ts";
import { hireWorker, updateWorkerStatus } from "../workforce/hiring.ts";
import { acquireManagerOwnership } from "../workforce/ownership.ts";
import { defaultPolicy } from "../workforce/policy.ts";

const TEST_PREFIX = "test/own-";
const DATABASE_URL = process.env.DATABASE_URL as string;
const KEY = 8675309;

function hirePolicy(roleName: string) {
	return {
		...defaultPolicy(),
		authorized_roles: [...defaultPolicy().authorized_roles, roleName],
	};
}

async function rawLockHeld(key: number): Promise<boolean> {
	const c = new Client({ connectionString: DATABASE_URL });
	await c.connect();
	try {
		const r = await c.query("SELECT pg_try_advisory_lock($1) AS ok", [key]);
		// Always unlock so we do not leave this probe holding the lock.
		await c.query("SELECT pg_advisory_unlock($1)", [key]);
		return r.rows[0]?.ok === true;
	} finally {
		await c.end();
	}
}

beforeAll(async () => {
	await pool.query("DELETE FROM worker_roles WHERE role_name LIKE $1", [
		`${TEST_PREFIX}%`,
	]);
});

afterAll(async () => {
	await pool.query("DELETE FROM worker_roles WHERE role_name LIKE $1", [
		`${TEST_PREFIX}%`,
	]);
	await pool.end();
});

describe("manager ownership (advisory lock)", () => {
	it("acquires the lock and reports itself as owner", async () => {
		const own = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		try {
			expect(own.isOwner()).toBe(true);
			expect(own.backendPid).toBeGreaterThan(0);
			// Session-scoped: an independent connection now observes it as taken.
			expect(await rawLockHeld(KEY)).toBe(false);
		} finally {
			await own.release();
		}
	});

	it("releases the lock on graceful release", async () => {
		const own = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		expect(await rawLockHeld(KEY)).toBe(false);
		await own.release();
		expect(own.isOwner()).toBe(false);
		// Observable afterwards: a fresh connection can take it.
		expect(await rawLockHeld(KEY)).toBe(true);
	});

	it("does not announce ownership loss on graceful release", async () => {
		const own = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		const losses: string[] = [];
		own.onLoss((l) => losses.push(l.reason));
		await own.release();
		// Closing the dedicated connection emits pg's "end"; give it a beat to
		// prove the planned hand-off never trips the terminate latch.
		await new Promise((r) => setTimeout(r, 100));
		expect(losses).toEqual([]);
	});

	it("fails closed when another manager already holds the lock", async () => {
		const first = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		try {
			await expect(
				acquireManagerOwnership({
					connectionString: DATABASE_URL,
					lockKey: KEY,
					timeoutMs: 600,
				}),
			).rejects.toThrow(/held by another Fleet manager/);
		} finally {
			await first.release();
		}
	});

	it("two independent sessions contend, as they would across hosts", async () => {
		// Distinct TCP connections, not in-process mocks: this is the property
		// that makes the lock hold across HOSTS sharing one DATABASE_URL.
		const a = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		const b = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
			timeoutMs: 500,
		}).catch(() => null);
		expect(b).toBeNull();
		await a.release();
	});

	it("signals ownership loss when the dedicated connection drops", async () => {
		const own = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		const loss = new Promise<{ reason: string }>((resolve) => {
			own.onLoss((l) => resolve(l));
		});
		// Simulate the socket dying under us.
		await pool.query("SELECT pg_terminate_backend($1)", [own.backendPid]);

		const observed = await loss;
		expect(["connection_error", "connection_closed", "lock_lost"]).toContain(
			observed.reason,
		);
		expect(own.isOwner()).toBe(false);
	});

	it("releases the lock when the owning process is killed (crash)", async () => {
		// Spawn a real child that acquires and holds the lock, then SIGKILL it,
		// because SIGKILL runs no cleanup handlers. If the lock survived this,
		// every future manager would be permanently locked out.
		//
		// execArgv is pinned to ["--import", "tsx"] rather than inheriting
		// process.execArgv: under vitest that carries worker-runner arguments that
		// make the child fail to boot.
		const { fork } = await import("node:child_process");
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const probeDir = mkdtempSync(join(tmpdir(), "fleet-own-probe-"));
		const entry = join(probeDir, "own-probe.mjs");
		const mod = new URL("../workforce/ownership.ts", import.meta.url).pathname;
		writeFileSync(
			entry,
			`import { acquireManagerOwnership } from "${mod}";
const own = await acquireManagerOwnership({ connectionString: process.env.PROBE_URL, lockKey: ${KEY} });
process.send?.({ ready: own.backendPid });
setInterval(() => {}, 1000);`,
		);

		const child = fork(entry, {
			execPath: process.execPath,
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: { ...process.env, PROBE_URL: DATABASE_URL },
		});
		try {
			const pid = await new Promise<number>((resolve, reject) => {
				const t = setTimeout(
					() => reject(new Error("probe child never reported readiness")),
					20_000,
				);
				child.on("message", (m: { ready: number }) => {
					clearTimeout(t);
					resolve(m.ready);
				});
				child.on("error", (e) => {
					clearTimeout(t);
					reject(e);
				});
			});
			expect(pid).toBeGreaterThan(0);
			expect(await rawLockHeld(KEY)).toBe(false);

			child.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 1500));

			// Postgres ended the dead session, so the lock is free again.
			expect(await rawLockHeld(KEY)).toBe(true);
		} finally {
			if (!child.killed) child.kill("SIGKILL");
			rmSync(probeDir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("ownership versus live workers", () => {
	it("does not retire or disturb a live worker when a rival manager is refused", async () => {
		const owner = await acquireManagerOwnership({
			connectionString: DATABASE_URL,
			lockKey: KEY,
		});
		let workerId: string | undefined;
		try {
			const role = `${TEST_PREFIX}live`;
			workerId = await hireWorker(
				role,
				"claude",
				"m",
				hirePolicy(role) as never,
			);
			// A rival manager must be refused while this one owns the lock.
			await expect(
				acquireManagerOwnership({
					connectionString: DATABASE_URL,
					lockKey: KEY,
					timeoutMs: 500,
				}),
			).rejects.toThrow(/held by another Fleet manager/);

			// The refused startup must NOT have touched the live row.
			const row = await pool.query<{ status: string; ended_at: Date | null }>(
				"SELECT status, ended_at FROM worker_roles WHERE role_id = $1",
				[workerId],
			);
			expect(row.rows[0]?.status).toBe("pending");
			expect(row.rows[0]?.ended_at).toBeNull();
		} finally {
			if (workerId) await updateWorkerStatus(workerId, "success");
			await owner.release();
		}
	}, 30_000);
});
