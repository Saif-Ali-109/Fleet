// AT-7 acceptance: Context versioned; freshness explicit and honored.
// Coverage: FR-17 (agents never write), FR-18 (freshness explicit), FR-19
// (context_update with prevVersion), plus the C6 run-scoped seed-wiring seam.
// No real DB, no tokens — recording-pool mock mirrors contextStore/Retrieval tests.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../../types.ts";
import { computeContextHash } from "../context.ts";
import type {
	ContextDoc,
	ContextReadResult,
	ContextCategory,
} from "../context.ts";
import { putContext } from "../contextStore.ts";
import type { PutContextInput, PutContextResult } from "../contextStore.ts";
import { getContext } from "../contextRetrieval.ts";
import { seedRunContext } from "../contextSeed.ts";

const TEST_KEY = "test-signing-key-for-context-acceptance";
let savedKey: string | undefined;
let savedKeyId: string | undefined;
let savedKeyV1: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyId = process.env.SOR_KEY_ID;
	savedKeyV1 = process.env.SOR_KEY_V1;
	process.env.SOR_SIGNING_KEY = TEST_KEY;
	process.env.SOR_KEY_V1 = TEST_KEY;
	process.env.SOR_KEY_ID = "v1";
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedKey === undefined) {
		delete process.env.SOR_SIGNING_KEY;
	} else {
		process.env.SOR_SIGNING_KEY = savedKey;
	}
	if (savedKeyId === undefined) {
		delete process.env.SOR_KEY_ID;
	} else {
		process.env.SOR_KEY_ID = savedKeyId;
	}
	if (savedKeyV1 === undefined) {
		delete process.env.SOR_KEY_V1;
	} else {
		process.env.SOR_KEY_V1 = savedKeyV1;
	}
});

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function recordingClient(
	rows: unknown[][],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failOnQuery?: string },
) {
	let queryIndex = 0;
	return {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);

			if (
				options?.shouldFail &&
				options.failOnQuery &&
				q.text.includes(options.failOnQuery)
			) {
				throw new Error(`forced failure on ${options.failOnQuery}`);
			}

			// Return chain row for FOR UPDATE query (sor_chain lookup)
			if (q.text.includes("FOR UPDATE")) {
				return { rows: [{ seq: "0", hash: "genesis-hash", key_id: "v1" }] };
			}

			const result = rows[queryIndex] ?? [];
			queryIndex++;
			return { rows: result };
		},
		release: () => {},
	};
}

function recordingPool(
	rows: unknown[][],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failOnQuery?: string },
): Pool {
	const client = recordingClient(rows, recorded, options);
	return {
		query: client.query,
		connect: async () => client,
	} as unknown as Pool;
}

function fakeRunCtx(overrides: Partial<RunContext> = {}): RunContext {
	return {
		runId: "run-abc-123",
		issue: {
			repo: "org/repo",
			number: 7,
			title: "T",
			body: "B",
			url: "https://github.com/org/repo/issues/7",
			state: "open",
			labels: [],
			author: "user",
		},
		repoUrl: "https://github.com/org/repo.git",
		rootDir: "/tmp/root",
		runDir: "/tmp/root/.runs/run-abc-123",
		worktreeDir: "/tmp/root/.runs/run-abc-123/worktree",
		tracesDir: "/tmp/root/.runs/run-abc-123/traces",
		branch: "fix-issue-7",
		dryRun: false,
		provider: "gemini",
		...overrides,
	};
}

describe("AT-7 — FR-17: agents never write", () => {
	it("putContext actor:'agent' ⇒ {ok:false,'agents cannot write context'} with ZERO DB writes", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const result: PutContextResult = await putContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
			state: { status: "provisioning" },
			actor: "agent",
		});
		expect(result).toEqual({ ok: false, reason: "agents cannot write context" });
		expect(recorded).toHaveLength(0);
	});

	it("manager write succeeds (context_sor + context_update emitted)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[]], recorded);
		const result: PutContextResult = await putContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
			state: { status: "provisioning" },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});
		expect(result).toEqual({ ok: true, kind: "added", version: 1 });
		expect(recorded.some((q) => q.text.includes("INSERT INTO context_sor"))).toBe(true);
		expect(recorded.some((q) => q.text.includes("INSERT INTO audit_events"))).toBe(true);
	});
});

describe("AT-7 — FR-18: freshness explicit (getContext/contextFreshness)", () => {
	it("within-TTL row ⇒ fresh:true with state + staleAfter", async () => {
		const recorded: RecordedQuery[] = [];
		const freshStamp = new Date(Date.now() + 60_000).toISOString();
		const pool = recordingPool(
			[
				[
					{
						source_id: "fleet|run|run-abc-123",
						category: "run",
						version: 1,
						hash: "h",
						operational_state: { runId: "run-abc-123" },
						fresh_until: freshStamp,
						stale_after: freshStamp,
						status: "active",
						created_at: new Date(Date.now() - 60_000).toISOString(),
					},
				],
			],
			recorded,
		);
		const res: ContextReadResult = await getContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.state).toEqual({ runId: "run-abc-123" });
		expect(res.item.fresh).toBe(true);
		expect(res.item.staleAfter).toBeTruthy();
	});

	it("past-TTL row ⇒ fresh:false (non-authoritative beyond TTL)", async () => {
		const recorded: RecordedQuery[] = [];
		const past = new Date(Date.now() - 60_000).toISOString();
		const pool = recordingPool(
			[
				[
					{
						source_id: "fleet|run|run-abc-123",
						category: "run",
						version: 1,
						hash: "h",
						operational_state: { runId: "run-abc-123" },
						fresh_until: past,
						stale_after: past,
						status: "active",
						created_at: new Date(Date.now() - 3600_000).toISOString(),
					},
				],
			],
			recorded,
		);
		const res: ContextReadResult = await getContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.item.fresh).toBe(false);
		expect(res.item.staleAfter).toBeTruthy();
	});
});

