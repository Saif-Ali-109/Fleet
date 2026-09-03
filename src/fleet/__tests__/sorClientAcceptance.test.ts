// Phase 5 §13/§14 acceptance — unified agent surface through M1's sorClient.
//
//   AT (§13): one `SorClient` object exposes retrieve knowledge / retrieve context /
//       evaluate policy / record provenance, each delegating to the REAL domain
//       services (contentRetrieval, contextRetrieval, policyEval, and the §12.2
//       NON-FATAL emitters). Only the recording-pool fake is mocked.
//
//   AT (§14): no universal fallback — each operation returns the domain-native
//       result union unchanged (no-match ≠ unavailable; not-found ≠ unavailable;
//       deny stays deny regardless of other domains).
//
// Pattern A: recording-pool fake (per sorClient.test.ts / contentRetrieval.test.ts).
// The real §12.2 emitters run end-to-end against the recording pool; the pool's
// client captures the actual SorEvent written by the real appendAuditEvent
// (INSERT INTO audit_events) so every provenance topic is inspected at the point
// of persistence. Reads emit no audit events; evidence is the explicit
// recordProvenance op.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulePredicate } from "../../sor/kernel/types.ts";
import type { EffectiveToolSet } from "../policyEval.ts";
import { buildSorClient, type SorClient } from "../sorClient.ts";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

interface CapturedAudit {
	event_type: string;
	actor: string;
	payload: Record<string, unknown>;
}

interface RecordingPoolOptions {
	rows?: Record<string, unknown>[];
	rowsByQuery?: Record<string, Record<string, unknown>[]>;
	shouldFail?: boolean;
	failOnQuery?: string;
	chainRows?: Record<string, unknown>[];
}

/** Pattern-A recording pool. `pool.query` answers the injectable read rows;
 *  `pool.connect()` returns a client that answers the appendAuditEvent
 *  transaction — the FOR UPDATE sor_chain lookup returns the genesis chain row,
 *  every other statement returns `{rows:[]}`, and the real INSERT INTO
 *  audit_events (from the real appendAuditEvent) is captured into `auditEvents`.
 *  Both layers honour shouldFail / failOnQuery. */
function recordingPool(
	recorded: RecordedQuery[],
	auditEvents: CapturedAudit[],
	options: RecordingPoolOptions = {},
): Pool {
	const chainRows = options.chainRows ?? [
		{ seq: "0", hash: "genesis-hash", key_id: "v1" },
	];
	const fail = (text: string): boolean => {
		if (options.shouldFail) return true;
		if (
			options.failOnQuery !== undefined &&
			text.includes(options.failOnQuery)
		) {
			return true;
		}
		return false;
	};
	const readRows = (text: string): Record<string, unknown>[] => {
		if (options.rowsByQuery) {
			for (const key of Object.keys(options.rowsByQuery)) {
				if (text.includes(key)) return options.rowsByQuery[key]!;
			}
		}
		return options.rows ?? [];
	};
	const record = (...args: unknown[]): RecordedQuery => {
		const q: RecordedQuery =
			typeof args[0] === "string"
				? { text: args[0], values: args[1] as unknown[] | undefined }
				: (args[0] as RecordedQuery);
		recorded.push(q);
		return q;
	};
	const captureAuditInsert = (values: unknown[] | undefined): void => {
		if (!values || values.length < 13) return;
		const eventType = values[2];
		const actor = values[3];
		const payload = values[8];
		if (typeof eventType !== "string" || typeof actor !== "string") return;
		auditEvents.push({
			event_type: eventType,
			actor,
			payload: (payload as Record<string, unknown>) ?? {},
		});
	};
	const client = {
		query: async (...args: unknown[]) => {
			const q = record(...args);
			if (fail(q.text)) throw new Error("DB error");
			if (q.text.includes("INSERT INTO audit_events")) {
				captureAuditInsert(q.values);
			}
			if (q.text.includes("FOR UPDATE")) return { rows: chainRows };
			return { rows: [] };
		},
		release: () => {},
	};
	return {
		query: async (...args: unknown[]) => {
			const q = record(...args);
			if (fail(q.text)) throw new Error("DB error");
			return { rows: readRows(q.text) };
		},
		connect: async () => client,
	} as unknown as Pool;
}

let savedKey: string | undefined;
let savedKeyV1: string | undefined;
let savedKeyId: string | undefined;

