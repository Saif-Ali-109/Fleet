// Integration harness: mirrors src/index.ts's manager path for subprocess
// lifecycle verification — ownership acquisition with an onLoss latch, a live
// long-worker, and killActiveWorkers() on loss. Not imported by any test
// suite's runtime (only treated as plain source for typecheck); run via
// `node --import tsx ...`.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killActiveWorkers, runWorker } from "../../agentRunner.ts";
import type { RolePolicy, RunContext } from "../../types.ts";
import { acquireManagerOwnership } from "../../workforce/ownership.ts";

function makeCtx(runId: string): RunContext {
	const root = mkdtempSync(join(tmpdir(), "lifecycle-mgr-"));
	const runDir = join(root, ".runs", runId);
	mkdirSync(join(runDir, "worktree"), { recursive: true });
	mkdirSync(join(runDir, "traces"), { recursive: true });
	return {
		runId,
		issue: {
			repo: "lifecycle/test",
			number: 1,
			title: "lifecycle integration worker",
			body: "",
			url: "https://example.invalid/lifecycle",
			state: "open",
			labels: [],
			author: "test",
		},
		repoUrl: "leave-chair://noop",
		rootDir: root,
		runDir,
		worktreeDir: join(runDir, "worktree"),
		tracesDir: join(runDir, "traces"),
		branch: "lifecycle",
		dryRun: false,
		provider: "ollama",
	} as unknown as RunContext;
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error(
			JSON.stringify({ event: "fatal", error: "DATABASE_URL missing" }),
		);
		process.exit(1);
	}

	let ownership: Awaited<ReturnType<typeof acquireManagerOwnership>>;
	try {
		ownership = await acquireManagerOwnership({
			connectionString: databaseUrl,
		});
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "lock_denied",
				mode: "manager",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exit(1);
	}

	const { pool } = await import("../../db/client.ts");
	await pool.query(
		"DELETE FROM worker_roles WHERE role_name = 'coder' AND backend = 'ollama' AND status IN ('pending','running')",
	);

	ownership.onLoss((loss) => {
		console.error(
			JSON.stringify({
				event: "manager_ownership_lost",
				reason: loss.reason,
				error: loss.error,
			}),
		);
		killActiveWorkers();
		process.exit(2);
	});

	const backendPid = ownership.backendPid;
	console.log(JSON.stringify({ event: "LOCK_ACQUIRED", backendPid }));

	const policy: RolePolicy = {
		role: "coder",
		model: "opencode/laguna-s-2.1-free",
		fallbacks: [],
		variant: "minimal",
	};

	const ctx = makeCtx("lifecycletest");
	const { resetWorkerAbort } = await import("../../agentRunner.ts");
	resetWorkerAbort();
	console.log(JSON.stringify({ event: "RUNWORKER_INVOKED" }));

	try {
		await runWorker("coder", "lifecycle long worker task", ctx, policy, {
			runDbId: undefined,
		});
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "runworker_threw",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	console.log(JSON.stringify({ event: "RUNWORKER_RETURNED" }));
	await ownership.release();
	process.exit(0);
}

main().catch((error) => {
	console.error(
		JSON.stringify({
			event: "fatal",
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	process.exit(1);
});
