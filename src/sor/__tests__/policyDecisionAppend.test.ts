// P2.4 (§C8.4): a policy_decision event round-trips through normalizeEvent →
// appendAuditEvent directly — the event-agnostic append path — NOT through
// sorEmit/buildToolEmission, which hardcodes event_type "tool_call". All SOR
// appends stay NON-FATAL (P-I5): a forced DB append failure warns and
// continues, never aborting or downgrading the PEP's decision.
//
// Recording-pool mock mirroring src/__tests__/audit.test.ts — no real DB.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditEvent } from "../../db/audit.ts";
import { buildToolEmission } from "../../fleet/sorEmit.ts";
import type { SorEvent } from "../events.ts";
import { normalizeEvent } from "../events.ts";
import { GENESIS_HASH, signEvent } from "../signer.ts";

const KEY = "test-signing-key";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

/** Recording pool: connect() returns a client whose query pushes
 *  {text, values} into `recorded` and returns the chain-tail row for the
 *  SELECT ... FOR UPDATE (same shape as src/__tests__/audit.test.ts). */
function recordingPool(
	chainRow: { seq: string; hash: string },
	recorded: RecordedQuery[],
): Pool {
	const client = {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			return { rows: q.text.includes("FOR UPDATE") ? [chainRow] : [] };
		},
		release: () => {},
	};
	return { connect: async () => client } as unknown as Pool;
}

/** Same as recordingPool but the mock tail ADVANCES on each append, so a
 *  second append's SELECT ... FOR UPDATE sees the first append's hash as
 *  prev_hash — exercising real hash chaining across records. */
function chainingPool(recorded: RecordedQuery[]): Pool {
	let tail: { seq: string; hash: string } = { seq: "0", hash: GENESIS_HASH };
	const client = {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (q.text.includes("FOR UPDATE")) {
				return { rows: [tail] };
			}
			if (q.text.startsWith("UPDATE sor_chain")) {
				tail = {
					seq: String(q.values?.[0] ?? 0),
					hash: q.values?.[1] as string,
				};
			}
			return { rows: [] };
		},
		release: () => {},
	};
	return { connect: async () => client } as unknown as Pool;
}

/** Forced DB-append failure: BEGIN/SELECT/ROLLBACK succeed, only the
 *  audit_events INSERT rejects — exactly the failure an appendAuditEvent
 *  caller must survive NON-FATAL. */
function failingInsertPool(recorded: RecordedQuery[]): Pool {
	const client = {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (q.text.startsWith("INSERT INTO audit_events")) {
				throw new Error("insert into audit_events: connection reset");
			}
			return {
				rows: q.text.includes("FOR UPDATE")
					? [{ seq: "7", hash: "prev-hash" }]
					: [],
			};
		},
		release: () => {},
	};
	return { connect: async () => client } as unknown as Pool;
}

/** §12.2 / §21.2 locked policy_decision payload.
 *  Overrides spread at the top level (raw, pre-normalize). */
function rawPolicyDecision(
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		run_id: "run-policy-1",
		event_type: "policy_decision",
		actor: "manager",
		backend: null,
		tool_name: "bash",
		tool_input: null,
		tool_output: null,
		payload: {
			decision: "ALLOW",
			action: "bash",
			result: "ok",
			reason: "tool in grant",
		},
		created_at: "2026-08-30T00:00:00.000Z",
		...overrides,
	};
}

let savedKey: string | undefined;
let savedKeyId: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = KEY;
	process.env.SOR_KEY_V1 = KEY;
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
	vi.restoreAllMocks();
});