describe("AT-7 — FR-19: context_update carries prevVersion", () => {
	it("added write emits context_update with prevVersion:0", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[]], recorded);
		await putContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
			state: { runId: "run-abc-123" },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.sorType).toBe("context");
		expect(payload.prevVersion).toBe(0);
	});

	it("update write emits context_update with prevVersion = prior version", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(
			[[{ version: 2, hash: "old-hash" }]],
			recorded,
		);
		await putContext(pool, {
			sourceId: "fleet|run|run-abc-123",
			category: "run",
			state: { runId: "run-abc-123", status: "active" },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.version).toBe(3);
		expect(payload.prevVersion).toBe(2);
	});

	it("NON-FATAL: forced audit failure ⇒ warns + continues, no throw", async () => {
		const recorded: RecordedQuery[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pool = recordingPool([[]], recorded, {
			shouldFail: true,
			failOnQuery: "INSERT INTO audit_events",
		});
		await expect(
			putContext(pool, {
				sourceId: "fleet|run|run-abc-123",
				category: "run",
				state: { runId: "run-abc-123" },
				actor: "manager",
				now: "2024-01-01T00:00:00.000Z",
			}),
		).resolves.toEqual({ ok: true, kind: "added", version: 1 });
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("C6 — run-scoped seed wiring seam (seedRunContext)", () => {
	it("seeds putContext with category:'run', sourceId fleet|run|<runId>, actor:'manager', and emits context_update for the run sourceId", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[]], recorded);
		const ctx = fakeRunCtx();

		await seedRunContext(pool, ctx);

		// putContext was invoked → context_sor INSERT with run sourceId/category
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeDefined();
		expect(insertSor?.values?.[0]).toBe("fleet|run|run-abc-123");
		expect(insertSor?.values?.[5] as string).toContain("run-abc-123");
		// audit context_update carries the run sourceId
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.sourceId).toBe("fleet|run|run-abc-123");
		expect(payload.sorType).toBe("context");
	});

	it("state object mirrors RunContext operational fields", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[]], recorded);
		const ctx = fakeRunCtx({ provider: "openrouter" });
		await seedRunContext(pool, ctx);

		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeDefined();
		const state = JSON.parse(insertSor?.values?.[5] as string) as Record<string, unknown>;
		expect(state.runId).toBe("run-abc-123");
		expect(state.repoUrl).toBe("https://github.com/org/repo.git");
		expect(state.branch).toBe("fix-issue-7");
		expect(state.worktreeDir).toBe("/tmp/root/.runs/run-abc-123/worktree");
		expect(state.dryRun).toBe(false);
		expect(state.provider).toBe("openrouter");
	});

	it("dryRun ctx ⇒ NO DB write (seed skipped entirely)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const ctx = fakeRunCtx({ dryRun: true });
		await seedRunContext(pool, ctx);
		expect(recorded).toHaveLength(0);
	});

	it("NON-FATAL: putContext failure warns + continues, no throw", async () => {
		const recorded: RecordedQuery[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Force failure on the context_sor INSERT inside putContext
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failOnQuery: "INSERT INTO context_sor",
		});
		const ctx = fakeRunCtx();
		await expect(seedRunContext(pool, ctx)).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

// ---- Type-level structural compatibility (FR-17/18/19 contract, typecheck covers) ----

/** C2 ContextDoc fixture. */
const contextDocFixture: ContextDoc = {
	sorType: "context",
	sourceId: "fleet|run|run-abc-123",
	namespace: "fleet",
	version: 1,
	hash: computeContextHash({ runId: "run-abc-123" }),
	category: "run" as ContextCategory,
	state: { runId: "run-abc-123" },
	status: "active",
};

/** C3 putContext input fixture. */
const putInputFixture: PutContextInput = {
	sourceId: "fleet|run|run-abc-123",
	category: "run",
	state: { runId: "run-abc-123" },
	actor: "manager",
	version: 1,
	now: "2024-01-01T00:00:00.000Z",
};

describe("type-level structural compatibility (compile-time fixtures)", () => {
	it("ContextDoc / PutContextInput / ContextReadResult are structurally assignable", () => {
		// Guard the fixtures are well-typed by referencing them; assertions are
		// runtime no-ops but the important check is that the file typechecks.
		expect(contextDocFixture.sorType).toBe("context");
		expect(putInputFixture.sourceId).toBe(contextDocFixture.sourceId);
		expect(contextDocFixture.category).toBe(putInputFixture.category);

		const readResult: ContextReadResult = {
			ok: true,
			item: {
				state: contextDocFixture.state,
				fresh: false,
				staleAfter: "2099-01-01T00:00:00.000Z",
				version: contextDocFixture.version,
			},
		};
		expect(readResult.ok).toBe(true);
		if (readResult.ok) {
			expect(readResult.item.state).toEqual({ runId: "run-abc-123" });
		}
	});
});