let auditEvents: CapturedAudit[];

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyV1 = process.env.SOR_KEY_V1;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = "test-signing-key";
	process.env.SOR_KEY_V1 = "test-signing-key";
	process.env.SOR_KEY_ID = "v1";
	auditEvents = [];
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.SOR_SIGNING_KEY;
	else process.env.SOR_SIGNING_KEY = savedKey;
	if (savedKeyV1 === undefined) delete process.env.SOR_KEY_V1;
	else process.env.SOR_KEY_V1 = savedKeyV1;
	if (savedKeyId === undefined) delete process.env.SOR_KEY_ID;
	else process.env.SOR_KEY_ID = savedKeyId;
});

const hitRow = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	text: "grounded chunk",
	section: "Section One",
	chunk_index: 0,
	fts_rank: "0.8",
	source: "fleet",
	document: "guide",
	version: 1,
	content_hash: "dochash123",
	status: "active",
	...overrides,
});

function freshRow(past = false): Record<string, unknown> {
	const future = new Date(Date.now() + 60_000).toISOString();
	const pastStamp = new Date(Date.now() - 60_000).toISOString();
	return {
		source_id: "run:abc",
		category: "run",
		version: 3,
		hash: "abc123",
		operational_state: { mode: "auto" },
		fresh_until: past ? pastStamp : future,
		stale_after: past ? pastStamp : future,
		status: "active",
		created_at: new Date(Date.now() - 60_000).toISOString(),
	};
}

describe("AT — unified surface through ONE client (§13)", () => {
	it("exposes all four ops and each reaches the correct domain code", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rowsByQuery: {
				"FROM content_chunks cc": [hitRow()],
				"FROM context_sor": [freshRow()],
			},
		});
		const client: SorClient = buildSorClient(pool);

		expect(typeof client.retrieveKnowledge).toBe("function");
		expect(typeof client.retrieveContext).toBe("function");
		expect(typeof client.evaluatePolicy).toBe("function");
		expect(typeof client.recordProvenance).toBe("function");

		const knowledge = await client.retrieveKnowledge(pool, {
			query: "how do I",
		});
		expect(knowledge.ok).toBe(true);
		if (knowledge.ok && knowledge.kind === "hit") {
			expect(knowledge.items[0]!.provenance.content_hash).toBe("dochash123");
		}

		const context = await client.retrieveContext(pool, { category: "run" });
		expect(context.ok).toBe(true);
		if (context.ok) {
			expect(context.item.fresh).toBe(true);
			expect(context.item.state).toEqual({ mode: "auto" });
		}

		const decision = client.evaluatePolicy({
			toolName: "unknown-tool",
			input: {},
			effective: { allowedTools: [], mcpAllow: [] },
			rules: {},
		});
		expect(decision).toEqual({
			allowed: false,
			decision: "DENY",
			reason: "unknown tool: unknown-tool",
		});

		await client.recordProvenance(pool, {
			topic: "content-access",
			payload: {
				sessionId: "sess-1",
				mode: "aggregate",
				count: 1,
				topSources: ["fleet"],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		const accessEvent = auditEvents.find(
			(e) => e.event_type === "content_access",
		);
		expect(accessEvent).toBeDefined();
	});
});

describe("AT — knowledge semantics preserved (§13 grounding, FR-14)", () => {
	it("hit returns items with the exact provenance tuple", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [hitRow()] });

		const result = await buildSorClient(pool).retrieveKnowledge(pool, {
			query: "x",
		});

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items[0]?.provenance).toEqual({
				source: "fleet",
				document: "guide",
				section: "Section One",
				version: 1,
				content_hash: "dochash123",
			});
		}
	});

	it("zero-hit is a success-miss (no-match), distinct from unavailable", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [] });

		const result = await buildSorClient(pool).retrieveKnowledge(pool, {
			query: "nope",
		});

		expect(result).toEqual({ ok: true, kind: "no-match", query: "nope" });
	});

	it("DB failure is unavailable, distinct from no-match", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			failOnQuery: "content_chunks",
		});

		const result = await buildSorClient(pool).retrieveKnowledge(pool, {
			query: "x",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unavailable");
			expect(result.error).toBe("DB error");
		}
	});

	it("reads emit NO auto audit events (evidence is explicit via recordProvenance)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [hitRow()] });

		await buildSorClient(pool).retrieveKnowledge(pool, { query: "x" });

		expect(auditEvents).toHaveLength(0);
	});
});

