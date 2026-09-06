import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isQuotaPaused,
	isTransientNetworkError,
	killActiveWorkers,
	parseTrace,
	readStderrTail,
	requestQuotaResume,
	resetWorkerAbort,
	runWorker,
} from "../agentRunner.ts";
import {
	onQuotaEvent,
	type QuotaEvent,
	resetQuotaEventListeners,
} from "../fleet/quotaEvents.ts";
import { RPD_EXHAUSTED } from "../fleet/quotaSignals.ts";
import type { AgentResult, Role, RolePolicy, RunContext } from "../types.ts";

const FAKE_WORKER = join(import.meta.dirname, "fixtures", "fakeWorker.mjs");
const LONG_WORKER = join(import.meta.dirname, "fixtures", "longWorker.mjs");

/**
 * Scriptable quota worker: like fixtures/fakeWorker.mjs but each fork consumes
 * the next entry of FAKE_QUOTA_SCRIPT (shared via a counter file so every
 * spawnOnce attempt advances it) and logs the requested model. An entry with
 * `error` emits an error event and exits 1; otherwise the worker succeeds.
 */
const QUOTA_WORKER_SRC = `
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const job = JSON.parse(raw);
  const stateDir = process.env.FAKE_QUOTA_DIR;
  const counterPath = join(stateDir, "counter");
  const logPath = join(stateDir, "models.log");
  const n = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) : 0;
  writeFileSync(counterPath, String(n + 1));
  appendFileSync(logPath, job.ctx.model + "\\n");
  appendFileSync(join(stateDir, "resume.log"), JSON.stringify(job.ctx.resumeFrom ?? null) + "\\n");
  const send = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
  send({ t: "init", role: job.role, model: job.ctx.model, provider: process.env.SOR_PROVIDER, sessionId: "sess-q-" + n });
  const script = JSON.parse(process.env.FAKE_QUOTA_SCRIPT ?? "[]");
  const step = script[Math.min(n, script.length - 1)] ?? {};
  if (step.error) {
    send({ t: "error", error: step.error });
    process.exit(1);
  }
  const text = "ok from " + job.ctx.model;
  send({ t: "text", part: { text } });
  send({ t: "result", text });
  send({
    t: "step_finish",
    usage: { input: 1, output: 1, reasoning: 0, cached: 0, cacheWrite: 0, total: 2 },
    costUsd: 0,
  });
  process.exit(0);
});
`;

// ---- Shared fixtures ----

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
	return {
		runId: "test-run-123",
		rootDir: "/repo",
		runDir: "/repo/.runs/test-run-123",
		worktreeDir: "/repo/.runs/test-run-123/worktree",
		tracesDir: "/repo/.runs/test-run-123/traces",
		branch: "fix/test-branch",
		dryRun: false,
		issue: {
			repo: "owner/repo",
			number: 42,
			title: "Test issue",
			body: "Reproduce the bug",
			url: "https://github.com/owner/repo/issues/42",
			state: "open",
			labels: [],
			author: "dev",
		},
		repoUrl: "git@github.com:owner/repo.git",
		...overrides,
	};
}

function makePolicy(overrides: Partial<RolePolicy> = {}): RolePolicy {
	return {
		role: "coder" as Role,
		model: "opencode/laguna-s-2.1-free",
		fallbacks: ["opencode/deepseek-v4-flash-free"],
		...overrides,
	};
}

function makeGeminiPolicy(): RolePolicy {
	return {
		role: "coder",
		model: "gemini-test-primary",
		fallbacks: ["gemini-test-fallback"],
	};
}

let tmpTraceDir: string;
let savedEnv: Record<string, string | undefined>;
const extraTmpDirs: string[] = [];

