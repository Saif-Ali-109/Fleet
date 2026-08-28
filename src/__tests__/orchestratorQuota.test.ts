// Orchestrator-side quota notification bus tests (PLAN.md P-quota): each
// QuotaEvent must hit console + SESSION_LOG + a non-fatal SOR write + the live
// dashboard state; all-models-RPD-dead NEVER kills the run — it flips the run
// into phase "paused" (banner + reminders) until a key-change Resume restarts
// the parked worker walk.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	killActiveWorkers,
	requestQuotaResume,
	resetGeminiQuotaCoordinator,
	runWorker,
} from "../agentRunner.ts";
import { appendAuditEvent, ensureChain } from "../db/audit.ts";
import {
	emitQuotaEvent,
	type QuotaEvent,
	resetQuotaEventListeners,
} from "../fleet/quotaEvents.ts";
import { diffAgainstBase, setupWorktree } from "../git/worktree.ts";
import { logLine, resetSessionLog } from "../memory/sessionLog.ts";
import {
	collapseConsecutiveModels,
	resumeFromPause,
	runOrchestrator,
	type WebFeed,
} from "../orchestrator.ts";
import { invalidateProviderClients } from "../providers/registry.ts";
import type { DashboardState } from "../tui/dashboard.ts";
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

const switchEvent: QuotaEvent = {
	type: "model_switch",
	role: "coder",
	provider: "gemini",
	fromModel: "gemini-a",
	toModel: "gemini-b",
	block: "rpm",
	waitMs: 4200,
};
const recoveredEvent: QuotaEvent = {
	type: "model_recovered",
	role: "analyzer",
	provider: "gemini",
	model: "gemini-a",
};
const exhaustedEvent: QuotaEvent = {
	type: "all_models_exhausted",
	role: "tester",
	provider: "gemini",
	models: ["gemini-a", "gemini-b"],
};

interface FeedRecorder {
	states: DashboardState[];
	quotaEvents: QuotaEvent[];
	notices: string[];
	pauses: Array<{ paused: boolean; message?: string }>;
}

const makeFeed = (): { feed: WebFeed; rec: FeedRecorder } => {
	const rec: FeedRecorder = {
		states: [],
		quotaEvents: [],
		notices: [],
		pauses: [],
	};
	const feed: WebFeed = {
		pushState: (d) => rec.states.push(structuredClone(d)),
		pushOutput: () => {},
		pushQuotaEvent: (event) => rec.quotaEvents.push(event),
		pushNotice: (msg) => rec.notices.push(msg),
		pushPause: (paused, message) => rec.pauses.push({ paused, message }),
	};
	return { feed, rec };
};

const makeCtx = async (dryRun = false): Promise<RunContext> => {
	const root = await mkdtemp(join(tmpdir(), "orch-quota-"));
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
		dryRun,
		provider: "gemini",
	};
};

const sorEvents = (): {
	event_type: string;
	payload: Record<string, unknown>;
}[] =>
	vi.mocked(appendAuditEvent).mock.calls.map((c) => {
		const ev = c[1] as { event_type: string; payload: Record<string, unknown> };
		return { event_type: ev.event_type, payload: ev.payload };
	});