describe("AT — context semantics preserved (§13 context, FR-18)", () => {
	it("fresh row within TTL → fresh:true with state, staleAfter, version", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [freshRow()] });

		const res = await buildSorClient(pool).retrieveContext(pool, {
			category: "run",
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.item.state).toEqual({ mode: "auto" });
			expect(res.item.fresh).toBe(true);
			expect(res.item.version).toBe(3);
			expect(res.item.staleAfter).toBeTruthy();
		}
	});

	it("past-TTL row → fresh:false (non-authoritative)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rows: [freshRow(true)],
		});

		const res = await buildSorClient(pool).retrieveContext(pool, {
			category: "run",
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.item.fresh).toBe(false);
			expect(res.item.state).toEqual({ mode: "auto" });
		}
	});

	it("missing row → not-found, distinct from unavailable", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [] });

		const res = await buildSorClient(pool).retrieveContext(pool, {
			category: "run",
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.kind).toBe("not-found");
		}
	});

	it("DB failure → unavailable", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			failOnQuery: "context_sor",
		});

		const res = await buildSorClient(pool).retrieveContext(pool, {
			category: "run",
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.kind).toBe("unavailable");
			expect(res.error).toBe("DB error");
		}
	});

	it("context value is returned with freshness, never conflated across kinds", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rows: [freshRow(true)],
		});

		const res = await buildSorClient(pool).retrieveContext(pool, {
			category: "run",
		});

		if (res.ok) {
			expect(res.item).toHaveProperty("state");
			expect(res.item).toHaveProperty("fresh", false);
			expect(res.item).toHaveProperty("staleAfter");
			expect(res.item).toHaveProperty("version");
			expect(Object.keys(res.item).sort()).toEqual(
				["fresh", "staleAfter", "state", "version"].sort(),
			);
		} else {
			throw new Error("expected a fresh-kind context read");
		}
	});
});

describe("AT — policy semantics preserved (§13 acting, fail-closed)", () => {
	const effective: EffectiveToolSet = {
		allowedTools: ["tool-a", "tool-b"],
		mcpAllow: ["mcp-tool-x"],
	};

	it("granted + rule-clean → ALLOW", () => {
		const recorded: RecordedQuery[] = [];
		const decision = buildSorClient(
			recordingPool(recorded, auditEvents),
		).evaluatePolicy({
			toolName: "tool-a",
			input: {},
			effective,
			rules: {},
		});

		expect(decision).toEqual({
			allowed: true,
			decision: "ALLOW",
			reason: "allowed",
		});
	});

	it("unknown tool → DENY (fail-closed)", () => {
		const recorded: RecordedQuery[] = [];
		const decision = buildSorClient(
			recordingPool(recorded, auditEvents),
		).evaluatePolicy({
			toolName: "tool-unknown",
			input: {},
			effective,
			rules: {},
		});

		expect(decision.allowed).toBe(false);
		expect(decision.decision).toBe("DENY");
		expect(decision.reason).toContain("unknown tool");
	});

	it("deny rule match → DENY", () => {
		const recorded: RecordedQuery[] = [];
		const rules: Record<string, RulePredicate[]> = {
			"tool-a": [
				{
					op: "deny",
					when: { path: "action", oneOf: ["delete"] },
					reason: "no deletes",
				},
			],
		};

		const decision = buildSorClient(
			recordingPool(recorded, auditEvents),
		).evaluatePolicy({
			toolName: "tool-a",
			input: { action: "delete" },
			effective,
			rules,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.decision).toBe("DENY");
		expect(decision.reason).toBe("no deletes");
	});

	it("unmet require → DENY", () => {
		const recorded: RecordedQuery[] = [];
		const rules: Record<string, RulePredicate[]> = {
			"tool-b": [
				{
					op: "require",
					when: { path: "approved", oneOf: [true] },
					reason: "approval required",
				},
			],
		};

		const decision = buildSorClient(
			recordingPool(recorded, auditEvents),
		).evaluatePolicy({
			toolName: "tool-b",
			input: { approved: false },
			effective,
			rules,
		});

		expect(decision.allowed).toBe(false);
		expect(decision.decision).toBe("DENY");
		expect(decision.reason).toBe("approval required");
	});

	it("policy deny stays a deny regardless of other domains (no universal fallback)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rowsByQuery: {
				"FROM content_chunks cc": [hitRow()],
				"FROM context_sor": [freshRow()],
			},
		});
		const client = buildSorClient(pool);

		const deny = client.evaluatePolicy({
			toolName: "tool-unknown",
			input: {},
			effective,
			rules: {},
		});

		// Other domains resolve successfully; the policy decision is unaffected.
		await client.retrieveKnowledge(pool, { query: "x" });
		await client.retrieveContext(pool, { category: "run" });

		expect(deny.allowed).toBe(false);
		expect(deny.decision).toBe("DENY");
		expect(deny.reason).toContain("unknown tool");
	});
});