beforeEach(() => {
	tmpTraceDir = join(
		tmpdir(),
		"opencode-test-" +
			Date.now() +
			"-" +
			Math.random().toString(36).slice(2, 8),
	);
	mkdirSync(tmpTraceDir, { recursive: true });
	savedEnv = {};
	for (const key of [
		"FLEET_WORKER_ENTRY",
		"FAKE_FAIL_PROVIDERS",
		"FAKE_QUOTA_SCRIPT",
		"FAKE_QUOTA_DIR",
		"FLEET_PROVIDERS",
		"WORKER_TIMEOUT_MS",
		"WORKER_TIMEOUT_GRACE_MS",
		"GEMINI_API_KEY",
		"GEMINI_QUOTA_LIMITS",
		"GEMINI_RATE_LIMIT_MODELS",
		"GEMINI_RATE_LIMIT_WAIT_MS",
		"OPENROUTER_API_KEY",
	]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	resetWorkerAbort();
	resetQuotaEventListeners();
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tmpTraceDir, { recursive: true, force: true });
	while (extraTmpDirs.length) {
		const dir = extraTmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	requestQuotaResume(); // release any pause waiter a failed test left parked
	resetWorkerAbort();
});

/** Real temp ctx dirs: the manager forks with cwd = ctx.rootDir, which must exist. */
function makeRealCtx(): RunContext {
	const root = mkdtempSync(join(tmpdir(), "rw-fork-"));
	const runDir = join(root, ".runs", "test-run-123");
	return makeCtx({
		rootDir: root,
		runDir,
		worktreeDir: join(runDir, "worktree"),
		tracesDir: join(runDir, "traces"),
	});
}

function writeTrace(name: string, content: string): string {
	const path = join(tmpTraceDir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

/** Materialize the scriptable quota worker and point FLEET_WORKER_ENTRY at it. */
function installQuotaWorker(script: Array<{ error?: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "quota-wk-"));
	extraTmpDirs.push(dir);
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(dir, "quotaWorker.mjs"), QUOTA_WORKER_SRC, "utf8");
	process.env.FLEET_WORKER_ENTRY = join(dir, "quotaWorker.mjs");
	process.env.FAKE_QUOTA_SCRIPT = JSON.stringify(script);
	process.env.FAKE_QUOTA_DIR = stateDir;
	return stateDir;
}

/** Collect manager-side quota events for assertions. */
function collectQuotaEvents(): QuotaEvent[] {
	const events: QuotaEvent[] = [];
	onQuotaEvent((e) => events.push(e));
	return events;
}

/** Real-time condition poll for pause-entry assertions (pause polls every 500ms). */
async function waitFor(
	condition: () => boolean,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + 15000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/**
 * Drive a pending runWorker under fake timers: advances the fake clock so
 * quota-wait polls fire while real fork I/O progresses between advancements.
 * Guards on real wall-clock time, failing if the walk never settles.
 */
async function settleUnderFakeTimers(
	pending: Promise<AgentResult>,
): Promise<AgentResult> {
	let settled = false;
	let value!: AgentResult;
	let failure: unknown;
	void pending.then(
		(v) => {
			settled = true;
			value = v;
		},
		(err) => {
			settled = true;
			failure = err;
		},
	);
	const started = performance.now();
	while (!settled) {
		if (vi.getTimerCount() === 0) {
			await new Promise((r) => setImmediate(r));
		} else {
			await vi.advanceTimersByTimeAsync(50);
		}
		if (performance.now() - started > 60000)
			throw new Error("runWorker did not settle under fake timers");
	}
	if (failure !== undefined) throw failure;
	return value;
}

// ---- runWorker tests (fork + stdin-job contract against a fake worker entry) ----

describe("runWorker", () => {
	it("stubs workers on dryRun without touching the DB or forking", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rw-"));
		const runDir = join(dir, ".runs", "test-run-123");
		const ctx = makeCtx({
			runDir,
			worktreeDir: join(runDir, "worktree"),
			tracesDir: join(runDir, "traces"),
			dryRun: true,
		});
		// No FLEET_WORKER_ENTRY configured: any fork would target the real worker
		// entry and fail loudly — the stub must short-circuit before that.
		const result = await runWorker(
			"coder",
			"Fix the bug",
			ctx,
			makePolicy(),
			{},
		);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("[dry-run]");
		expect(result.provider).toBe("gemini");
		expect(result.attempts).toEqual([
			{ model: "opencode/laguna-s-2.1-free", ok: true, provider: "gemini" },
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("forks ONE JSON job into the worker and reads the answer back from the redirected trace stream", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "ollama";
		const ctx = makeRealCtx();
		const res = await runWorker(
			"coder",
			"Fix the bug #42",
			ctx,
			makePolicy(),
			{},
		);

		expect(res.ok).toBe(true);
		expect(res.provider).toBe("ollama");
		expect(res.sessionID).toBe("sess-fake-1");
		expect(res.model).toBe("fake-model");
		expect(res.text).toContain("hello from ollama re: Fix the bug #42");
		expect(res.tokens.input).toBe(3);
		expect(res.attempts).toEqual([
			{ model: "fake-model", ok: true, provider: "ollama" },
		]);
		// stdio fd redirect: the worker's NDJSON landed in tracesDir/<role>.jsonl
		const trace = readFileSync(join(ctx.tracesDir, "coder.jsonl"), "utf8");
		expect(trace).toContain('"t":"init"');
		expect(trace).toContain('"t":"result"');
	}, 30000);

	it("threads opts.extraTask through the job ctx verbatim", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "ollama";
		const ctx = makeRealCtx();
		const res = await runWorker("coder", "base task", ctx, makePolicy(), {
			extraTask: "reviewer findings: fix flaky test",
		});
		expect(res.ok).toBe(true);
		expect(res.text).toContain("[extra: reviewer findings: fix flaky test]");
	}, 30000);

	it("walks FLEET_PROVIDERS on runtime failure and records every attempt with its provider", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "gemini,ollama";
		process.env.GEMINI_API_KEY = "dummy-key-for-walk-test";
		process.env.FAKE_FAIL_PROVIDERS = "gemini";
		const ctx = makeRealCtx();
		const res = await runWorker("coder", "walk me", ctx, makePolicy(), {});

		expect(res.ok).toBe(true);
		expect(res.attempts).toEqual([
			{
				model: "fake-model",
				ok: false,
				error: "synthetic failure on gemini",
				provider: "gemini",
			},
			{ model: "fake-model", ok: true, provider: "ollama" },
		]);
		expect(res.provider).toBe("ollama");
		expect(res.text).toContain("hello from ollama re: walk me");
	}, 30000);

	it("keeps an explicitly selected provider authoritative over FLEET_PROVIDERS", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "ollama";
		process.env.GEMINI_API_KEY = "dummy-key-for-selection-test";
		const ctx = makeRealCtx();
		const res = await runWorker(
			"coder",
			"selected provider",
			{ ...ctx, provider: "gemini" },
			makePolicy(),
			{},
		);

		expect(res.ok).toBe(true);
		expect(res.provider).toBe("gemini");
		expect(res.attempts).toEqual([
			{ model: "fake-model", ok: true, provider: "gemini" },
		]);
		expect(res.text).toContain("hello from gemini re: selected provider");
	}, 30000);

	it("does not validate Gemini quota configuration for an explicitly selected non-Gemini provider", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.GEMINI_QUOTA_LIMITS = "{invalid";
		const ctx = makeRealCtx();
		const res = await runWorker(
			"coder",
			"selected ollama",
			{ ...ctx, provider: "ollama" },
			makePolicy(),
			{},
		);

		expect(res.ok).toBe(true);
		expect(res.provider).toBe("ollama");
	}, 30000);

	it("fails clearly instead of falling back when selected provider has no key", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "ollama";
		const ctx = makeRealCtx();
		const res = await runWorker(
			"coder",
			"missing key",
			{ ...ctx, provider: "gemini" },
			makePolicy(),
			{},
		);

		expect(res.ok).toBe(false);
		expect(res.error).toBe('selected provider "gemini" has no key configured');
		expect(res.attempts).toEqual([
			{
				model: "none",
				ok: false,
				error: 'selected provider "gemini" has no key configured',
			},
		]);
		expect(existsSync(join(ctx.tracesDir, "coder.jsonl"))).toBe(false);
	});

	it("fails fast with a synthetic attempt when no candidate provider has keys", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.FLEET_PROVIDERS = "gemini";
		delete process.env.GEMINI_API_KEY;
		const ctx = makeRealCtx();
		const res = await runWorker("coder", "never forked", ctx, makePolicy(), {});

		expect(res.ok).toBe(false);
		expect(res.error).toBe("no provider keys configured");
		expect(res.attempts).toEqual([
			{ model: "none", ok: false, error: "no provider keys configured" },
		]);
		expect(existsSync(join(ctx.tracesDir, "coder.jsonl"))).toBe(false);
	});

	it("killActiveWorkers SIGTERMs the live fork and latches fail-fast ('aborted by user')", async () => {
		process.env.FLEET_WORKER_ENTRY = LONG_WORKER;
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-abort-test";
		const ctx = makeRealCtx();

		const pending = runWorker("coder", "task", ctx, makePolicy(), {});
		let killed = 0;
		for (let i = 0; i < 600 && killed === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			killed = killActiveWorkers();
		}
		expect(killed).toBeGreaterThan(0);

		const started = Date.now();
		const res = await pending;
		const elapsed = Date.now() - started;

		expect(res.ok).toBe(false);
		expect(res.sawError).toBe(true);
		expect(res.error).toBe("aborted by user");
		expect(res.attempts).toEqual([
			{
				model: "opencode/laguna-s-2.1-free",
				ok: false,
				error: "aborted by user",
				provider: "gemini",
			},
		]);
		expect(elapsed).toBeLessThan(10000);
	}, 30000);
});

