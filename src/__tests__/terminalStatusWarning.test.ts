// S8 observability, stage 2. The terminal updateWorkerStatus at the end of
// runWorker used to swallow ALL errors with `catch { /* non-fatal */ }`. A
// failed write left the row `pending`, where countActiveTotal() keeps counting
// it against max_concurrent_workers forever, while the run reported success —
// and nothing in the logs said why. This pins the replacement contract: a
// structured warning with enough context to find the orphaned row, no task
// text or model output, and still non-fatal to the run itself.
//
// updateWorkerStatus is partially mocked so the real runWorker path forks the
// existing fakeWorker fixture (real child process, real trace stream) and only
// the manager-side terminal write fails. vitest isolates module state per test
// file, so the mock does not perturb suites that import the real module.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../db/client.ts";
import type { RolePolicy, RunContext } from "../types.ts";

const mockUpdate = vi.fn();
vi.mock("../workforce/hiring.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../workforce/hiring.ts")>();
	return {
		...actual,
		updateWorkerStatus: (
			workerId: string,
			status: string,
			outputPath?: string,
		) => mockUpdate(workerId, status, outputPath),
	};
});

const { runWorker } = await import("../agentRunner.ts");

const FAKE_WORKER = join(import.meta.dirname, "fixtures", "fakeWorker.mjs");

const SAVED_ENV_KEYS = ["FLEET_WORKER_ENTRY", "FLEET_PROVIDERS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of SAVED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
	process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
	process.env.FLEET_PROVIDERS = "ollama";
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
	while (dirs.length) {
		const d = dirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
	// The terminal write failed by design, so the worker row this test created
	// stays `pending`; remove it so it cannot leak into other suites. Scoped to
	// this suite's exact hire shape (role coder + backend ollama) so it can
	// never touch rows owned by other tests.
	await pool.query(
		"DELETE FROM worker_roles WHERE status = 'pending' AND role_name = 'coder' AND backend = 'ollama'",
	);
});

function makePolicy(): RolePolicy {
	return {
		role: "coder" as import("../types.ts").Role,
		model: "opencode/laguna-s-2.1-free",
		fallbacks: [],
	};
}

function makeRealCtx(overrides: Partial<RunContext> = {}): RunContext {
	const root = mkdtempSync(join(tmpdir(), "warn-tsw-"));
	const runDir = join(root, ".runs", "warn-run");
	const ctx: RunContext = {
		runId: "2026-10-16TWARN-00-00Z",
		issue: {
			number: 1,
			title: "test issue",
			repo: "example/repo",
			body: "",
			author: "someone",
			labels: [],
			url: "https://example.test/1",
			state: "open",
		},
		repoUrl: "https://github.com/example/repo",
		rootDir: root,
		runDir,
		worktreeDir: join(runDir, "worktree"),
		tracesDir: join(runDir, "traces"),
		branch: "fix/test",
		dryRun: false,
		provider: "ollama",
		...overrides,
	};
	return ctx;
}

const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (dirs.length) {
		const d = dirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
	// The terminal write failed by design, so the worker row this test created
	// stays `pending`; remove it so it cannot leak into other suites. Scoped to
	// this suite's exact hire shape (role coder + backend ollama) so it can
	// never touch rows owned by other tests.
	await pool.query(
		"DELETE FROM worker_roles WHERE status = 'pending' AND role_name = 'coder' AND backend = 'ollama'",
	);
});

describe("terminal status write failure is observable (S8 stage 2)", () => {
	it("warns with correlation context and stays non-fatal when the DB write fails", async () => {
		mockUpdate.mockRejectedValue(
			new Error('invalid input syntax for type uuid: "canned"'),
		);
		const warnings: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
			if (typeof msg === "string") warnings.push(msg);
		});

		const ctx = makeRealCtx();
		dirs.push(ctx.rootDir);
		mkdirSync(ctx.tracesDir, { recursive: true });

		const res = await runWorker("coder", "Fix the bug", ctx, makePolicy(), {});

		// The run itself succeeds; the observation failure is not run-fatal.
		expect(res.ok).toBe(true);

		const line = warnings.find((w) => w.includes("worker_status_write_failed"));
		expect(line).toBeDefined();
		const payload = JSON.parse(line as string) as Record<string, unknown>;
		expect(payload.event).toBe("worker_status_write_failed");
		expect(payload.role).toBe("coder");
		expect(String(payload.worker_id)).toMatch(/^[0-9a-f-]{36}$/);
		expect(payload.run_ref).toBe(ctx.runId);
		expect(payload.attempted_status).toBe("success");
		expect(payload.walk_ok).toBe(true);
		expect(String(payload.error)).toContain("canned");
	}, 30_000);

	it("carries only correlation context: no task text, no model output", async () => {
		mockUpdate.mockRejectedValue(new Error("db down"));
		const warnings: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
			if (typeof msg === "string") warnings.push(msg);
		});

		const taskText = "SECRET-TASK-BODY-Fix the payroll bug";
		const ctx = makeRealCtx();
		dirs.push(ctx.rootDir);
		mkdirSync(ctx.tracesDir, { recursive: true });

		await runWorker("coder", taskText, ctx, makePolicy(), {});

		const line = warnings.find((w) => w.includes("worker_status_write_failed"));
		expect(line).toBeDefined();
		// Structural pin: the allowed key set prevents future additions from
		// smuggling task text or model output into this line.
		expect(Object.keys(JSON.parse(line as string)).sort()).toEqual([
			"attempted_status",
			"error",
			"event",
			"role",
			"run_ref",
			"walk_ok",
			"worker_id",
		]);
		expect(line).not.toContain("payroll");
	}, 30_000);
});
