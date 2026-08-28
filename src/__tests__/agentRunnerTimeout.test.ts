import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetWorkerAbort, runWorker } from "../agentRunner.ts";
import type { RolePolicy, RunContext } from "../types.ts";

// Exercises the REAL mechanism: WORKER_TIMEOUT_MS SIGTERMs the fork, and when
// the worker traps/ignores SIGTERM, WORKER_TIMEOUT_GRACE_MS escalates to
// SIGKILL. The fixture (stubbornWorker.mjs) traps SIGTERM on purpose so the
// grace path deterministically fires.

const STUBBORN_WORKER = join(
	import.meta.dirname,
	"fixtures",
	"stubbornWorker.mjs",
);

let savedEnv: Record<string, string | undefined>;
let ctxDir: string;

beforeEach(() => {
	savedEnv = {};
	for (const key of [
		"FLEET_WORKER_ENTRY",
		"FAKE_FAIL_PROVIDERS",
		"FLEET_PROVIDERS",
		"WORKER_TIMEOUT_MS",
		"WORKER_TIMEOUT_GRACE_MS",
		"GEMINI_API_KEY",
		"OPENROUTER_API_KEY",
		"DATABASE_URL",
		"SOR_SIGNING_KEY",
	]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.FLEET_WORKER_ENTRY = STUBBORN_WORKER;
	process.env.FLEET_PROVIDERS = "gemini";
	process.env.GEMINI_API_KEY = "dummy-key-for-timeout-test";
	// Generous timeout so the fixture's SIGTERM trap is guaranteed to be
	// registered well before the kill switch fires, even under suite load.
	process.env.WORKER_TIMEOUT_MS = "1200";
	process.env.WORKER_TIMEOUT_GRACE_MS = "250";
	resetWorkerAbort();

	ctxDir = mkdtempSync(join(tmpdir(), "timeout-ctx-"));
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(ctxDir, { recursive: true, force: true });
});

function makeCtx(): RunContext {
	const runDir = join(ctxDir, ".runs", "t1");
	mkdirSync(join(runDir, "worktree"), { recursive: true });
	return {
		runId: "t1",
		issue: {
			repo: "owner/repo",
			number: 1,
			title: "t",
			body: "b",
			url: "u",
			state: "open",
			labels: [],
			author: "x",
		},
		repoUrl: "git@github.com:owner/repo.git",
		rootDir: ctxDir,
		runDir,
		worktreeDir: join(runDir, "worktree"),
		tracesDir: join(runDir, "traces"),
		branch: "fix-1",
		dryRun: false,
		provider: "gemini",
	};
}

const policy: RolePolicy = { role: "coder", model: "m1", fallbacks: ["m2"] };

describe("runWorker timeout", () => {
	it("SIGTERMs the fork on WORKER_TIMEOUT_MS, escalates to SIGKILL after grace, and records the timeout error", async () => {
		const started = Date.now();
		const res = await runWorker("coder", "task", makeCtx(), policy, {});
		const elapsed = Date.now() - started;

		expect(res.ok).toBe(false);
		expect(res.sawError).toBe(true);
		expect(res.error).toContain("timed out");
		expect(res.provider).toBe("gemini");
		// One candidate provider in the fleet walk → one failed attempt.
		expect(res.attempts).toHaveLength(1);
		expect(res.attempts?.[0]?.ok).toBe(false);
		expect(res.attempts?.[0]?.provider).toBe("gemini");
		expect(res.attempts?.[0]?.error).toContain("timed out after 1200ms");
		// The worker ignores SIGTERM, so resolution waits out the full
		// timeout + grace window before SIGKILL lands. Deterministic: bounded by
		// the configured kill switch only.
		expect(elapsed).toBeGreaterThanOrEqual(1350);
		expect(elapsed).toBeLessThan(10000);
	}, 30000);
});
