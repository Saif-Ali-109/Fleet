// Fleet Context SoR — run-scoped seed at manager boot (C6).
// Seeds authoritative operational state from the run's `RunContext` into
// `context_sor` via C3's controlled write path. NON-FATAL: a seed failure only
// warns; it never aborts the run. Cleared on `dryRun` (dry-runs must not write).

import type { Pool } from "pg";
import type { RunContext } from "../types.ts";
import { putContext } from "./contextStore.ts";

/** Build the run-scoped operational-state object (§11.2 item 1) from RunContext. */
export function runContextState(ctx: RunContext): Record<string, unknown> {
	const state: Record<string, unknown> = {
		runId: ctx.runId,
		repoUrl: ctx.repoUrl,
		branch: ctx.branch,
		worktreeDir: ctx.worktreeDir,
		dryRun: ctx.dryRun,
	};
	if (ctx.provider !== undefined) {
		state.provider = ctx.provider;
	}
	return state;
}

/**
 * Seed run-scoped context at boot, BEFORE runOrchestrator. NON-FATAL: wraps the
 * putContext write in try/catch, warns on failure, never aborts the run.
 * Skipped entirely when `dryRun === true` (no DB write on dry-run).
 * sourceId = `fleet|run|<runId>`; category = "run"; actor = "manager".
 */
export async function seedRunContext(
	pool: Pool,
	ctx: RunContext,
): Promise<void> {
	if (ctx.dryRun) {
		return;
	}
	try {
		const state = runContextState(ctx);
		await putContext(pool, {
			sourceId: `fleet|run|${ctx.runId}`,
			category: "run",
			state,
			actor: "manager",
		});
	} catch (err) {
		console.warn(
			`[sor] run-scoped context seed skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
