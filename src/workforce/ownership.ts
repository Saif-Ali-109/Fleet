// Manager ownership via a PostgreSQL session-level advisory lock.
//
// Fleet's concurrency budget is machine-wide: countActiveTotal() counts every
// active worker row regardless of which manager created it. That makes "exactly
// one manager may hire" a correctness requirement, not a nicety. Previously the
// only thing discouraging a second manager was the dashboard TCP port, which is
// per-host, configurable, skipped by --no-web, and merely degraded (not refused)
// in single-issue mode. This module makes ownership explicit and enforced.
//
// Why a session-level advisory lock rather than owner_id + heartbeat leases:
// the lock is released by PostgreSQL when the session ends, including on crash,
// OOM and SIGKILL. No TTL, no clock skew, no heartbeat to lose. And because it
// is server-side state, it holds across HOSTS sharing one DATABASE_URL, which a
// localhost port binding cannot do.
//
// IMPORTANT lifecycle constraint (verified empirically 2026-10-16): a manager
// crash does NOT stop its worker subprocesses. forkWorker() uses fork() without
// detached:true, so children share the manager's process group but survive its
// death, and WORKER_TIMEOUT_MS is enforced manager-side only. A crashed manager
// therefore leaves orphaned children whose worker rows stay `pending`. Holding
// this lock does NOT give a new manager ownership of those rows. See
// S8-DESIGN.md §3.2 — reconciliation must not treat lock ownership as row
// ownership.

import pg from "pg";

const { Client } = pg;

/** Fixed, arbitrary key. Stable across processes and versions. */
export const OWNERSHIP_LOCK_KEY = 8675309;

export type OwnershipLossReason =
	| "connection_error"
	| "connection_closed"
	| "lock_lost"
	| "released";

export interface OwnershipLoss {
	reason: OwnershipLossReason;
	error?: string;
}

export interface ManagerOwnership {
	/** True while this process holds the lock. */
	isOwner(): boolean;
	/** Releases the lock and closes the dedicated connection. Idempotent. */
	release(): Promise<void>;
	/** Resolves if ownership is lost unexpectedly; never resolves otherwise. */
	onLoss(cb: (loss: OwnershipLoss) => void): void;
	/** Exposed for diagnostics and tests. */
	readonly backendPid: number | null;
}

/**
 * Acquire the manager ownership lock, failing closed.
 *
 * Uses a DEDICATED pg.Client, never the shared pg.Pool. A pooled client would
 * hand the session -- and with it the session-scoped lock -- back between
 * operations, so the lock could be silently released while the manager believed
 * it still owned the database.
 *
 * Resolves with the live ownership handle, or rejects if another manager holds
 * it. There is no "continue without ownership" path by design.
 */
export async function acquireManagerOwnership(opts: {
	connectionString: string;
	lockKey?: number;
	timeoutMs?: number;
}): Promise<ManagerOwnership> {
	const lockKey = opts.lockKey ?? OWNERSHIP_LOCK_KEY;
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const client = new Client({ connectionString: opts.connectionString });

	await client.connect();

	let held = false;
	let lost = false;
	let backendPid: number | null = null;
	const lossCallbacks: Array<(loss: OwnershipLoss) => void> = [];

	const announce = (loss: OwnershipLoss) => {
		if (lost) return;
		lost = true;
		held = false;
		for (const cb of lossCallbacks) {
			try {
				cb(loss);
			} catch {
				/* a listener must not break the others */
			}
		}
	};

	const pidRes = await client.query("SELECT pg_backend_pid() AS pid");
	backendPid = Number(pidRes.rows[0]?.pid ?? 0) || null;

	// Retry the lock acquire until the deadline. The caller ultimately fails
	// closed; retrying only makes the common "another manager is running" case
	// legible instead of looking like a hang.
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const res = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
			lockKey,
		]);
		if (res.rows[0]?.ok === true) {
			held = true;
			break;
		}
		if (Date.now() >= deadline) {
			await client.end().catch(() => {});
			throw new Error(
				`Manager ownership is held by another Fleet manager (advisory lock ${lockKey}). ` +
					"Refusing to start a second manager against the same database: the " +
					"concurrency budget in countActiveTotal() is machine-wide, so two " +
					"managers would corrupt each other's worker accounting.",
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}

	// Loss of the connection means loss of ownership. Without this the manager
	// would keep hiring against a database it no longer coordinates with.
	client.on("error", (err: Error) => {
		announce({ reason: "connection_error", error: err.message });
	});
	client.on("end", () => {
		announce({ reason: "connection_closed" });
	});

	return {
		isOwner: () => held,
		get backendPid() {
			return backendPid;
		},
		onLoss(cb) {
			lossCallbacks.push(cb);
		},
		async release() {
			if (!held) {
				await client.end().catch(() => {});
				return;
			}
			held = false;
			try {
				await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
			} catch {
				// Session end releases the lock anyway; nothing useful to do here.
			}
			await client.end().catch(() => {});
			announce({ reason: "released" });
		},
	};
}
