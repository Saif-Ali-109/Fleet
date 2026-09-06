import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent, ensureChain } from "../../db/audit.ts";
import type { SorEvent, SorEventType } from "../events.ts";
import { VALID_TYPES } from "../events.ts";
import { runSorVerify } from "../verify.ts";

const SIGNING_KEY = "at9-test-signing-key";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

interface AuditRow {
	run_id: string | null;
	seq: string;
	event_type: string;
	actor: string;
	backend: string | null;
	tool_name: string | null;
	tool_input: unknown;
	tool_output: unknown;
	payload: Record<string, unknown>;
	prev_hash: string;
	hash: string;
	key_id: string;
	created_at: Date;
}

/** Doubles as pool + client. Records every audit_events INSERT; the mock tail
 *  advances on each UPDATE sor_chain so prev_hash chaining is real. Both real
 *  appendAuditEvent and verifyChain run end-to-end against this pool. */
interface ChainingPoolResult {
	pool: Pool;
	events: AuditRow[];
}

function chainingPool(): ChainingPoolResult {
	const events: AuditRow[] = [];
	let tail: { seq: string; hash: string; key_id: string } = {
		seq: "0",
		hash: "6d756c74692d6f726368657374726174696f6e2d736f722d67656e65736973",
		key_id: "v1",
	};
	const captured: RecordedQuery[] = [];

	const clientQuery = async (...args: unknown[]) => {
		const q: RecordedQuery =
			typeof args[0] === "string"
				? { text: args[0], values: args[1] as unknown[] | undefined }
				: (args[0] as RecordedQuery);
		captured.push(q);
		if (
			q.text.startsWith("BEGIN") ||
			q.text.startsWith("COMMIT") ||
			q.text.startsWith("ROLLBACK")
		) {
			return { rows: [] };
		}
		if (q.text.includes("FOR UPDATE")) {
			return { rows: [{ ...tail }] };
		}
		if (q.text.includes("INSERT INTO audit_events")) {
			const v = q.values ?? [];
			events.push({
				run_id: v[0] as string | null,
				seq: String(v[1]),
				event_type: String(v[2]),
				actor: String(v[3]),
				backend: v[4] as string | null,
				tool_name: v[5] as string | null,
				tool_input: v[6],
				tool_output: v[7],
				payload: (v[8] ?? {}) as Record<string, unknown>,
				prev_hash: String(v[9]),
				hash: String(v[10]),
				key_id: String(v[11]),
				created_at: new Date(String(v[12])),
			});
			return { rows: [] };
		}
		if (q.text.startsWith("UPDATE sor_chain")) {
			tail = {
				seq: String(q.values?.[0] ?? 0),
				hash: q.values?.[1] as string,
				key_id: q.values?.[2] as string,
			};
			return { rows: [] };
		}
		return { rows: [] };
	};

	const client = { query: clientQuery, release: () => {} };

	const poolQuery = async (...args: unknown[]) => {
		const q: RecordedQuery =
			typeof args[0] === "string"
				? { text: args[0], values: args[1] as unknown[] | undefined }
				: (args[0] as RecordedQuery);
		captured.push(q);
		if (q.text.includes("INSERT INTO sor_chain")) {
			return { rows: [] };
		}
		if (q.text.includes("FROM audit_events")) {
			return {
				rows: events.slice().sort((a, b) => Number(a.seq) - Number(b.seq)),
			};
		}
		return { rows: [] };
	};

	const pool = {
		query: poolQuery,
		connect: async () => client,
	} as unknown as Pool;

	return { pool, events };
}

/** Minimal SorEvent for each of the 20 VALID_TYPES with type-appropriate payload markers. */
function eventForType(t: SorEventType): SorEvent {
	const base: SorEvent = {
		run_id: null,
		event_type: t,
		actor: "manager",
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		payload: {},
		created_at: new Date().toISOString(),
	};
	switch (t) {
		case "policy_state":
			return {
				...base,
				payload: {
					sorType: "policy",
					sourceId: "coder",
					namespace: "fleet",
					version: 1,
					hash: "phash",
					actor: "manager",
					ts: base.created_at,
					mode: "sor",
					policyVersion: 1,
					policyHash: "phash",
				},
			};
		case "policy_sync":
			return {
				...base,
				payload: {
					sorType: "policy",
					sourceId: "coder",
					namespace: "fleet",
					version: 1,
					hash: "phash",
					actor: "manager",
					ts: base.created_at,
					kind: "seeded",
				},
			};
		case "policy_decision":
			return {
				...base,
				payload: {
					sorType: "policy",
					sourceId: "coder",
					namespace: "fleet",
					version: 1,
					hash: "phash",
					actor: "manager",
					ts: base.created_at,
					decision: "allow",
				},
			};
		case "content_sync":
			return {
				...base,
				payload: {
					sorType: "content",
					sourceId: "doc-1",
					namespace: "fleet",
					version: 1,
					hash: "chash",
					actor: "manager",
					ts: base.created_at,
					kind: "added",
					status: "active",
				},
			};
		case "content_access":
			return {
				...base,
				payload: {
					sorType: "content",
					sourceId: "doc-1",
					namespace: "fleet",
					version: 1,
					hash: "chash",
					sessionId: "sess-1",
					mode: "aggregate",
					count: 3,
					topSources: [],
				},
			};
		case "context_update":
			return {
				...base,
				payload: {
					sorType: "context",
					sourceId: "ctx-1",
					namespace: "fleet",
					version: 1,
					hash: "xhash",
					prevVersion: 0,
				},
			};
		case "tool_call":
			return {
				...base,
				actor: "coder",
				backend: "gemini",
				tool_name: "read",
				tool_input: { filePath: "a.ts" },
				tool_output: { content: "ok" },
				payload: { phase: "implement" },
			};
		case "wakeup":
			return { ...base, actor: "system", payload: { kind: "session.idle" } };
		case "phase":
			return { ...base, payload: { phase: "plan" } };
		case "registry_sync":
			return { ...base, actor: "system", payload: { roles: ["coder"] } };
		case "finalize":
			return { ...base, payload: { status: "done" } };
		case "model_switch":
			return { ...base, actor: "system", payload: { from: "a", to: "b" } };
		case "model_recovered":
			return { ...base, actor: "system", payload: { model: "gemini" } };
		case "all_models_exhausted":
			return { ...base, actor: "system", payload: {} };
		case "run_paused":
			return { ...base, payload: { reason: "idle" } };
		case "run_resumed":
			return { ...base, payload: { reason: "manual" } };
		case "reservation":
			return {
				...base,
				actor: "coder",
				backend: "gemini",
				payload: { model: "gemini" },
			};
		case "reservation_rejection":
			return {
				...base,
				actor: "coder",
				backend: "gemini",
				payload: { reason: "quota" },
			};
		case "provider_completion":
			return {
				...base,
				actor: "coder",
				backend: "gemini",
				payload: { ok: true },
			};
		case "retry":
			return { ...base, actor: "system", payload: { attempt: 2 } };
	}
}