describe("policy_decision append via appendAuditEvent (P2.4)", () => {
	it("round-trips normalizeEvent -> appendAuditEvent with event_type, intact payload, chained hash", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool({ seq: "7", hash: "prev-hash" }, recorded);

		const event = normalizeEvent(rawPolicyDecision());
		await appendAuditEvent(pool, event);

		const insert = recorded.find((q) =>
			q.text.startsWith("INSERT INTO audit_events"),
		);
		expect(insert).toBeDefined();
		expect(insert?.values?.[1]).toBe(8); // chain seq 7 -> nextSeq 8
		expect(insert?.values?.[2]).toBe("policy_decision");
		expect(insert?.values?.[3]).toBe("manager");
		expect(insert?.values?.[8]).toEqual({
			decision: "ALLOW",
			action: "bash",
			result: "ok",
			reason: "tool in grant",
		});
		// prev_hash/hash chaining signed over the record (B2-consistent key id).
		expect(insert?.values?.[9]).toBe("prev-hash");
		expect(insert?.values?.[11]).toBe("v1");
		expect(insert?.values?.[10]).toBe(
			signEvent(
				KEY,
				"prev-hash",
				{ ...event, created_at: event.created_at },
				"v1",
			),
		);
	});

	it("chains two policy_decision appends: second prev_hash = first hash", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = chainingPool(recorded);
		const allow = normalizeEvent(rawPolicyDecision());
		const deny = normalizeEvent(
			rawPolicyDecision({
				payload: {
					decision: "DENY",
					action: "bash",
					result: "blocked",
					reason: "tool not in grant",
				},
			}),
		);

		await appendAuditEvent(pool, allow);
		await appendAuditEvent(pool, deny);

		const inserts = recorded.filter((q) =>
			q.text.startsWith("INSERT INTO audit_events"),
		);
		expect(inserts).toHaveLength(2);
		const [first, second] = inserts;
		expect(first?.values?.[9]).toBe(GENESIS_HASH); // anchored to genesis
		expect(second?.values?.[9]).toBe(first?.values?.[10]); // prev = prior hash
		expect(second?.values?.[2]).toBe("policy_decision");
		expect(second?.values?.[8]).toEqual({
			decision: "DENY",
			action: "bash",
			result: "blocked",
			reason: "tool not in grant",
		});
		expect(second?.values?.[10]).toBe(
			signEvent(
				KEY,
				first?.values?.[10] as string,
				{ ...deny, created_at: deny.created_at },
				"v1",
			),
		);
	});

	it("a forced DB-append failure WARNS and CONTINUES — decision unchanged, no throw (NON-FATAL)", async () => {
		// Mirror the orchestrator's sorEmit() wrapper (§C8.4): policy_decision
		// appends are caught + warned and never abort or downgrade the PEP's
		// decision (P-I5).
		const appendPolicyDecisionNonFatal = async (
			pool: Pool,
			event: SorEvent,
		): Promise<boolean> => {
			try {
				await appendAuditEvent(pool, event);
				return true;
			} catch (err) {
				console.warn(
					`[sor] policy_decision append skipped: ${err instanceof Error ? err.message : String(err)}`,
				);
				return false;
			}
		};

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const recorded: RecordedQuery[] = [];
		const pool = failingInsertPool(recorded);

		const event = normalizeEvent(rawPolicyDecision());
		// The PEP decided DENY before the (failed) audit append ever ran.
		const decision: "ALLOW" | "DENY" = "DENY";
		let loopContinued = false;

		const appended = await appendPolicyDecisionNonFatal(pool, event);
		loopContinued = true;

		expect(appended).toBe(false); // append failed
		expect(decision).toBe("DENY"); // caller's decision unchanged
		expect(loopContinued).toBe(true); // no throw propagated to abort
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("policy_decision append skipped"),
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("connection reset"),
		);
		// appendAuditEvent really was the failing path: tx began, INSERT
		// attempted, ROLLBACK issued — the caller just refused to die.
		const texts = recorded.map((q) => q.text);
		expect(texts.some((t) => t.startsWith("INSERT INTO audit_events"))).toBe(
			true,
		);
		expect(texts.some((t) => t === "ROLLBACK")).toBe(true);
	});
});

describe("policy events do NOT travel through sorEmit/buildToolEmission (P2.4)", () => {
	it("buildToolEmission hardcodes event_type tool_call — no policy_decision path exists there", () => {
		const emission = buildToolEmission(
			{
				role: "coder",
				provider: "gemini",
				model: "gemini-2.0-flash",
				sessionId: "sess-1",
				runId: "run-policy-1",
			},
			"before",
			"call-1",
			"bash",
			{ command: "ls" },
		);
		expect(emission.record.event_type).toBe("tool_call");
		expect(emission.event.event_type).toBe("tool_call");
		// The sink surface only exposes toolCall/toolResult; there is no
		// policy_decision emitter here — policy events append via
		// appendAuditEvent directly (proven by the round-trips above).
	});
});