describe("orchestrator quota event handling", () => {
	let consoleSpies: {
		warn: ReturnType<typeof vi.spyOn>;
		log: ReturnType<typeof vi.spyOn>;
		error: ReturnType<typeof vi.spyOn>;
	};
	const prevEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpies = {
			warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
			log: vi.spyOn(console, "log").mockImplementation(() => {}),
			error: vi.spyOn(console, "error").mockImplementation(() => {}),
		};
		// The boot gate (correctly) demands a fully configured Gemini chain for
		// real runs; stub the role vars so the quota-handling tests reach workers.
		for (const [k, v] of [
			["ANALYZER_MODEL_GEMINI", "gemini-2.5-pro"],
			["PLANNER_MODEL_GEMINI", "gemini-2.5-pro"],
			["REVIEWER_MODEL_GEMINI", "gemini-2.5-pro"],
			["CODER_MODEL_GEMINI", "gemini-2.5-flash"],
			["TESTER_MODEL_GEMINI", "gemini-2.5-flash"],
			["PR_MODEL_GEMINI", "gemini-2.5-flash"],
		] as const) {
			prevEnv[k] = process.env[k];
			process.env[k] = v;
		}

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
		vi.mocked(runCoder).mockImplementation(async () =>
			Promise.resolve({
				ok: true,
				results: [makeResult("coder")],
				agentResult: makeResult("coder"),
			} as never),
		);
		vi.mocked(runTester).mockImplementation(async () =>
			Promise.resolve({
				ok: true,
				results: [makeResult("tester")],
				agentResult: makeResult("tester"),
			} as never),
		);
	});

	afterEach(() => {
		resetQuotaEventListeners();
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		consoleSpies.warn.mockRestore();
		consoleSpies.log.mockRestore();
		consoleSpies.error.mockRestore();
	});

	const stubHappyPath = (): void => {
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "pr")
				return makeResult(
					role,
					"Opened PR https://github.com/acme/widget/pull/99",
				);
			if (role === "analyzer") return makeResult(role, FIX_SPEC_JSON);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});
	};

	it("announces model_switch on console, SESSION_LOG, SOR, live state and web feed", async () => {
		stubHappyPath();
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "analyzer") {
				emitQuotaEvent(switchEvent);
				// waitMs=0 renders no "(wait …)" suffix
				emitQuotaEvent({
					...switchEvent,
					role: "tester",
					fromModel: "gemini-c",
					toModel: "gemini-d",
					waitMs: 0,
				});
				return makeResult(role, FIX_SPEC_JSON);
			}
			if (role === "pr")
				return makeResult(
					role,
					"Opened PR https://github.com/acme/widget/pull/99",
				);
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});
		const { feed, rec } = makeFeed();
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, { web: feed });

		expect(summary.status).toBe("completed");
		expect(consoleSpies.warn).toHaveBeenCalledWith(
			"[quota] coder: gemini-a rate limited (rpm) → switching to gemini-b (wait ~4s)",
		);
		expect(vi.mocked(logLine)).toHaveBeenCalledWith(
			ctx.rootDir,
			"[quota] coder: gemini-a rate limited (rpm) → switching to gemini-b (wait ~4s)",
		);
		const sw = sorEvents().find((e) => e.event_type === "model_switch");
		expect(sw).toBeDefined();
		expect(sw?.payload).toMatchObject({
			role: "coder",
			provider: "gemini",
			from_model: "gemini-a",
			to_model: "gemini-b",
			block: "rpm",
			wait_ms: 4200,
		});
		expect(rec.quotaEvents).toContainEqual(switchEvent);
		const notices = rec.states
			.map((s) => s.quotaNotice)
			.filter((n): n is string => n !== undefined);
		expect(notices).toContain("coder: gemini-a rate limited (rpm) → gemini-b");
		// the newest event overwrites the notice on the live state
		expect(notices[notices.length - 1]).toBe(
			"tester: gemini-c rate limited (rpm) → gemini-d",
		);
		expect(consoleSpies.warn).toHaveBeenCalledWith(
			"[quota] tester: gemini-c rate limited (rpm) → switching to gemini-d",
		);
		const quotaWarns = consoleSpies.warn.mock.calls
			.map((c) => c[0] as string)
			.filter((m) => m.includes("[quota]"));
		expect(quotaWarns).toHaveLength(2);
	});

	it("announces model_recovered with the switching-back message", async () => {
		stubHappyPath();
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "analyzer") {
				emitQuotaEvent(recoveredEvent);
				return makeResult(role, FIX_SPEC_JSON);
			}
			if (role === "pr")
				return makeResult(
					role,
					"Opened PR https://github.com/acme/widget/pull/99",
				);
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "planner") return makeResult(role, PLAN_JSON);
			return makeResult(role);
		});
		const { feed, rec } = makeFeed();
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, { web: feed });

		expect(summary.status).toBe("completed");
		expect(consoleSpies.log).toHaveBeenCalledWith(
			"[quota] analyzer: gemini-a available again → switching back",
		);
		expect(vi.mocked(logLine)).toHaveBeenCalledWith(
			ctx.rootDir,
			"[quota] analyzer: gemini-a available again → switching back",
		);
		const recov = sorEvents().find((e) => e.event_type === "model_recovered");
		expect(recov).toBeDefined();
		expect(recov?.payload).toMatchObject({
			role: "analyzer",
			provider: "gemini",
			model: "gemini-a",
		});
		expect(rec.quotaEvents).toContainEqual(recoveredEvent);
	});

	it("pauses on all_models_exhausted instead of killing workers, and resume restarts the run", async () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const savedKeys: Record<string, string | undefined> = {
			GEMINI_API_KEY: process.env.GEMINI_API_KEY,
			OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
		};
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		try {
			vi.mocked(runWorker).mockImplementation(async (role: Role) => {
				if (role === "analyzer") {
					emitQuotaEvent(exhaustedEvent);
					emitQuotaEvent(exhaustedEvent); // duplicate exhaustion never re-enters pause
					await gate;
					return makeResult(role, FIX_SPEC_JSON);
				}
				if (role === "pr")
					return makeResult(
						role,
						"Opened PR https://github.com/acme/widget/pull/99",
					);
				if (role === "reviewer") return makeResult(role, approveText);
				if (role === "planner") return makeResult(role, PLAN_JSON);
				return makeResult(role);
			});
			const { feed, rec } = makeFeed();
			const ctx = await makeCtx();
			const runP = runOrchestrator(ctx, { web: feed });

			// Pause entry: phase flips to "paused", banner + SOR + SESSION_LOG fire,
			// and the workers are NOT killed — the walk stays parked.
			await vi.waitFor(() => {
				expect(sorEvents().some((e) => e.event_type === "run_paused")).toBe(
					true,
				);
			});
			expect(killActiveWorkers).not.toHaveBeenCalled();
			const pausedState = rec.states.find((s) => s.phase === "paused");
			expect(pausedState).toBeDefined();
			expect(
				rec.pauses.some((p) => p.paused && p.message?.includes("Resume")),
			).toBe(true);
			expect(consoleSpies.error).toHaveBeenCalledWith(
				expect.stringContaining("run paused"),
			);
			expect(vi.mocked(logLine)).toHaveBeenCalledWith(
				ctx.rootDir,
				expect.stringContaining("run paused"),
			);
			const ex = sorEvents().find(
				(e) => e.event_type === "all_models_exhausted",
			);
			expect(ex).toBeDefined();
			expect(ex?.payload).toMatchObject({
				role: "tester",
				provider: "gemini",
				models: ["gemini-a", "gemini-b"],
			});
			expect(
				setIntervalSpy.mock.calls.filter(([, ms]) => ms === 300_000),
			).toHaveLength(1);

			// Resume click (index.ts routes it through resumeFromPause()).
			await writeFile(
				join(ctx.rootDir, ".env"),
				'GEMINI_API_KEY="fresh-key-from-disk"\nOPENROUTER_API_KEY=fresh-or-key\n',
				"utf8",
			);
			expect(resumeFromPause()).toBe(true);
			expect(process.env.GEMINI_API_KEY).toBe("fresh-key-from-disk");
			expect(process.env.OPENROUTER_API_KEY).toBe("fresh-or-key");
			expect(invalidateProviderClients).toHaveBeenCalledTimes(1);
			expect(resetGeminiQuotaCoordinator).toHaveBeenCalledTimes(1);
			expect(requestQuotaResume).toHaveBeenCalledTimes(1);
			const resumed = sorEvents().find((e) => e.event_type === "run_resumed");
			expect(resumed).toBeDefined();
			expect(resumed?.payload).toMatchObject({
				role: "tester",
				provider: "gemini",
			});
			const reminderIdx = setIntervalSpy.mock.calls.findIndex(
				([, ms]) => ms === 300_000,
			);
			expect(reminderIdx).toBeGreaterThanOrEqual(0);
			const reminderHandle = setIntervalSpy.mock.results[reminderIdx]?.value;
			expect(clearIntervalSpy).toHaveBeenCalledWith(reminderHandle);
			expect(rec.pauses[rec.pauses.length - 1]?.paused).toBe(false);

			release();
			const summary = await runP;
			expect(summary.status).toBe("completed"); // quota did NOT kill the run
			expect(summary.failure).toBeUndefined();
		} finally {
			clearIntervalSpy.mockRestore();
			setIntervalSpy.mockRestore();
			for (const [k, v] of Object.entries(savedKeys)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("finalizes failed normally when the user Stops during the pause, writing result.json", async () => {
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "analyzer") {
				emitQuotaEvent(exhaustedEvent);
				// The real walk returns this after killActiveWorkers breaks its pause wait.
				return makeResult(role, "", false, "aborted by user");
			}
			throw new Error(`role ${role} must not run after Stop during pause`);
		});
		const { feed, rec } = makeFeed();
		const ctx = await makeCtx();
		const summary = await runOrchestrator(ctx, { web: feed });

		expect(summary.status).toBe("failed");
		expect(summary.failure).toBe("aborted by user");
		expect(killActiveWorkers).not.toHaveBeenCalled();
		// Pause side effects torn down by finalize: reminder cleared + banner cleared.
		expect(rec.pauses[rec.pauses.length - 1]?.paused).toBe(false);
		// Rider bug #6: failed finalizations persist result.json too.
		const resultJson = JSON.parse(
			await readFile(join(ctx.runDir, "result.json"), "utf8"),
		) as {
			status: string;
			failure?: string;
			agents: Record<string, { error?: string } | undefined>;
		};
		expect(resultJson.status).toBe("failed");
		expect(resultJson.failure).toBe("aborted by user");
		expect(resultJson.agents.analyzer?.error).toBe("aborted by user");
	});

	it("collapses consecutive duplicate model ids when reporting fallbacks", () => {
		expect(collapseConsecutiveModels(["a", "a", "b", "b", "a"])).toEqual([
			"a",
			"b",
			"a",
		]);
		expect(collapseConsecutiveModels(["a"])).toEqual(["a"]);
		expect(collapseConsecutiveModels([])).toEqual([]);
	});

	it("logs the fallback line with consecutive duplicates collapsed and skips single-model walks", async () => {
		stubHappyPath();
		vi.mocked(runWorker).mockImplementation(async (role: Role) => {
			if (role === "analyzer") {
				return {
					...makeResult(role, FIX_SPEC_JSON),
					attempts: [
						{ model: "gemini-a", ok: false, error: "x", provider: "gemini" },
						{ model: "gemini-a", ok: false, error: "y", provider: "gemini" },
						{ model: "gemini-b", ok: true, provider: "gemini" },
					],
				};
			}
			if (role === "pr")
				return makeResult(
					role,
					"Opened PR https://github.com/acme/widget/pull/99",
				);
			if (role === "reviewer") return makeResult(role, approveText);
			if (role === "planner")
				return {
					...makeResult(role, PLAN_JSON),
					attempts: [{ model: "gemini-a", ok: true, provider: "gemini" }],
				};
			return makeResult(role);
		});
		const ctx = await makeCtx();
		await runOrchestrator(ctx, {});

		expect(vi.mocked(logLine)).toHaveBeenCalledWith(
			ctx.rootDir,
			"[analyzer] fell back across 2 models: gemini-a -> gemini-b",
		);
		expect(vi.mocked(logLine)).not.toHaveBeenCalledWith(
			ctx.rootDir,
			expect.stringContaining("[planner] fell back"),
		);
	});

	it("unsubscribes when the run ends: post-run events reach nothing", async () => {
		stubHappyPath();
		const { feed } = makeFeed();
		const ctx = await makeCtx();
		await runOrchestrator(ctx, { web: feed });

		const sorCallsAfterRun = vi.mocked(appendAuditEvent).mock.calls.length;
		const warnCallsAfterRun = consoleSpies.warn.mock.calls.length;
		emitQuotaEvent(switchEvent);
		expect(vi.mocked(appendAuditEvent).mock.calls.length).toBe(
			sorCallsAfterRun,
		);
		expect(consoleSpies.warn.mock.calls.length).toBe(warnCallsAfterRun);
		expect(vi.mocked(logLine)).not.toHaveBeenCalledWith(
			ctx.rootDir,
			expect.stringContaining("[quota]"),
		);
		expect(killActiveWorkers).not.toHaveBeenCalled();
	});

	it("skips the boot gates entirely for a dry-run even with broken quota env", async () => {
		const prevLimits = process.env.GEMINI_QUOTA_LIMITS;
		const prevAnalyzer = process.env.ANALYZER_MODEL_GEMINI;
		process.env.GEMINI_QUOTA_LIMITS = "{invalid";
		delete process.env.ANALYZER_MODEL_GEMINI;
		try {
			stubHappyPath();
			const { feed } = makeFeed();
			const ctx = await makeCtx(true);
			const summary = await runOrchestrator(ctx, { web: feed });
			expect(summary.status).toBe("completed");
			expect(resetSessionLog).toHaveBeenCalled();
			expect(ensureChain).toHaveBeenCalled();
		} finally {
			if (prevLimits === undefined) delete process.env.GEMINI_QUOTA_LIMITS;
			else process.env.GEMINI_QUOTA_LIMITS = prevLimits;
			if (prevAnalyzer === undefined) delete process.env.ANALYZER_MODEL_GEMINI;
			else process.env.ANALYZER_MODEL_GEMINI = prevAnalyzer;
		}
	});

	it("fails fast before any side effects when a role chain var is missing on a real run", async () => {
		const prevAnalyzer = process.env.ANALYZER_MODEL_GEMINI;
		const prevPool = process.env.GEMINI_RATE_LIMIT_MODELS;
		delete process.env.ANALYZER_MODEL_GEMINI;
		process.env.GEMINI_RATE_LIMIT_MODELS = "";
		try {
			const ctx = await makeCtx(false);
			const summary = await runOrchestrator(ctx, {});
			expect(summary.status).toBe("failed");
			expect(summary.failure).toContain(
				"Invalid Gemini model chain configuration",
			);
			expect(summary.failure).toContain("ANALYZER_MODEL_GEMINI");
			expect(ensureChain).not.toHaveBeenCalled();
			expect(resetSessionLog).not.toHaveBeenCalled();
			expect(setupWorktree).not.toHaveBeenCalled();
			expect(runWorker).not.toHaveBeenCalled();
		} finally {
			if (prevAnalyzer === undefined) delete process.env.ANALYZER_MODEL_GEMINI;
			else process.env.ANALYZER_MODEL_GEMINI = prevAnalyzer;
			if (prevPool === undefined) delete process.env.GEMINI_RATE_LIMIT_MODELS;
			else process.env.GEMINI_RATE_LIMIT_MODELS = prevPool;
		}
	});

	it("assertGeminiModelChainConfiguration throws listing the missing role var (stubbed env)", async () => {
		const { assertGeminiModelChainConfiguration } = await import(
			"../gemini/quotaConfig.ts"
		);
		const prevAnalyzer = process.env.ANALYZER_MODEL_GEMINI;
		const prevPool = process.env.GEMINI_RATE_LIMIT_MODELS;
		delete process.env.ANALYZER_MODEL_GEMINI;
		process.env.GEMINI_RATE_LIMIT_MODELS = "";
		try {
			expect(() => assertGeminiModelChainConfiguration(["analyzer"])).toThrow(
				/ANALYZER_MODEL_GEMINI/,
			);
		} finally {
			if (prevAnalyzer === undefined) delete process.env.ANALYZER_MODEL_GEMINI;
			else process.env.ANALYZER_MODEL_GEMINI = prevAnalyzer;
			if (prevPool === undefined) delete process.env.GEMINI_RATE_LIMIT_MODELS;
			else process.env.GEMINI_RATE_LIMIT_MODELS = prevPool;
		}
	});
});
