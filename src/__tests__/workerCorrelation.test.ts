// S8 stage 3 / F2 + T8: worker_roles correlation and true started_at.
//
// Two invariants the table could not express before:
//   1. run_id carries the REAL run_outcomes UUID so an orphaned row is
//      attributable to a run. ctx.runId (the manager's timestamp run label)
//      must never reach that FK column, and the FK must keep rejecting it.
//   2. started_at means "the worker actually started" (child forked), not
//      "the row was hired". Until the first spawn the row stays pending with
//      no started_at, and a late spawn-mark must never resurrect a terminal row
//      back into an active state (the exact leak stage 2 made observable).

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
} from "vitest";
import { pool } from "../db/client.ts";
import {
	hireWorker,
	markWorkerRunning,
	updateWorkerStatus,
} from "../workforce/hiring.ts";
import type { WorkforcePolicy } from "../workforce/policy.ts";
import { defaultPolicy } from "../workforce/policy.ts";

const TEST_PREFIX = "test/corr-";

function hirePolicy(roleName: string): WorkforcePolicy {
	return {
		...defaultPolicy(),
		authorized_roles: [...defaultPolicy().authorized_roles, roleName],
	};
}

interface WorkerRow {
	run_id: string | null;
	status: string;
	started_at: Date | null;
	ended_at: Date | null;
	created_at: Date;
}

async function rowFor(roleId: string): Promise<WorkerRow> {
	const res = await pool.query<WorkerRow>(
		"SELECT run_id, status, started_at, ended_at, created_at FROM worker_roles WHERE role_id = $1",
		[roleId],
	);
	const row = res.rows[0];
	if (!row) throw new Error(`worker_roles row ${roleId} vanished`);
	return row;
}

/** Insert a throwaway run_outcomes row and return its real UUID. */
async function seedRun(repo: string, issueNumber: number): Promise<string> {
	const res = await pool.query<{ run_id: string }>(
		`INSERT INTO run_outcomes (
       repo, issue_number, issue_title, status, total_cost_usd,
       iterations_used, started_at, completed_at, gate_status, backend
     ) VALUES ($1, $2, '', 'running', 0, 0, now(), NULL, '{}', 'ollama')
     RETURNING run_id`,
		[repo, issueNumber],
	);
	const row = res.rows[0];
	if (!row) throw new Error("failed to seed run_outcomes row");
	return row.run_id;
}

let seededRepos: string[] = [];
let seq = 0;
/** Uncapped backend so this suite never fights max_per_backend for slots. */
const BACKEND = "testcorr";
/** Rows this suite created, removed after each test to keep the active count flat. */
const created: string[] = [];

function nextRepo(): string {
	seq += 1;
	const repo = `${TEST_PREFIX}repo-${process.pid}-${Date.now()}-${seq}`;
	seededRepos.push(repo);
	return repo;
}

async function hire(roleName: string, runId?: string): Promise<string> {
	const id = await hireWorker(
		roleName,
		BACKEND,
		"m",
		hirePolicy(roleName),
		runId,
	);
	created.push(id);
	return id;
}

beforeAll(async () => {
	await pool.query("DELETE FROM worker_roles WHERE role_name LIKE $1", [
		`${TEST_PREFIX}%`,
	]);
});

afterEach(async () => {
	while (created.length) {
		const id = created.pop();
		if (id) await pool.query("DELETE FROM worker_roles WHERE role_id = $1", [id]);
	}
});

afterAll(async () => {
	await pool.query("DELETE FROM worker_roles WHERE role_name LIKE $1", [
		`${TEST_PREFIX}%`,
	]);
	for (const repo of seededRepos) {
		await pool.query("DELETE FROM run_outcomes WHERE repo = $1", [repo]);
	}
	await pool.end();
});