describe("AT — provenance recording (§13 record / §12.2 contracts)", () => {
	it("content-access keeps {sorType,sourceId,namespace,version,hash,actor,ts}+mode/count/topSources", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents);

		await buildSorClient(pool).recordProvenance(pool, {
			topic: "content-access",
			payload: {
				sessionId: "sess-123",
				mode: "aggregate",
				count: 5,
				topSources: ["fleet", "external"],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		const event = auditEvents.find((e) => e.event_type === "content_access");
		expect(event).toBeDefined();
		const payload = event!.payload;
		expect(payload.sorType).toBe("content");
		expect(payload.sourceId).toBe("aggregate");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(1);
		expect(payload.hash).toBe("aggregate");
		expect(payload.actor).toBe("manager");
		expect(payload.sessionId).toBe("sess-123");
		expect(payload.mode).toBe("aggregate");
		expect(payload.count).toBe(5);
		expect(payload.topSources).toEqual(["fleet", "external"]);
		expect(typeof payload.ts).toBe("string");
	});

	it("content-sync keeps {sorType,sourceId,namespace,version,hash,actor,ts}+kind", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents);

		await buildSorClient(pool).recordProvenance(pool, {
			topic: "content-sync",
			payload: {
				kind: "added",
				status: "active",
				sourceId: "doc:1",
				version: 2,
			},
		});

		const event = auditEvents.find((e) => e.event_type === "content_sync");
		expect(event).toBeDefined();
		const payload = event!.payload;
		expect(payload.sorType).toBe("content");
		expect(payload.sourceId).toBe("doc:1");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(2);
		expect(payload.actor).toBe("manager");
		expect(payload.kind).toBe("added");
		expect(payload.status).toBe("active");
		expect(typeof payload.ts).toBe("string");
	});

	it("context-update keeps {sorType,sourceId,namespace,version,hash,actor,ts}+prevVersion", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents);

		await buildSorClient(pool).recordProvenance(pool, {
			topic: "context-update",
			payload: {
				sourceId: "run:abc",
				version: 3,
				hash: "hash123",
				prevVersion: 2,
			},
		});

		const event = auditEvents.find((e) => e.event_type === "context_update");
		expect(event).toBeDefined();
		const payload = event!.payload;
		expect(payload.sorType).toBe("context");
		expect(payload.sourceId).toBe("run:abc");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(3);
		expect(payload.hash).toBe("hash123");
		expect(payload.actor).toBe("manager");
		expect(payload.prevVersion).toBe(2);
		expect(typeof payload.ts).toBe("string");
	});

	it("policy-sync keeps {sorType,sourceId,namespace,version,hash,actor,ts}+kind/prevVersion/nextVersion/document", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents);

		const doc = {
			schemaVersion: 1 as const,
			meta: { subject_role: "coder" as const },
			allowedTools: ["tool-a"],
			mcpAllow: [],
			toolRules: {},
		};

		await buildSorClient(pool).recordProvenance(pool, {
			topic: "policy-sync",
			payload: {
				kind: "seeded",
				role: "coder",
				prevVersion: 0,
				nextVersion: 1,
				policyHash: "phash",
				document: doc,
			},
		});

		const event = auditEvents.find((e) => e.event_type === "policy_sync");
		expect(event).toBeDefined();
		const payload = event!.payload;
		expect(payload.sorType).toBe("policy");
		expect(payload.sourceId).toBe("coder");
		expect(payload.namespace).toBe("fleet");
		expect(payload.version).toBe(1);
		expect(payload.hash).toBe("phash");
		expect(payload.actor).toBe("manager");
		expect(payload.kind).toBe("seeded");
		expect(payload.prevVersion).toBe(0);
		expect(payload.document).toEqual(doc);
		expect(typeof payload.ts).toBe("string");
	});

	it("forced append failure → warn + continue, no throw (NON-FATAL end-to-end)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { shouldFail: true });
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = buildSorClient(pool);

		await expect(
			client.recordProvenance(pool, {
				topic: "content-sync",
				payload: {
					kind: "added",
					status: "active",
					sourceId: "doc:1",
					version: 1,
				},
			}),
		).resolves.toBeUndefined();
		await expect(
			client.recordProvenance(pool, {
				topic: "context-update",
				payload: { sourceId: "run:abc", version: 2, hash: "h", prevVersion: 1 },
			}),
		).resolves.toBeUndefined();
		await expect(
			client.recordProvenance(pool, {
				topic: "policy-sync",
				payload: {
					kind: "reconciled",
					role: "coder",
					prevVersion: 0,
					nextVersion: 1,
					policyHash: "ph",
				},
			}),
		).resolves.toBeUndefined();
		await client.recordProvenance(pool, {
			topic: "content-access",
			payload: {
				sessionId: "s1",
				mode: "aggregate",
				count: 1,
				topSources: ["fleet"],
			},
		});
		await new Promise((r) => setTimeout(r, 10));

		const warnings = consoleWarn.mock.calls.map((c) => String(c[0])).join("\n");
		expect(warnings).toContain("content_sync skipped");
		expect(warnings).toContain("context_update skipped");
		expect(warnings).toContain("policy_sync skipped");
		expect(warnings).toContain("content_access aggregate emit failed");

		consoleWarn.mockRestore();
	});
});