// ---- runWorker Gemini quota chain walk (PLAN.md rate-limit fallback system) ----

describe("runWorker Gemini quota chain walk", () => {
	it("switches to the fallback on an rpm block and succeeds without a recovery event", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-walk";
		installQuotaWorker([{ error: "GEMINI_RATE_LIMIT_SWITCH:rpm:4200" }, {}]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const res = await runWorker(
			"coder",
			"quota switch",
			ctx,
			makeGeminiPolicy(),
			{},
		);

		expect(res.ok).toBe(true);
		expect(res.model).toBe("gemini-test-fallback");
		expect(res.attempts).toEqual([
			{
				model: "gemini-test-primary",
				ok: false,
				error: "GEMINI_RATE_LIMIT_SWITCH:rpm:4200",
				provider: "gemini",
			},
			{ model: "gemini-test-fallback", ok: true, provider: "gemini" },
		]);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "gemini-test-primary",
				toModel: "gemini-test-fallback",
				block: "rpm",
				waitMs: 4200,
			},
		]);
	}, 30000);

	it("restarts the chain from the top after a capped sleep until the primary recovers", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			process.env.FLEET_PROVIDERS = "gemini";
			process.env.GEMINI_API_KEY = "dummy-key-for-quota-recovery";
			process.env.GEMINI_RATE_LIMIT_WAIT_MS = "1000";
			// Cycle 1: both blocked (min wait 3000 -> capped to 1000). Cycle 2:
			// both blocked again (min wait 400). Cycle 3: primary succeeds.
			installQuotaWorker([
				{ error: "GEMINI_RATE_LIMIT_SWITCH:rpm:7000" },
				{ error: "GEMINI_RATE_LIMIT_SWITCH:rpm:3000" },
				{ error: "GEMINI_RATE_LIMIT_SWITCH:rpm:400" },
				{ error: "GEMINI_RATE_LIMIT_SWITCH:rpm:500" },
				{},
			]);
			const ctx = makeRealCtx();
			const events = collectQuotaEvents();

			const res = await settleUnderFakeTimers(
				runWorker("coder", "quota fail-back", ctx, makeGeminiPolicy(), {}),
			);
			expect(res.ok).toBe(true);
			expect(res.model).toBe("gemini-test-primary");
			expect(
				readFileSync(
					join(process.env.FAKE_QUOTA_DIR ?? "", "models.log"),
					"utf8",
				)
					.trim()
					.split("\n"),
			).toEqual([
				"gemini-test-primary",
				"gemini-test-fallback",
				"gemini-test-primary",
				"gemini-test-fallback",
				"gemini-test-primary",
			]);
			expect(res.attempts).toHaveLength(5);
			expect(
				res.attempts?.map((a) => `${a.model}:${a.ok ? "ok" : a.error}`),
			).toEqual([
				"gemini-test-primary:GEMINI_RATE_LIMIT_SWITCH:rpm:7000",
				"gemini-test-fallback:GEMINI_RATE_LIMIT_SWITCH:rpm:3000",
				"gemini-test-primary:GEMINI_RATE_LIMIT_SWITCH:rpm:400",
				"gemini-test-fallback:GEMINI_RATE_LIMIT_SWITCH:rpm:500",
				"gemini-test-primary:ok",
			]);
			expect(events).toEqual([
				{
					type: "model_switch",
					role: "coder",
					provider: "gemini",
					fromModel: "gemini-test-primary",
					toModel: "gemini-test-fallback",
					block: "rpm",
					waitMs: 7000,
				},
				{
					type: "model_switch",
					role: "coder",
					provider: "gemini",
					fromModel: "gemini-test-primary",
					toModel: "gemini-test-fallback",
					block: "rpm",
					waitMs: 400,
				},
				{
					type: "model_recovered",
					role: "coder",
					provider: "gemini",
					model: "gemini-test-primary",
				},
			]);
			// Two capped waits (1000ms + 400ms), polled in <=100ms slices: exactly
			// fourteen 100ms sleeps proves the min(waitMs)-vs-ceiling math.
			const sleeps = setTimeoutSpy.mock.calls
				.map((c) => c[1] as number)
				.filter((ms) => ms === 100);
			expect(sleeps).toHaveLength(14);
		} finally {
			setTimeoutSpy.mockRestore();
			vi.useRealTimers();
			resetWorkerAbort();
		}
	}, 60000);

	it("pauses on all-RPD instead of failing, then resumes from the chain top seeded with the checkpoint", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-pause";
		installQuotaWorker([
			{ error: RPD_EXHAUSTED },
			{ error: RPD_EXHAUSTED },
			{},
			{},
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const pending = runWorker(
			"coder",
			"quota pause",
			ctx,
			makeGeminiPolicy(),
			{},
		);
		await waitFor(() => isQuotaPaused(), "quota pause entry");
		expect(events.some((e) => e.type === "all_models_exhausted")).toBe(true);

		// The worker checkpoints every turn; a checkpoint on disk must seed the
		// post-resume spawns so the LLM continues mid-conversation.
		const checkpointPath = join(ctx.runDir, "checkpoints", "coder.json");
		mkdirSync(join(ctx.runDir, "checkpoints"), { recursive: true });
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				role: "coder",
				model: "gemini-test-primary",
				chainIndex: 0,
				messages: [],
				savedAt: new Date().toISOString(),
			}),
			"utf8",
		);

		expect(requestQuotaResume()).toBe(true);
		const res = await pending;

		expect(res.ok).toBe(true);
		expect(res.model).toBe("gemini-test-primary");
		expect(res.attempts).toEqual([
			{
				model: "gemini-test-primary",
				ok: false,
				error: RPD_EXHAUSTED,
				provider: "gemini",
			},
			{
				model: "gemini-test-fallback",
				ok: false,
				error: RPD_EXHAUSTED,
				provider: "gemini",
			},
			{ model: "gemini-test-primary", ok: true, provider: "gemini" },
		]);
		// Chain restarted FROM THE TOP after resume; attempts accumulate across
		// pause cycles.
		expect(
			readFileSync(join(process.env.FAKE_QUOTA_DIR ?? "", "models.log"), "utf8")
				.trim()
				.split("\n"),
		).toEqual([
			"gemini-test-primary",
			"gemini-test-fallback",
			"gemini-test-primary",
		]);
		// Only the post-resume attempt carries ctx.resumeFrom.messagesPath.
		const fakeQuotaDir = process.env.FAKE_QUOTA_DIR ?? "";
		const resumeLog = readFileSync(join(fakeQuotaDir, "resume.log"), "utf8")
			.trim()
			.split("\n");
		expect(resumeLog).toHaveLength(3);
		expect(resumeLog[0]).toBe("null");
		expect(resumeLog[1]).toBe("null");
		expect(resumeLog[2]).toBe(JSON.stringify({ messagesPath: checkpointPath }));
		expect(isQuotaPaused()).toBe(false);
	}, 30000);

	it("re-enters the pause (loop-safe) when the resumed key is exhausted again", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-repause";
		installQuotaWorker([
			{ error: RPD_EXHAUSTED },
			{ error: RPD_EXHAUSTED },
			{ error: RPD_EXHAUSTED },
			{ error: RPD_EXHAUSTED },
			{},
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const pending = runWorker(
			"coder",
			"quota re-pause",
			ctx,
			makeGeminiPolicy(),
			{},
		);
		await waitFor(() => isQuotaPaused(), "first pause");
		expect(requestQuotaResume()).toBe(true);
		// The second exhaustion proves the walk actually restarted and parked again.
		const exhaustions = (): QuotaEvent[] =>
			events.filter((e) => e.type === "all_models_exhausted");
		await waitFor(() => exhaustions().length === 2, "second pause");
		expect(requestQuotaResume()).toBe(true);

		const res = await pending;
		expect(res.ok).toBe(true);
		expect(res.attempts).toHaveLength(5);
		expect(exhaustions()).toHaveLength(2);
		expect(exhaustions().every((e) => e.role === "coder")).toBe(true);
	}, 30000);

	it("finalizes failed through the normal path when the user Stops during the pause", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-pause-abort";
		installQuotaWorker([{ error: RPD_EXHAUSTED }, { error: RPD_EXHAUSTED }]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const pending = runWorker(
			"coder",
			"pause abort",
			ctx,
			makeGeminiPolicy(),
			{},
		);
		await waitFor(() => isQuotaPaused(), "quota pause entry");

		killActiveWorkers();
		const res = await pending;

		expect(res.ok).toBe(false);
		expect(res.error).toBe("aborted by user");
		expect(isQuotaPaused()).toBe(false);
		expect(requestQuotaResume()).toBe(false); // waiter cleared, nothing parked
		expect(events.some((e) => e.type === "all_models_exhausted")).toBe(true);
	}, 30000);

	it("restarts from the top without ctx.resumeFrom when no checkpoint exists on disk", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-pause-nocp";
		installQuotaWorker([
			{ error: RPD_EXHAUSTED },
			{ error: RPD_EXHAUSTED },
			{},
		]);
		const ctx = makeRealCtx();

		const pending = runWorker(
			"coder",
			"pause no checkpoint",
			ctx,
			makeGeminiPolicy(),
			{},
		);
		await waitFor(() => isQuotaPaused(), "quota pause entry");
		expect(requestQuotaResume()).toBe(true);
		const res = await pending;

		expect(res.ok).toBe(true);
		const fakeQuotaDir = process.env.FAKE_QUOTA_DIR ?? "";
		const resumeLog = readFileSync(join(fakeQuotaDir, "resume.log"), "utf8")
			.trim()
			.split("\n");
		expect(resumeLog).toEqual(["null", "null", "null"]);
	}, 30000);

	it("stops immediately with the raw error on a non-temporary unknown failure", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-quota-unknown";
		installQuotaWorker([{ error: "kaboom" }]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const res = await runWorker(
			"coder",
			"unknown error",
			ctx,
			makeGeminiPolicy(),
			{},
		);

		expect(res.ok).toBe(false);
		expect(res.error).toBe("kaboom");
		expect(res.attempts).toEqual([
			{
				model: "gemini-test-primary",
				ok: false,
				error: "kaboom",
				provider: "gemini",
			},
		]);
		expect(events).toEqual([]);
	}, 30000);

	it("falls back on a 503 HTTP status error and succeeds on the next model", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-http-503";
		installQuotaWorker([
			{
				error:
					'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
			},
			{},
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const policy: RolePolicy = {
			role: "coder",
			model: "m-a",
			fallbacks: ["m-b", "m-c"],
		};
		const res = await runWorker("coder", "http 503 fallback", ctx, policy, {});

		expect(res.ok).toBe(true);
		expect(res.model).toBe("m-b");
		expect(res.attempts).toEqual([
			{
				model: "m-a",
				ok: false,
				error:
					'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
				provider: "gemini",
			},
			{ model: "m-b", ok: true, provider: "gemini" },
		]);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "m-a",
				toModel: "m-b",
				block: "http",
				waitMs: 0,
			},
		]);
		const fakeQuotaDir = process.env.FAKE_QUOTA_DIR ?? "";
		expect(
			readFileSync(join(fakeQuotaDir, "models.log"), "utf8").trim().split("\n"),
		).toEqual(["m-a", "m-b"]);
	}, 30000);

	it("exhausts all models when every one returns a 503 HTTP status error", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-http-all-503";
		installQuotaWorker([
			{
				error:
					'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
			},
			{
				error:
					'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
			},
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const policy: RolePolicy = {
			role: "coder",
			model: "m-a",
			fallbacks: ["m-b"],
		};
		const res = await runWorker("coder", "all 503 exhaust", ctx, policy, {});

		expect(res.ok).toBe(false);
		expect(res.error).toBe(
			'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
		);
		expect(res.attempts).toHaveLength(2);
		expect(res.attempts?.[0]?.ok).toBe(false);
		expect(res.attempts?.[1]?.ok).toBe(false);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "m-a",
				toModel: "m-b",
				block: "http",
				waitMs: 0,
			},
		]);
		const fakeQuotaDir = process.env.FAKE_QUOTA_DIR ?? "";
		expect(
			readFileSync(join(fakeQuotaDir, "models.log"), "utf8").trim().split("\n"),
		).toEqual(["m-a", "m-b"]);
	}, 30000);

	it("falls back on a 500 HTTP status error the same way as 503", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-http-500";
		installQuotaWorker([
			{
				error:
					'500 [{"error":{"code":500,"message":"Internal Server Error","status":"INTERNAL"}}]',
			},
			{},
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const policy: RolePolicy = {
			role: "coder",
			model: "m-x",
			fallbacks: ["m-y"],
		};
		const res = await runWorker("coder", "http 500 fallback", ctx, policy, {});

		expect(res.ok).toBe(true);
		expect(res.model).toBe("m-y");
		expect(res.attempts).toEqual([
			{
				model: "m-x",
				ok: false,
				error:
					'500 [{"error":{"code":500,"message":"Internal Server Error","status":"INTERNAL"}}]',
				provider: "gemini",
			},
			{ model: "m-y", ok: true, provider: "gemini" },
		]);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "m-x",
				toModel: "m-y",
				block: "http",
				waitMs: 0,
			},
		]);
	}, 30000);

	it("falls back on a worker-side network timeout and succeeds on the next model", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-timeout-fallback";
		installQuotaWorker([{ error: "Request timed out." }, {}]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const policy: RolePolicy = {
			role: "coder",
			model: "m-a",
			fallbacks: ["m-b"],
		};
		const res = await runWorker("coder", "timeout fallback", ctx, policy, {});

		expect(res.ok).toBe(true);
		expect(res.model).toBe("m-b");
		expect(res.attempts).toEqual([
			{
				model: "m-a",
				ok: false,
				error: "Request timed out.",
				provider: "gemini",
			},
			{ model: "m-b", ok: true, provider: "gemini" },
		]);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "m-a",
				toModel: "m-b",
				block: "timeout",
				waitMs: 0,
			},
		]);
		const fakeQuotaDir = process.env.FAKE_QUOTA_DIR ?? "";
		expect(
			readFileSync(join(fakeQuotaDir, "models.log"), "utf8").trim().split("\n"),
		).toEqual(["m-a", "m-b"]);
	}, 30000);

	it("fails on the last model when every chain model times out", async () => {
		process.env.FLEET_PROVIDERS = "gemini";
		process.env.GEMINI_API_KEY = "dummy-key-for-all-timeout";
		installQuotaWorker([
			{ error: "Request timed out." },
			{ error: "APIConnectionTimeoutError: Request timed out." },
		]);
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const policy: RolePolicy = {
			role: "coder",
			model: "m-a",
			fallbacks: ["m-b"],
		};
		const res = await runWorker("coder", "all timeout", ctx, policy, {});

		expect(res.ok).toBe(false);
		expect(res.error).toContain("Request timed out.");
		expect(res.attempts).toEqual([
			{
				model: "m-a",
				ok: false,
				error: "Request timed out.",
				provider: "gemini",
			},
			{
				model: "m-b",
				ok: false,
				error: "APIConnectionTimeoutError: Request timed out.",
				provider: "gemini",
			},
		]);
		expect(events).toEqual([
			{
				type: "model_switch",
				role: "coder",
				provider: "gemini",
				fromModel: "m-a",
				toModel: "m-b",
				block: "timeout",
				waitMs: 0,
			},
		]);
	}, 30000);

	it("keeps the openrouter walk single-model and quota-event-free", async () => {
		process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
		process.env.OPENROUTER_API_KEY = "dummy-key-for-openrouter-walk";
		const ctx = makeRealCtx();
		const events = collectQuotaEvents();

		const res = await runWorker(
			"coder",
			"openrouter walk",
			{ ...ctx, provider: "openrouter" },
			makeGeminiPolicy(),
			{},
		);

		expect(res.ok).toBe(true);
		expect(res.provider).toBe("openrouter");
		expect(res.attempts).toEqual([
			{ model: "fake-model", ok: true, provider: "openrouter" },
		]);
		expect(events).toEqual([]);
	}, 30000);
});