describe("hireWorker run correlation (S8 F2/T8)", () => {
	it("persists the real run_outcomes UUID on worker_roles.run_id", async () => {
		const repo = nextRepo();
		const runId = await seedRun(repo, 1);
		const role = `${TEST_PREFIX}coder`;

		const workerId = await hire(role, runId);

		const row = await rowFor(workerId);
		expect(row.run_id).toBe(runId);
		expect(row.run_id).not.toBeNull();
	});

	it("leaves run_id NULL when no DB run exists (dry runs / direct callers)", async () => {
		const role = `${TEST_PREFIX}nodb`;
		const workerId = await hire(role);

		const row = await rowFor(workerId);
		expect(row.run_id).toBeNull();
	});

	it("rejects ctx.runId-style timestamp run labels via the FK, never casting them", async () => {
		const role = `${TEST_PREFIX}tsref`;
		// ctx.runId looks like this. If anything ever passed it through, uuid
		// parsing must reject it rather than store a broken identity.
		await expect(hire(role, "2026-10-16T12:00:00Z")).rejects.toThrow();

		const count = await pool.query<{ count: string }>(
			"SELECT COUNT(*) AS count FROM worker_roles WHERE role_name = $1",
			[role],
		);
		expect(Number(count.rows[0]?.count ?? "0")).toBe(0);
	});

	it("rejects a UUID that does not exist in run_outcomes (FK stays enforced)", async () => {
		const role = `${TEST_PREFIX}ghost`;
		await expect(
			hire(role, "11111111-2222-4333-8444-555555555555"),
		).rejects.toThrow();
	});
});

describe("started_at lifecycle (S8 F2)", () => {
	it("stays NULL and pending until the worker is actually started", async () => {
		const role = `${TEST_PREFIX}idle`;
		const workerId = await hire(role);

		const hired = await rowFor(workerId);
		expect(hired.status).toBe("pending");
		expect(hired.started_at).toBeNull();

		await markWorkerRunning(workerId);

		const started = await rowFor(workerId);
		expect(started.status).toBe("running");
		expect(started.started_at).not.toBeNull();
		// started_at is its own measurement, not a copy of created_at.
		expect(started.created_at.getTime()).toBeLessThanOrEqual(
			started.started_at?.getTime() ?? 0,
		);
	});

	it("keeps the FIRST started_at across restarts and later attempts", async () => {
		const role = `${TEST_PREFIX}restart`;
		const workerId = await hire(role);

		await markWorkerRunning(workerId);
		const first = await rowFor(workerId);
		const firstStart = first.started_at?.getTime() ?? 0;

		await new Promise((r) => setTimeout(r, 25));
		await markWorkerRunning(workerId);

		const second = await rowFor(workerId);
		expect(second.status).toBe("running");
		expect(second.started_at?.getTime() ?? 0).toBe(firstStart);
	});

	it("survives the terminal write: started_at is preserved, ended_at is set", async () => {
		const role = `${TEST_PREFIX}done`;
		const workerId = await hire(role);

		await markWorkerRunning(workerId);
		const startedAt = (await rowFor(workerId)).started_at?.getTime() ?? 0;
		await updateWorkerStatus(workerId, "success", "/tmp/trace.jsonl");

		const done = await rowFor(workerId);
		expect(done.status).toBe("success");
		expect(done.started_at?.getTime() ?? 0).toBe(startedAt);
		expect(done.ended_at).not.toBeNull();
	});

	it("never resurrects a terminal row when a late spawn-mark lands", async () => {
		const role = `${TEST_PREFIX}race`;
		const workerId = await hire(role);
		await updateWorkerStatus(workerId, "failed");

		// The spawn-mark is fired fire-and-forget at fork time; a fast worker can
		// finalize first. The mark must be a no-op, not flip failed -> running
		// (which would re-leak the row against max_concurrent_workers).
		await markWorkerRunning(workerId);

		const row = await rowFor(workerId);
		expect(row.status).toBe("failed");
		expect(row.started_at).toBeNull();
	});

	it("never resurrects a retired row either", async () => {
		const role = `${TEST_PREFIX}retired`;
		const workerId = await hire(role);
		await pool.query(
			"UPDATE worker_roles SET status = 'retired' WHERE role_id = $1",
			[workerId],
		);

		await markWorkerRunning(workerId);

		expect((await rowFor(workerId)).status).toBe("retired");
	});
});