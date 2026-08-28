import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, Role, RunContext } from "../types.ts";

// Regression coverage for the bug where the tester gated pass/fail on
// `lastBashExitCode` — "whatever bash call ran last" in the trace — instead
// of the actual test command's own exit code. The tester's system prompt has
// it `git commit` test-file changes after the suite passes, so a `git commit`
// that fails for an unrelated reason (e.g. nothing to stage) used to get
// reported as a test failure even though the suite itself passed. Fixed by
// matching the SPECIFIC bash call whose command equals the configured test
// command (`res.bashCommands`), falling back to `lastBashExitCode` only when
// no matching call is found.

vi.mock("../agentRunner.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../agentRunner.ts")>();
	return { ...actual, runWorker: vi.fn() };
});
vi.mock("../db/checkpoint.ts", () => ({
	checkpoint: {
		getCompletedSteps: vi.fn(async () => []),
		startStep: vi.fn(
			async (_r: string, _role: string, _it: number, step: string) => step,
		),
		markStepSuccess: vi.fn(async () => {}),
		markStepFailed: vi.fn(async () => {}),
	},
}));

import { runWorker } from "../agentRunner.ts";
import { runTester, type TesterOptions } from "../workflow/tester.ts";

const baseResult = (overrides: Partial<AgentResult>): AgentResult => ({
	role: "tester" as Role,
	ok: true,
	sessionID: null,
	model: "test-model",
	provider: "gemini",
	text: "",
	tokens: {
		input: 0,
		output: 0,
		reasoning: 0,
		cached: 0,
		cacheWrite: 0,
		total: 0,
	},
	costUsd: 0,
	sawError: false,
	tracePath: "",
	startedAt: 0,
	endedAt: 0,
	...overrides,
});

const opts: TesterOptions = {
	task: "fix the bug",
	policy: { role: "tester", model: "test-model", fallbacks: [] },
	worktreeDir: "/tmp/wt",
	testCommand: "npm test",
};

describe("runTester — matches the specific test command, not just the last bash call", () => {
	beforeEach(() => {
		vi.mocked(runWorker).mockReset();
	});

	it("passes when npm test exits 0, even though a later `git commit` fails", async () => {
		vi.mocked(runWorker).mockImplementation(async (role) => {
			if (role !== "tester") throw new Error("unexpected role");
			return baseResult({
				// The bug scenario: last bash call overall was the failing commit,
				// but the test command itself passed.
				lastBashExitCode: 1,
				bashCommands: [
					{ command: "npm test", exitCode: 0 },
					{
						command: "git add -u -- t.test.ts && git commit -m test",
						exitCode: 1,
					},
				],
			});
		});

		const res = await runTester({} as RunContext, opts, "run-1", 0);
		expect(res.ok).toBe(true);
	});

	it("fails when npm test itself exits non-zero", async () => {
		vi.mocked(runWorker).mockImplementation(async () =>
			baseResult({
				lastBashExitCode: 1,
				bashCommands: [{ command: "npm test", exitCode: 1 }],
			}),
		);

		const res = await runTester({} as RunContext, opts, "run-2", 0);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("exit code 1");
	});

	it("fails when npm test exits non-zero even if a later unrelated bash call succeeds", async () => {
		vi.mocked(runWorker).mockImplementation(async () =>
			baseResult({
				// Old lastBashExitCode-only logic would have wrongly reported PASS (0) here.
				lastBashExitCode: 0,
				bashCommands: [
					{ command: "npm test", exitCode: 1 },
					{ command: "git status", exitCode: 0 },
				],
			}),
		);

		const res = await runTester({} as RunContext, opts, "run-3", 0);
		expect(res.ok).toBe(false);
	});

	it("falls back to lastBashExitCode when no bashCommands are captured", async () => {
		vi.mocked(runWorker).mockImplementation(async () =>
			baseResult({ lastBashExitCode: 0, bashCommands: [] }),
		);

		const res = await runTester({} as RunContext, opts, "run-4", 0);
		expect(res.ok).toBe(true);
	});

	it("falls back to the ok/text/sawError heuristic when there is no exit-code evidence at all", async () => {
		vi.mocked(runWorker).mockImplementation(async () =>
			baseResult({ ok: true, text: "All tests passed!", sawError: false }),
		);

		const res = await runTester({} as RunContext, opts, "run-5", 0);
		expect(res.ok).toBe(true);
	});
});