// ---- isTransientNetworkError tests ----

describe("isTransientNetworkError", () => {
	it("matches timeout, connection, and transport-failure messages", () => {
		for (const msg of [
			"Request timed out.",
			"APIConnectionTimeoutError: Request timed out.",
			"connect ECONNREFUSED 127.0.0.1:11434",
			"read ECONNRESET",
			"connect ETIMEDOUT 1.2.3.4:443",
			"socket hang up",
			"fetch failed",
			"Connection error.",
			"network error",
			"headersTimeout is too low",
		]) {
			expect(isTransientNetworkError(msg)).toBe(true);
		}
	});

	it("rejects non-network terminal errors", () => {
		for (const msg of [
			"kaboom",
			"400 INVALID_ARGUMENT",
			"GEMINI_RATE_LIMIT_WAIT_EXCEEDED",
			"GEMINI_RATE_LIMIT_SWITCH:rpm:4200",
			RPD_EXHAUSTED,
		]) {
			expect(isTransientNetworkError(msg)).toBe(false);
		}
	});
});

// ---- parseTrace tests ----

describe("parseTrace", () => {
	it("returns empty defaults when trace file does not exist", () => {
		const result = parseTrace(join(tmpTraceDir, "nonexistent.jsonl"), {}, 0);
		expect(result.text).toBe("");
		expect(result.sessionID).toBeNull();
		expect(result.sawError).toBe(false);
		expect(result.costUsd).toBe(0);
		expect(result.tokens.input).toBe(0);
	});

	it("accumulates text from multiple text events", () => {
		const tracePath = writeTrace(
			"trace1.jsonl",
			[
				JSON.stringify({ t: "text", part: { text: "Hello " } }),
				JSON.stringify({ t: "text", part: { text: "World" } }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.text).toBe("Hello World");
	});

	it("extracts sessionID from the first init event that has one", () => {
		const tracePath = writeTrace(
			"trace2.jsonl",
			[
				JSON.stringify({ t: "text", part: { text: "hi" } }),
				JSON.stringify({ t: "init", role: "coder", sessionId: "sess-1" }),
				JSON.stringify({ t: "init", role: "coder", sessionId: "sess-2" }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.sessionID).toBe("sess-1");
	});

	it("extracts the model from the first init event that has one", () => {
		const tracePath = writeTrace(
			"trace11.jsonl",
			[
				JSON.stringify({
					t: "init",
					role: "coder",
					model: "qwen2.5-coder:7b",
					sessionId: "sess-m",
				}),
				JSON.stringify({
					t: "init",
					role: "coder",
					model: "other-model",
					sessionId: "sess-m2",
				}),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.model).toBe("qwen2.5-coder:7b");
	});

	it("sums tokens from step_finish usage events and tracks cached separately", () => {
		const tracePath = writeTrace(
			"trace3.jsonl",
			[
				JSON.stringify({
					t: "step_finish",
					usage: {
						input: 10,
						output: 5,
						reasoning: 2,
						cached: 100,
						cacheWrite: 0,
						total: 117,
					},
					costUsd: 0.01,
				}),
				JSON.stringify({
					t: "step_finish",
					usage: {
						input: 20,
						output: 8,
						reasoning: 0,
						cached: 50,
						cacheWrite: 0,
						total: 78,
					},
					costUsd: 0.02,
				}),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.tokens.input).toBe(30);
		expect(result.tokens.output).toBe(13);
		expect(result.tokens.reasoning).toBe(2);
		expect(result.tokens.cached).toBe(150);
		expect(result.tokens.cacheWrite).toBe(0);
		expect(result.tokens.total).toBe(195);
		expect(result.costUsd).toBeCloseTo(0.03, 10);
	});

	it("handles missing/empty usage gracefully (defaults to 0)", () => {
		const tracePath = writeTrace(
			"trace4.jsonl",
			[
				JSON.stringify({ t: "step_finish" }),
				JSON.stringify({ t: "step_finish", usage: undefined }),
				JSON.stringify({ t: "step_finish", usage: {} }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.tokens.input).toBe(0);
		expect(result.costUsd).toBe(0);
	});

	it("ignores tool_call/tool_result events for text and error state", () => {
		const tracePath = writeTrace(
			"trace6.jsonl",
			[
				JSON.stringify({ t: "tool_call", name: "bash", input: "ls -la" }),
				JSON.stringify({
					t: "tool_result",
					name: "bash",
					ok: true,
					ms: 12,
					bytesOut: 4096,
				}),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.text).toBe("");
		expect(result.sawError).toBe(false);
		expect(result.errorMsg).toBeUndefined();
	});

	it("detects error events and keeps the last error message", () => {
		const tracePath = writeTrace(
			"trace5.jsonl",
			[
				JSON.stringify({ t: "text", part: { text: "partial work" } }),
				JSON.stringify({ t: "error", error: "Something went wrong" }),
				JSON.stringify({ t: "error", error: "Final failure" }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.sawError).toBe(true);
		expect(result.errorMsg).toBe("Final failure");
	});

	it("coerces object error payloads to a JSON string", () => {
		const tracePath = writeTrace(
			"trace12.jsonl",
			[JSON.stringify({ t: "error", error: { message: "x" } })].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.sawError).toBe(true);
		expect(typeof result.errorMsg).toBe("string");
		expect(result.errorMsg).toBe('{"message":"x"}');
	});

	it("skips non-JSON lines (noise)", () => {
		const tracePath = writeTrace(
			"trace7.jsonl",
			[
				"Some log noise\n",
				JSON.stringify({ t: "text", part: { text: "valid" } }),
				"Another noise line\n",
				JSON.stringify({ t: "text", part: { text: " text" } }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.text).toBe("valid text");
	});

	it("only consumes the t-keyed wire schema and ignores legacy type-keyed lines", () => {
		const tracePath = writeTrace(
			"trace10.jsonl",
			[
				JSON.stringify({ type: "text", part: { text: "legacy" } }),
				JSON.stringify({ type: "init", sessionId: "legacy-sess" }),
				JSON.stringify({ t: "text", part: { text: "current" } }),
				JSON.stringify({ t: "init", sessionId: "sess-current" }),
			].join("\n"),
		);
		const result = parseTrace(tracePath, {}, 0);
		expect(result.text).toBe("current");
		expect(result.sessionID).toBe("sess-current");
	});

	it("respects startOffset (only parses content after offset)", () => {
		const line1 = JSON.stringify({ t: "text", part: { text: "before" } });
		const line2 = JSON.stringify({ t: "text", part: { text: "after" } });
		const content = `${line1}\n${line2}\n`;
		const tracePath = writeTrace("trace8.jsonl", content);
		const result = parseTrace(tracePath, {}, line1.length + 1);
		expect(result.text).toBe("after");
	});

	it("handles empty trace file", () => {
		const tracePath = writeTrace("trace9.jsonl", "");
		const result = parseTrace(tracePath, {}, 0);
		expect(result.text).toBe("");
		expect(result.sawError).toBe(false);
	});
});

// ---- readStderrTail tests ----

describe("readStderrTail", () => {
	it("returns empty string when file does not exist", () => {
		expect(readStderrTail(join(tmpTraceDir, "nope.log"))).toBe("");
	});

	it("returns the last 400 characters trimmed", () => {
		const longMessage = `${"X".repeat(500)}tail`; // 504 chars total
		const path = writeTrace("stderr.log", longMessage);
		const result = readStderrTail(path);
		expect(result.length).toBe(400);
		// last 400 chars = 396 X's + "tail"
		expect(result).toBe(`${"X".repeat(396)}tail`);
	});

	it("trims trailing whitespace", () => {
		const path = writeTrace("stderr2.log", "some error   \n\n  ");
		const result = readStderrTail(path);
		expect(result).toBe("some error");
	});

	it("returns entire content if under 400 chars", () => {
		const path = writeTrace("stderr3.log", "short error");
		const result = readStderrTail(path);
		expect(result).toBe("short error");
	});
});