describe("AT — cross-domain composition (no regressions)", () => {
	it("chains retrieve → record provenance → evaluate → read context with shapes intact", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rowsByQuery: {
				"FROM content_chunks cc": [hitRow()],
				"FROM context_sor": [freshRow()],
			},
		});
		const client = buildSorClient(pool);

		// 1. Retrieve knowledge to ground the agent.
		const knowledge = await client.retrieveKnowledge(pool, {
			query: "how do I deploy",
		});
		expect(knowledge.ok).toBe(true);
		let knowledgeShape: unknown;
		if (knowledge.ok && knowledge.kind === "hit") {
			knowledgeShape = knowledge.items[0]?.provenance;
			expect(knowledgeShape).toEqual({
				source: "fleet",
				document: "guide",
				section: "Section One",
				version: 1,
				content_hash: "dochash123",
			});
		} else {
			throw new Error("expected a grounded hit");
		}

		// 2. Record its provenance explicitly (orthogonal to the read).
		await client.recordProvenance(pool, {
			topic: "content-access",
			payload: {
				sessionId: "sess-final",
				mode: "aggregate",
				count: 1,
				topSources: ["fleet"],
			},
		});
		await new Promise((r) => setTimeout(r, 10));
		const accessEvent = auditEvents.find(
			(e) => e.event_type === "content_access",
		);
		expect(accessEvent).toBeDefined();
		expect(accessEvent?.payload.sessionId).toBe("sess-final");

		// 3. Evaluate whether the agent may act on it (fail-closed on unknown tool).
		const policy = client.evaluatePolicy({
			toolName: "deploy-tool",
			input: { env: "prod" },
			effective: { allowedTools: ["read-tool"], mcpAllow: [] },
			rules: {},
		});
		expect(policy.allowed).toBe(false);
		expect(policy.decision).toBe("DENY");
		expect(policy.reason).toContain("unknown tool");

		// 4. Read context to check the situation (freshness honored).
		const context = await client.retrieveContext(pool, { category: "run" });
		expect(context.ok).toBe(true);
		if (context.ok) {
			expect(context.item.state).toEqual({ mode: "auto" });
			expect(context.item.fresh).toBe(true);
			expect(context.item.staleAfter).toBeTruthy();
		} else {
			throw new Error("expected a fresh-kind context read");
		}

		// Provenance shape from step 1 still intact — domains stayed independent.
		expect(knowledgeShape).toEqual({
			source: "fleet",
			document: "guide",
			section: "Section One",
			version: 1,
			content_hash: "dochash123",
		});
	});
});
