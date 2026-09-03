// SPEC D11 flow tests: zero human waits, exactly ONE coder auto-fix round,
// second rejection → hard failure, PR creation = terminal success.
// Workers/workflows/db/gh are stubbed; the Manager loop itself is under test.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../agentRunner.ts";
import { appendAuditEvent, ensureChain } from "../db/audit.ts";
import { db } from "../db/client.ts";
import { diffAgainstBase, setupWorktree } from "../git/worktree.ts";
import {
	addIssueLabel,
	commentOnIssue,
	ISSUE_LABEL_DONE,
	ISSUE_LABEL_IN_PROGRESS,
	removeIssueLabel,
} from "../github/gh.ts";
import { resetSessionLog } from "../memory/sessionLog.ts";
import { readContributionGuidance, runOrchestrator } from "../orchestrator.ts";
import type { AgentResult, Issue, Role, RunContext } from "../types.ts";
import { runCoder } from "../workflow/coder.ts";
import { runTester } from "../workflow/tester.ts";

vi.mock("../agentRunner.ts", () => ({
	runWorker: vi.fn(),
	killActiveWorkers: vi.fn(() => 0),
	requestQuotaResume: vi.fn(() => true),
	resetGeminiQuotaCoordinator: vi.fn(),
	isQuotaPaused: vi.fn(() => false),
	resetWorkerAbort: vi.fn(),
}));
vi.mock("../providers/registry.ts", () => ({
	invalidateProviderClients: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));
vi.mock("../git/worktree.ts", () => ({
	setupWorktree: vi.fn(),
	cleanupWorktree: vi.fn(),
	diffAgainstBase: vi.fn(),
}));
vi.mock("../git/snapshotReader.ts", () => ({
	buildSkeletonMap: vi.fn(async () => ({ files: [] })),
	readSelectedFileSymbols: vi.fn(async () => ({})),
}));
vi.mock("../db/client.ts", () => ({
	pool: {},
	db: {
		createRun: vi.fn(async () => "run-1"),
		updateRunStatus: vi.fn(async () => true),
		logAgentAction: vi.fn(async () => "action-1"),
		finalizeRun: vi.fn(async () => true),
	},
}));
vi.mock("../db/audit.ts", () => ({
	ensureChain: vi.fn(async () => undefined),
	appendAuditEvent: vi.fn(async () => undefined),
}));
vi.mock("../db/checkpoint.ts", () => ({
	getLastFailedStep: vi.fn(async () => null),
}));
vi.mock("../workflow/coder.ts", () => ({
	EXCLUDE_ARTIFACTS: [],
	execErrorText: (e: unknown): string => String(e),
	runCoder: vi.fn(),
}));
vi.mock("../workflow/tester.ts", () => ({ runTester: vi.fn() }));
vi.mock("../github/gh.ts", async () => {
	return {
		ISSUE_LABEL_DONE: "done",
		ISSUE_LABEL_IN_PROGRESS: "in-progress",
		addIssueLabel: vi.fn(async () => undefined),
		commentOnIssue: vi.fn(async () => undefined),
		createPr: vi.fn(),
		ensureLabels: vi.fn(async () => undefined),
		removeIssueLabel: vi.fn(async () => undefined),
		splitRepoSlug: (slug: string) => {
			const [owner, repo] = slug.split("/");
			return { owner: owner ?? "", repo: repo ?? "" };
		},
	};
});
vi.mock("../memory/sessionLog.ts", () => ({
	logBlock: vi.fn(async () => undefined),
	logLine: vi.fn(async () => undefined),
	resetSessionLog: vi.fn(async () => undefined),
}));
vi.mock("../db/queries/summaryReport.ts", () => ({ generateMemory: vi.fn() }));

const makeResult = (
	role: Role,
	text = "",
	ok = true,
	error?: string,
): AgentResult => ({
	role,
	ok,
	sessionID: null,
	model: "test-model",
	provider: "gemini",
	text,
	tokens: {
		input: 0,
		output: 0,
		reasoning: 0,
		cached: 0,
		cacheWrite: 0,
		total: 0,
	},
	costUsd: 0,
	tracePath: "",
	startedAt: Date.now(),
	endedAt: Date.now(),
	...(error !== undefined ? { error } : {}),
});

const FIX_SPEC_JSON = JSON.stringify({
	summary: "frobnicator breaks",
	rootCause: "off-by-one",
	suspectFiles: ["src/a.ts"],
	affectedSymbols: [],
	reproduction: "run it",
	testStrategy: "unit test",
	risks: [],
	confidence: "high",
});

const PLAN_JSON = JSON.stringify({
	approach: "Fix the off-by-one in the frobnicator loop",
	steps: ["adjust bound"],
	filesToChange: ["src/a.ts"],
	testsToAddOrUpdate: [],
	acceptanceCriteria: ["tests pass"],
	outOfScope: [],
});

const approveText = JSON.stringify({
	verdict: "APPROVE",
	blockingIssues: [],
	nonBlockingNotes: [],
	rationale: "looks good",
});
const rejectText = JSON.stringify({
	verdict: "REQUEST_CHANGES",
	blockingIssues: ["missing null check"],
	nonBlockingNotes: [],
	rationale: "fix the null path",
});

/** Reviewer verdicts consumed in order; pr returns a PR URL. */
let reviewerTexts: string[];
let analyzerResult: AgentResult | undefined;

const issue: Issue = {
	repo: "acme/widget",
	number: 7,
	title: "Frobnicator crashes on empty input",
	body: "It should not crash.",
	url: "",
	state: "open",
	labels: ["bug"],
	author: "someone",
};

const makeCtx = async (): Promise<RunContext> => {
	const root = await mkdtemp(join(tmpdir(), "orch-d11-"));
	const runDir = join(root, "run");
	await mkdir(runDir, { recursive: true });
	return {
		runId: "test-run",
		issue,
		repoUrl: "https://github.com/acme/widget",
		rootDir: root,
		runDir,
		worktreeDir: join(root, "wt"),
		tracesDir: join(root, "traces"),
		branch: "fix-issue-7",
		dryRun: false,
		provider: "gemini",
	};
};

describe("orchestrator SPEC D11 auto-flow", () => {
	const prevEnv: Record<string, string | undefined> = {};
	const withRoleModelEnv = (): void => {
		for (const [k, v] of [
			["ANALYZER_MODEL_GEMINI", "gemini-3.7-flash"],
			["PLANNER_MODEL_GEMINI", "gemini-3.7-flash"],
			["REVIEWER_MODEL_GEMINI", "gemini-3.7-flash"],
			["CODER_MODEL_GEMINI", "gemini-3.5-flash-lite"],
			["TESTER_MODEL_GEMINI", "gemini-3.5-flash-lite"],
			["PR_MODEL_GEMINI", "gemini-3.5-flash-lite"],
		] as const) {
			prevEnv[k] = process.env[k];
			process.env[k] = v;
		}
	};
	const restoreRoleModelEnv = (): void => {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
		reviewerTexts = [];
		analyzerResult = undefined;
		withRoleModelEnv();

		vi.mocked(setupWorktree).mockImplementation(
			async (_repo, _runDir, branch) => ({
				repoDir: "/tmp/repo",
				worktreeDir: "/tmp/wt",
				branch,
				baseBranch: "main",
			}),
		);
		vi.mocked(diffAgainstBase).mockResolvedValue(
			"diff --git a/src/a.ts b/src/a.ts",
		);

		// Deterministic child_process: every exec (git status/push, gh pr view)
		// fails unless a test overrides it — mirrors an environment with no PR.
		vi.mocked(execFile).mockImplementation(((
			file: string,
			_args: readonly string[],
			cb: (e: Error | null, out?: string) => void,
		) => {
			cb(new Error(`exec failed: ${file}`));
		}) as never);

		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "reviewer") {
				const text = reviewerTexts.shift();
				return makeResult(role, text ?? approveText);
			}
			if (role === "pr") {
				return makeResult(
					role,
					"Opened PR https://github.com/acme/widget/pull/99",
				);
			}
			if (role === "analyzer" && analyzerResult) return analyzerResult;
			if (role === "analyzer") return makeResult(role, FIX_SPEC_JSON);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});

		vi.mocked(runCoder).mockImplementation(
			async (_ctx, _opts) =>
				({
					ok: true,
					results: [makeResult("coder")],
					agentResult: makeResult("coder"),
					// opts captured by tests via mock.calls
				}) as never,
		);
		vi.mocked(runTester).mockImplementation(async () =>
			Promise.resolve({
				ok: true,
				results: [makeResult("tester")],
				agentResult: makeResult("tester"),
			} as never),
		);
	});

	it("rejects invalid Gemini quota configuration before startup side effects", async () => {
		const previous = process.env.GEMINI_QUOTA_LIMITS;
		process.env.GEMINI_QUOTA_LIMITS = "{invalid";
		try {
			const ctx = await makeCtx();
			const summary = await runOrchestrator(ctx, {});
			expect(summary.status).toBe("failed");
			expect(summary.failure).toContain("Invalid GEMINI_QUOTA_LIMITS JSON");
			expect(ensureChain).not.toHaveBeenCalled();
			expect(resetSessionLog).not.toHaveBeenCalled();
			expect(setupWorktree).not.toHaveBeenCalled();
			expect(runWorker).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.GEMINI_QUOTA_LIMITS;
			else process.env.GEMINI_QUOTA_LIMITS = previous;
		}
	});

	const sorPayloads = (): Record<string, unknown>[] =>
		vi
			.mocked(appendAuditEvent)
			.mock.calls.map(
				(c) => (c[1] as { payload: Record<string, unknown> }).payload,
			);

	it("completes with zero human waits: review auto-approved in SOR, PR created", async () => {
		reviewerTexts = [approveText];
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("completed");
		expect(summary.prUrl).toBe("https://github.com/acme/widget/pull/99");

		const payloads = sorPayloads();
		const phases = payloads.map((p) => p.phase);
		expect(
			phases.filter((p) => typeof p === "string" && p.startsWith("gate")),
		).toEqual([]);
		expect(vi.mocked(db.finalizeRun)).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "completed",
				gate_status: JSON.stringify({ review: "auto_approved" }),
			}),
		);
	});

	it("fires exactly one coder auto-fix round on first rejection, then approves", async () => {
		reviewerTexts = [rejectText, approveText];
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("completed");
		expect(summary.prUrl).toBe("https://github.com/acme/widget/pull/99");
		expect(runCoder).toHaveBeenCalledTimes(2);

		const fixTask = vi.mocked(runCoder).mock.calls[1]?.[1]?.task ?? "";
		expect(fixTask).toContain("missing null check");
		expect(fixTask).toContain("auto-fix");

		const autofixEvents = sorPayloads().filter(
			(p) => p.autofix_round !== undefined,
		);
		expect(autofixEvents).toHaveLength(1);
		expect(autofixEvents[0]?.autofix_round).toBe(1);
		expect(autofixEvents[0]?.autofix_max_rounds).toBe(1);
	});

	it("fails the run when the reviewer rejects again after the single auto-fix round", async () => {
		reviewerTexts = [rejectText, rejectText];
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("failed");
		expect(summary.failure).toContain("missing null check");
		expect(summary.prUrl).toBeUndefined();
		// initial implementation + exactly one auto-fix round — never a third coder run
		expect(runCoder).toHaveBeenCalledTimes(2);
		// no PR worker spawn after terminal rejection
		const prCalls = vi
			.mocked(runWorker)
			.mock.calls.filter((c) => c[0] === "pr");
		expect(prCalls).toHaveLength(0);
	});

	it("fails the run when the pr worker fails and no fallback recovers a PR URL", async () => {
		reviewerTexts = [approveText];
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "pr") {
				return makeResult(
					role,
					"",
					false,
					"gh pr create exited 1: validation failed",
				);
			}
			if (role === "analyzer") return makeResult(role, FIX_SPEC_JSON);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("failed");
		expect(summary.prUrl).toBeUndefined();
		expect(summary.failure).toContain("no PR could be created");
		expect(summary.failure).toContain(
			"gh pr create exited 1: validation failed",
		);

		// run_outcomes row finalized as failed with no pr_url
		expect(vi.mocked(db.finalizeRun)).toHaveBeenCalledWith(
			expect.objectContaining({ status: "failed", pr_url: null }),
		);
		// failure comment posted to GitHub
		expect(vi.mocked(commentOnIssue)).toHaveBeenCalledWith(
			"acme",
			"widget",
			7,
			expect.stringContaining("no PR could be created"),
		);
		// done label NEVER added; in-progress still removed
		expect(vi.mocked(addIssueLabel)).not.toHaveBeenCalledWith(
			"acme",
			"widget",
			7,
			ISSUE_LABEL_DONE,
		);
		expect(vi.mocked(removeIssueLabel)).toHaveBeenCalledWith(
			"acme",
			"widget",
			7,
			ISSUE_LABEL_IN_PROGRESS,
		);
	});

	it("still completes when the manager fallback recovers a PR URL after a pr worker failure", async () => {
		reviewerTexts = [approveText];
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "pr")
				return makeResult(
					role,
					"",
					false,
					"worker crashed before printing URL",
				);
			if (role === "analyzer") return makeResult(role, FIX_SPEC_JSON);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});
		vi.mocked(execFile).mockImplementation(((
			_file: string,
			_args: readonly string[],
			cb: (e: Error | null, out?: { stdout: string }) => void,
		) => {
			cb(null, {
				stdout: JSON.stringify({
					url: "https://github.com/acme/widget/pull/42",
					number: 42,
				}),
			});
		}) as never);
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		// unchanged completed behavior for recovered-PR runs
		expect(summary.status).toBe("completed");
		expect(summary.prUrl).toBe("https://github.com/acme/widget/pull/42");
		expect(vi.mocked(db.finalizeRun)).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "completed",
				gate_status: JSON.stringify({ review: "auto_approved" }),
				pr_url: "https://github.com/acme/widget/pull/42",
			}),
		);
		expect(vi.mocked(addIssueLabel)).toHaveBeenCalledWith(
			"acme",
			"widget",
			7,
			ISSUE_LABEL_DONE,
		);
	});

	it("keeps hard-failure semantics: a failed worker aborts immediately, no autofix", async () => {
		analyzerResult = makeResult("analyzer", "", false);
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "analyzer") return analyzerResult as AgentResult;
			throw new Error(`role ${role} must not run after analyzer failure`);
		});
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("failed");
		expect(runCoder).not.toHaveBeenCalled();
		expect(runTester).not.toHaveBeenCalled();
		expect(summary.prUrl).toBeUndefined();
	});

	it("injects repo CONTRIBUTING.md into coder and pr tasks when present", async () => {
		reviewerTexts = [approveText];
		const ctx = await makeCtx();
		await mkdir(ctx.worktreeDir, { recursive: true });
		await writeFile(
			join(ctx.worktreeDir, "CONTRIBUTING.md"),
			"Always sign commits as ACME.",
			"utf8",
		);
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("completed");
		const prTask =
			vi.mocked(runWorker).mock.calls.find((c) => c[0] === "pr")?.[1] ?? "";
		expect(prTask).toContain("## Contribution conventions");
		expect(prTask).toContain("Always sign commits as ACME.");
		const coderTask = vi.mocked(runCoder).mock.calls[0]?.[1]?.task ?? "";
		expect(coderTask).toContain("Always sign commits as ACME.");
	});

	it("falls back to conventional-commit guidance when CONTRIBUTING.md is absent", async () => {
		reviewerTexts = [approveText];
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, {});

		expect(summary.status).toBe("completed");
		const prTask =
			vi.mocked(runWorker).mock.calls.find((c) => c[0] === "pr")?.[1] ?? "";
		expect(prTask).toContain("Use conventional commit style");
	});

	it("truncates CONTRIBUTING.md content to the 4000-char cap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "contrib-cap-"));
		await writeFile(join(dir, "CONTRIBUTING.md"), "x".repeat(5000), "utf8");
		const guidance = await readContributionGuidance(dir);
		expect(guidance).toContain("## Contribution conventions");
		expect(guidance.length).toBeLessThan(4200);
	});

	afterEach(() => {
		restoreRoleModelEnv();
	});
});
