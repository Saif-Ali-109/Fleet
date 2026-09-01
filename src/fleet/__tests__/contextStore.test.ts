import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putContext, emitContextUpdateNonFatal } from "../contextStore.ts";

const TEST_KEY = "test-signing-key-for-context-store";
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
	shouldFail = false,
	failOnQuery?: string,
) {
	let queryIndex = 0;
	return {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);

			if (shouldFail && failOnQuery && q.text.includes(failOnQuery)) {
				throw new Error(`forced failure on ${failOnQuery}`);
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
	shouldFail = false,
	failOnQuery?: string,
): Pool {
	const client = recordingClient(rows, recorded, shouldFail, failOnQuery);
	return {
		query: client.query,
		connect: async () => client,
	} as unknown as Pool;
}

describe("putContext — context store controlled write path", () => {
	it("added: no prior row ⇒ inserts context_sor + emits context_update prevVersion:0", async () => {
		const recorded: RecordedQuery[] = [];
		// No prior row for this sourceId
		const pool = recordingPool([[]], recorded);

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state: { status: "provisioning" },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});

		expect(result).toEqual({ ok: true, kind: "added", version: 1 });

		// Insert into context_sor
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeDefined();
		expect(insertSor?.values?.[0]).toBe("fleet|context|run-1");
		expect(insertSor?.values?.[1]).toBe("fleet");
		expect(insertSor?.values?.[2]).toBe(1);
		expect(typeof insertSor?.values?.[3]).toBe("string"); // hash
		expect(insertSor?.values?.[4]).toBe("run");
		expect(insertSor?.values?.[5]).toBe(
			JSON.stringify({ status: "provisioning" }),
		);
		expect(insertSor?.values?.[6]).toBe("2024-01-01T00:00:00.000Z"); // fresh_until
		expect(insertSor?.values?.[8]).toBe("active");

		// audit emit with prevVersion 0
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.sorType).toBe("context");
		expect(payload.sourceId).toBe("fleet|context|run-1");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(1);
		expect(payload.actor).toBe("manager");
		expect(payload.prevVersion).toBe(0);
		expect(typeof payload.ts).toBe("string");
	});

	it("updated: hash changed ⇒ bumps to prev+1, inserts new row, emits context_update with prevVersion", async () => {
		const recorded: RecordedQuery[] = [];
		// Prior row v2 with a different hash
		const pool = recordingPool(
			[[{ version: 2, hash: "old-hash" }]],
			recorded,
		);

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "org-constraints",
			state: { constraints: ["a", "b"] },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});

		expect(result).toEqual({ ok: true, kind: "updated", version: 3 });

		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeDefined();
		expect(insertSor?.values?.[2]).toBe(3);

		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.version).toBe(3);
		expect(payload.prevVersion).toBe(2);
	});

	it("unchanged: same hash ⇒ NO write, emits context_update prevVersion:prev.version, returns unchanged", async () => {
		const recorded: RecordedQuery[] = [];
		const state = { mode: "active" };
		const priorHash = (await import("../context.ts")).computeContextHash(state);
		const pool = recordingPool(
			[[{ version: 2, hash: priorHash }]],
			recorded,
		);

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state,
			actor: "manager",
		});

		expect(result).toEqual({ ok: true, kind: "unchanged", version: 2 });

		// No insert into context_sor (the only audit-append BEGIN below is the
		// NON-FATAL context_update chain tx, not a context_sor write)
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeUndefined();

		// But context_update event IS emitted with prevVersion 2
		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.version).toBe(2);
		expect(payload.prevVersion).toBe(2);
	});

	it("agent rejected: actor:'agent' ⇒ {ok:false, reason} and ZERO queries issued", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state: { status: "provisioning" },
			actor: "agent",
		});

		expect(result).toEqual({
			ok: false,
			reason: "agents cannot write context",
		});
		expect(recorded).toHaveLength(0);
	});

	it("NON-FATAL: forced audit-append failure ⇒ warns + continues, no throw", async () => {
		const recorded: RecordedQuery[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Force failure on audit_events insert only
		const pool = recordingPool([[]], recorded, true, "INSERT INTO audit_events");

		// Should not throw
		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state: { status: "provisioning" },
			actor: "manager",
			now: "2024-01-01T00:00:00.000Z",
		});

		expect(result).toEqual({ ok: true, kind: "added", version: 1 });
		// The context_sor row was still written
		const insertSor = recorded.find((q) =>
			q.text.includes("INSERT INTO context_sor"),
		);
		expect(insertSor).toBeDefined();
		// warn was called
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("malformed state (undefined) ⇒ rejected {ok:false, reason} BEFORE any DB write", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state: undefined,
			actor: "manager",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.reason).toContain("malformed context state");
		expect(recorded).toHaveLength(0);
	});

	it("malformed state (circular) ⇒ rejected {ok:false, reason} BEFORE any DB write", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const result = await putContext(pool, {
			sourceId: "fleet|context|run-1",
			category: "run",
			state: circular,
			actor: "manager",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.reason).toContain("malformed context state");
		expect(recorded).toHaveLength(0);
	});
});

describe("emitContextUpdateNonFatal — NON-FATAL helper", () => {
	it("wraps appendAuditEvent in try/catch, warns on failure, never throws", async () => {
		const recorded: RecordedQuery[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pool = recordingPool(
			[[{ seq: "0", hash: "genesis" }]],
			recorded,
			true,
			"INSERT INTO audit_events",
		);

		await expect(
			emitContextUpdateNonFatal(pool, {
				sourceId: "fleet|context|run-1",
				version: 1,
				hash: "some-hash",
				prevVersion: 0,
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("on success, appends context_update event with correct payload shape", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([[{ seq: "0", hash: "genesis" }]], recorded);

		await emitContextUpdateNonFatal(pool, {
			sourceId: "fleet|context|run-1",
			version: 4,
			hash: "abc",
			prevVersion: 3,
		});

		const insertAudit = recorded.find((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(insertAudit).toBeDefined();
		const payload = insertAudit?.values?.[8] as Record<string, unknown>;
		expect(payload.sorType).toBe("context");
		expect(payload.sourceId).toBe("fleet|context|run-1");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(4);
		expect(payload.hash).toBe("abc");
		expect(payload.actor).toBe("manager");
		expect(payload.prevVersion).toBe(3);
		expect(typeof payload.ts).toBe("string");
	});
});