let savedKey: string | undefined;
let savedKeyId: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = SIGNING_KEY;
	process.env.SOR_KEY_V1 = SIGNING_KEY;
	process.env.SOR_KEY_ID = "v1";
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env.SOR_SIGNING_KEY;
		delete process.env.SOR_KEY_V1;
	} else {
		process.env.SOR_SIGNING_KEY = savedKey;
		process.env.SOR_KEY_V1 = savedKey;
	}
	if (savedKeyId === undefined) {
		delete process.env.SOR_KEY_ID;
	} else {
		process.env.SOR_KEY_ID = savedKeyId;
	}
});

describe("AT-9 — All 20 event types append and verify", () => {
	it("appends every VALID_TYPES type through real ensureChain+appendAuditEvent and verifyChain replays ok", async () => {
		const { pool, events } = chainingPool();
		await ensureChain(pool);

		for (const t of VALID_TYPES) {
			await appendAuditEvent(pool, eventForType(t));
		}

		expect(events.length).toBe(VALID_TYPES.length);
		for (const e of events) {
			expect(e.key_id).toBe("v1");
		}

		const result = await runSorVerify(pool);
		expect(result).toBe(0);
	});
});

describe("AT-9 — Cross-phase integrity", () => {
	it("chain has monotonic seq, all 20 types in counts, and nonzero counts for each phase group", async () => {
		const { pool, events } = chainingPool();
		await ensureChain(pool);

		for (const t of VALID_TYPES) {
			await appendAuditEvent(pool, eventForType(t));
		}

		for (let i = 1; i < events.length; i++) {
			const cur = events[i];
			const prev = events[i - 1];
			expect(cur).toBeDefined();
			expect(prev).toBeDefined();
			expect(Number(cur?.seq)).toBe(Number(prev?.seq) + 1);
		}
		for (const e of events) {
			expect(e.prev_hash).not.toBe(e.hash);
		}

		const policyTypes = ["policy_state", "policy_sync", "policy_decision"];
		const contentTypes = ["content_sync", "content_access"];
		const contextTypes = ["context_update"];

		const counts: Record<string, number> = {};
		for (const e of events) {
			counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
		}

		for (const t of VALID_TYPES) {
			expect(counts[t]).toBe(1);
		}
		for (const t of policyTypes) {
			expect(counts[t]).toBeGreaterThanOrEqual(1);
		}
		for (const t of contentTypes) {
			expect(counts[t]).toBeGreaterThanOrEqual(1);
		}
		for (const t of contextTypes) {
			expect(counts[t]).toBeGreaterThanOrEqual(1);
		}
	});
});

describe("AT-9 — runSorVerify agrees", () => {
	it("returns 0 for the clean 20-event chain", async () => {
		const { pool } = chainingPool();
		await ensureChain(pool);
		for (const t of VALID_TYPES) {
			await appendAuditEvent(pool, eventForType(t));
		}
		const code = await runSorVerify(pool);
		expect(code).toBe(0);
	});

	it("returns 1 when a recorded hash is tampered (corrupted chain)", async () => {
		const { pool, events } = chainingPool();
		await ensureChain(pool);
		for (const t of VALID_TYPES) {
			await appendAuditEvent(pool, eventForType(t));
		}

		expect(events.length).toBe(20);
		const target = events[10]!;
		target.hash = "tampered";

		const code = await runSorVerify(pool);
		expect(code).toBe(1);
	});
});

describe("AT-9 — Migration 013 ↔ VALID_TYPES lockstep", () => {
	it("VALID_TYPES has at least 20 entries and includes the six phase event types", () => {
		expect(VALID_TYPES.length).toBeGreaterThanOrEqual(20);
		for (const t of [
			"policy_state",
			"policy_sync",
			"policy_decision",
			"content_sync",
			"content_access",
			"context_update",
		]) {
			expect(VALID_TYPES).toContain(t);
		}
	});
});
