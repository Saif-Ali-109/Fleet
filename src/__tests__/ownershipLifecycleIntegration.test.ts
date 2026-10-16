// Integration coverage for ownership-loss and termination lifecycle. Exercises a
// real subprocess fork of lifecycleManager (which holds the advisory lock and a
// live child worker), plus real pg_terminate_backend for connection loss. The
// expected outcomes are pinned against §3.2 of S8-DESIGN.md.
//
// Run by itself under the normal suite (it is self-cleaning: any orphan child
// it leaves behind from the termination case is killed in the test itself).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/client.ts";

const ROOT = process.cwd();
const FIXTURE = resolve(ROOT, "src/__tests__/fixtures/lifecycleManager.ts");

const DB_URL = process.env.DATABASE_URL as string;

function workerPids(): number[] {
	try {
		// pgrep exits 1 when no matches; suppress.
		const { execSync } = require("node:child_process") as typeof import("node:child_process");
		const out = execSync("pgrep -f longWorker.mjs", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.trim()
			.split("\n")
			.map((s) => Number(s))
			.filter((n) => Number.isFinite(n) && n > 0);
	} catch {
		return [];
	}
}

interface SpawnedManager {
	proc: ReturnType<typeof spawn>;
	output: string[];
	waitFor(marker: string, timeoutMs: number): Promise<string | null>;
	killWorkerLance?: () => void;
}

function spawnManager(env: Record<string, string>): SpawnedManager {
	const writes: string[] = [];
	const proc = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout.on("data", (b: Buffer) => {
		writes.push(b.toString("utf8"));
	});
	proc.stderr.on("data", (b: Buffer) => {
		writes.push(b.toString("utf8"));
	});
	let acc = "";
	proc.stdout.on("data", (b: Buffer) => {
		acc += b.toString("utf8");
	});
	const out = writes;
	return {
		proc,
		output: out,
		async waitFor(marker, timeoutMs) {
			const t0 = Date.now();
			while (Date.now() - t0 < timeoutMs) {
				const combined = acc;
				if (combined.includes(marker)) return combined;
				await new Promise((r) => setTimeout(r, 50));
			}
			return acc.includes(marker) ? acc : null;
		},
	};
}

function pickBackendPid(combined: string): number {
	const match = combined.match(/"backendPid"\s*:\s*(\d+)/);
	if (!match || !match[1]) throw new Error("backendPid not present in manager output");
	return Number(match[1]);
}

afterAll(async () => {
	try {
		await pool.end();
	} catch {
		/* ignore */
	}
});

describe("ownership loss lifecycle (integration)", () => {
	it(
		"connection loss while a worker is active: manager exits 2 and no worker survives",
		async () => {
			const baseline = workerPids().length;
			const mgr = spawnManager({
				DATABASE_URL: DB_URL!,
				FLEET_WORKER_ENTRY: resolve(ROOT, "src/__tests__/fixtures/longWorker.mjs"),
			});

			const combined = await mgr.waitFor("LOCK_ACQUIRED", 10_000);
			expect(combined).not.toBeNull();
			const backendPid = pickBackendPid(combined ?? "");
			// Allow the runWorker to hire and fork the child.
			await new Promise((r) => setTimeout(r, 4000));

			try {
				await pool.query("SELECT pg_terminate_backend($1)", [backendPid]);
			} catch (error) {
				// connection errors on a connection the server is tearing down are benign
				void error;
			}

			const exitCode: number | null = await new Promise((resolve) => {
				const t = setTimeout(() => resolve(null), 10_000);
				mgr.proc.on("exit", (code) => {
					clearTimeout(t);
					resolve(code);
				});
			});
			expect(exitCode).toBe(2);

			const combinedAfter = mgr.output.join("");
			expect(combinedAfter).toMatch(/manager_ownership_lost/);

			// Give the kernel a beat to reap the SIGTERMed worker.
			await new Promise((r) => setTimeout(r, 2000));
			const survivors = workerPids();
			// No more than baseline surviving longWorkers.
			expect(survivors.length).toBeLessThanOrEqual(baseline);
		},
		30_000,
	);

	it(
		"SIGKILL of the manager while a worker is active: worker survives (orphan) and is cleaned up",
		async () => {
			const baseline = workerPids().length;
			const mgr = spawnManager({
				DATABASE_URL: DB_URL!,
				FLEET_WORKER_ENTRY: resolve(ROOT, "src/__tests__/fixtures/longWorker.mjs"),
			});

			const combined = await mgr.waitFor("LOCK_ACQUIRED", 10_000);
			expect(combined).not.toBeNull();
			await new Promise((r) => setTimeout(r, 4000));

			const before = workerPids().length;
			expect(before).toBeGreaterThanOrEqual(baseline + 1);

			mgr.proc.kill("SIGKILL");
			const signal: string | null = await new Promise((resolve) => {
				const exitHandler = (c: number | null, sig: NodeJS.Signals | null) => {
					resolve(sig);
				};
				mgr.proc.on("exit", exitHandler);
				setTimeout(() => resolve("unknown"), 5000);
			});
			expect(signal).toBe("SIGKILL");

			// Witness that the worker process outlives the manager.
			await new Promise((r) => setTimeout(r, 2000));
			const survivors = workerPids().length;
			// At least one worker survived the parent SIGKILL.
			expect(survivors).toBeGreaterThanOrEqual(baseline + 1);

			// Cleanup: kill every surviving longWorker so the suite is tidy.
			for (const pid of workerPids()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		},
		30_000,
	);
});
