import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAppendAuditEvent, mockEmitPolicySync } = vi.hoisted(() => ({
	mockAppendAuditEvent: vi.fn(),
	mockEmitPolicySync: vi.fn(),
}));

vi.mock("../../db/audit.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../db/audit.ts")>();
	return {
		...mod,
		appendAuditEvent: mockAppendAuditEvent,
		emitPolicySync: mockEmitPolicySync,
	};
});

import {
	retrieveKnowledge,
	retrieveContext,
	evaluatePolicy,
	recordProvenance,
	buildSorClient,
	type ProvenanceRecord,
	type SorClient,
} from "../sorClient.ts";
import type { SorEvent } from "../../sor/events.ts";
import type { EffectiveToolSet } from "../policyEval.ts";
import type { RulePredicate } from "../../sor/kernel/types.ts";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function recordingPool(
	rows: Record<string, unknown>[],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failMessage?: string },
): Pool {
	const client = {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (options?.shouldFail) {
				throw new Error(options.failMessage ?? "DB error");
			}
			return { rows };
		},
		release: () => {},
	};
	return {
		query: async (...args: unknown[]) => {
			const q: RecordedQuery =
				typeof args[0] === "string"
					? { text: args[0], values: args[1] as unknown[] | undefined }
					: (args[0] as RecordedQuery);
			recorded.push(q);
			if (options?.shouldFail) {
				throw new Error(options.failMessage ?? "DB error");
			}
			return { rows };
		},
		connect: async () => client,
	} as unknown as Pool;
}

let savedKey: string | undefined;
let savedKeyV1: string | undefined;
let savedKeyId: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyV1 = process.env.SOR_KEY_V1;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = "test-signing-key";
	process.env.SOR_KEY_V1 = "test-signing-key";
	process.env.SOR_KEY_ID = "v1";
	mockAppendAuditEvent.mockReset();
	mockAppendAuditEvent.mockResolvedValue(undefined);
	mockEmitPolicySync.mockReset();
	mockEmitPolicySync.mockResolvedValue(undefined);
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.SOR_SIGNING_KEY;
	else process.env.SOR_SIGNING_KEY = savedKey;
	if (savedKeyV1 === undefined) delete process.env.SOR_KEY_V1;
	else process.env.SOR_KEY_V1 = savedKeyV1;
	if (savedKeyId === undefined) delete process.env.SOR_KEY_ID;
	else process.env.SOR_KEY_ID = savedKeyId;
});

describe("retrieveKnowledge — delegates to contentRetrieval, unions preserved", () => {
	it("hit → items with full provenance tuple", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(
			[
				{
					text: "chunk text",
					section: "Section One",
					chunk_index: 0,
					fts_rank: "0.8",
					source: "fleet",
					document: "guide",
					version: 1,
					content_hash: "dochash123",
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "test query" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.provenance).toEqual({
				source: "fleet",
				document: "guide",
				section: "Section One",
				version: 1,
				content_hash: "dochash123",
			});
		}
	});

	it("no-match → ok:true distinct from unavailable", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const result = await retrieveKnowledge(pool, { query: "nonexistent" });

		expect(result).toEqual({ ok: true, kind: "no-match", query: "nonexistent" });
	});

	it("unavailable on DB failure → error preserved", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "connection timeout",
		});

		const result = await retrieveKnowledge(pool, { query: "test" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unavailable");
			expect(result.error).toContain("connection timeout");
		}
	});

	it("NO audit append occurs on read", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(
			[
				{
					text: "text",
					section: "S",
					chunk_index: 0,
					fts_rank: "0.5",
					source: "fleet",
					document: "doc",
					version: 1,
					content_hash: "h",
					status: "active",
				},
			],
			recorded,
		);

		await retrieveKnowledge(pool, { query: "test" });

		expect(mockAppendAuditEvent).not.toHaveBeenCalled();
	});
});

describe("retrieveContext — delegates to contextRetrieval, freshness preserved", () => {
	it("fresh row → state, fresh:true, staleAfter, version", async () => {
		const recorded: RecordedQuery[] = [];
		const future = new Date(Date.now() + 60_000).toISOString();
		const pool = recordingPool(
			[
				{
					source_id: "run:abc",
					category: "run",
					version: 3,
					hash: "abc123",
					operational_state: { mood: "calm" },
					fresh_until: future,
					stale_after: future,
					status: "active",
					created_at: new Date(Date.now() - 60_000).toISOString(),
				},
			],
			recorded,
		);

		const res = await retrieveContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.item.state).toEqual({ mood: "calm" });
			expect(res.item.fresh).toBe(true);
			expect(res.item.version).toBe(3);
			expect(res.item.staleAfter).toBeTruthy();
		}
	});

	it("stale row → fresh:false", async () => {
		const recorded: RecordedQuery[] = [];
		const past = new Date(Date.now() - 60_000).toISOString();
		const pool = recordingPool(
			[
				{
					source_id: "run:abc",
					category: "run",
					version: 2,
					hash: "abc123",
					operational_state: { mood: "calm" },
					fresh_until: past,
					stale_after: past,
					status: "active",
					created_at: new Date(Date.now() - 120_000).toISOString(),
				},
			],
			recorded,
		);

		const res = await retrieveContext(pool, { category: "run" });

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.item.fresh).toBe(false);
		}
	});

	it("not-found → ok:false, kind:not-found (distinct from unavailable)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const res = await retrieveContext(pool, { category: "run" });

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.kind).toBe("not-found");
		}
	});

	it("unavailable → ok:false, kind:unavailable with error", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "boom",
		});

		const res = await retrieveContext(pool, { category: "run" });

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.kind).toBe("unavailable");
			expect(res.error).toBe("boom");
		}
	});

	it("NO audit append occurs on read", async () => {
		const recorded: RecordedQuery[] = [];
		const future = new Date(Date.now() + 60_000).toISOString();
		const pool = recordingPool(
			[
				{
					source_id: "run:abc",
					category: "run",
					version: 1,
					hash: "h",
					operational_state: {},
					fresh_until: future,
					stale_after: future,
					status: "active",
					created_at: new Date(Date.now() - 60_000).toISOString(),
				},
			],
			recorded,
		);

		await retrieveContext(pool, { category: "run" });

		expect(mockAppendAuditEvent).not.toHaveBeenCalled();
	});
});

describe("evaluatePolicy — pure, no pool", () => {
	const effective: EffectiveToolSet = {
		allowedTools: ["tool-a", "tool-b"],
		mcpAllow: ["mcp-tool-x"],
	};

	it("ALLOW on granted tool", () => {
		const result = evaluatePolicy({
			toolName: "tool-a",
			input: {},
			effective,
			rules: {},
		});

		expect(result).toEqual({ allowed: true, decision: "ALLOW", reason: "allowed" });
	});

	it("DENY on unknown tool (fail-closed)", () => {
		const result = evaluatePolicy({
			toolName: "tool-unknown",
			input: {},
			effective,
			rules: {},
		});

		expect(result.allowed).toBe(false);
		expect(result.decision).toBe("DENY");
		expect(result.reason).toContain("unknown tool: tool-unknown");
	});

	it("DENY via deny rule matcher", () => {
		const rules: Record<string, RulePredicate[]> = {
			"tool-a": [
				{ op: "deny", when: { path: "action", oneOf: ["delete"] }, reason: "no deletes" },
			],
		};

		const result = evaluatePolicy({
			toolName: "tool-a",
			input: { action: "delete" },
			effective,
			rules,
		});

		expect(result.allowed).toBe(false);
		expect(result.decision).toBe("DENY");
		expect(result.reason).toBe("no deletes");
	});

	it("DENY via unmet require rule", () => {
		const rules: Record<string, RulePredicate[]> = {
			"tool-b": [
				{
					op: "require",
					when: { path: "approved", oneOf: [true] },
					reason: "approval required",
				},
			],
		};

		const result = evaluatePolicy({
			toolName: "tool-b",
			input: { approved: false },
			effective,
			rules,
		});

		expect(result.allowed).toBe(false);
		expect(result.decision).toBe("DENY");
		expect(result.reason).toBe("approval required");
	});

	it("ALLOW on granted mcp tool", () => {
		const result = evaluatePolicy({
			toolName: "mcp-tool-x",
			input: {},
			effective,
			rules: {},
		});

		expect(result).toEqual({ allowed: true, decision: "ALLOW", reason: "allowed" });
	});
});

describe("recordProvenance — dispatches to correct emitters, NON-FATAL", () => {
	it("content-access → emitContentAccessAggregate with §12.2 payload fields", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		await recordProvenance(pool, {
			topic: "content-access",
			payload: {
				sessionId: "sess-123",
				mode: "aggregate",
				count: 5,
				topSources: ["fleet", "external"],
			},
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const event = mockAppendAuditEvent.mock.calls[0]![1] as SorEvent;
		expect(event.event_type).toBe("content_access");
		expect(event.actor).toBe("manager");
		expect(event.payload).toMatchObject({
			sorType: "content",
			sourceId: "aggregate",
			namespace: "fleet",
			version: 1,
			hash: "aggregate",
			actor: "manager",
			sessionId: "sess-123",
			mode: "aggregate",
			count: 5,
			topSources: ["fleet", "external"],
		});
		expect(typeof (event.payload as Record<string, unknown>).ts).toBe("string");
	});

	it("content-sync → emitContentSyncNonFatal with kind/payload", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		await recordProvenance(pool, {
			topic: "content-sync",
			payload: { kind: "added", status: "active", sourceId: "doc:1", version: 2 },
		});

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const event = mockAppendAuditEvent.mock.calls[0]![1] as SorEvent;
		expect(event.event_type).toBe("content_sync");
		expect(event.payload).toMatchObject({
			sorType: "content",
			sourceId: "doc:1",
			namespace: "fleet",
			version: 2,
			kind: "added",
			status: "active",
			actor: "manager",
		});
	});

	it("context-update → emitContextUpdateNonFatal with prevVersion", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		await recordProvenance(pool, {
			topic: "context-update",
			payload: {
				sourceId: "run:abc",
				version: 3,
				hash: "hash123",
				prevVersion: 2,
			},
		});

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const event = mockAppendAuditEvent.mock.calls[0]![1] as SorEvent;
		expect(event.event_type).toBe("context_update");
		expect(event.payload).toMatchObject({
			sorType: "context",
			sourceId: "run:abc",
			namespace: "fleet",
			version: 3,
			hash: "hash123",
			prevVersion: 2,
			actor: "manager",
		});
	});

	it("policy-sync → emitPolicySync with kind + document when seeded", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);

		const doc = {
			schemaVersion: 1 as const,
			meta: { subject_role: "coder" },
			allowedTools: ["tool-a"],
			mcpAllow: [],
			toolRules: {},
		};

		const payload = {
			kind: "seeded" as const,
			role: "coder" as const,
			prevVersion: 0,
			nextVersion: 1,
			policyHash: "phash",
			document: doc,
		};

		await recordProvenance(pool, {
			topic: "policy-sync",
			payload,
		});

		expect(mockEmitPolicySync).toHaveBeenCalledTimes(1);
		expect(mockEmitPolicySync).toHaveBeenCalledWith(pool, payload);
	});

	it("forced emitter failure → warns at emitter level + continues (no throw)", async () => {
		mockAppendAuditEvent.mockRejectedValueOnce(new Error("chain locked"));

		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await recordProvenance(pool, {
			topic: "content-sync",
			payload: { kind: "unchanged", status: "active", sourceId: "doc:1", version: 1 },
		});

		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[sor] content_sync skipped"),
		);

		consoleWarn.mockRestore();
	});
});

describe("buildSorClient — ergonomic object surface", () => {
	it("returns object with all four ops bound to a pool", () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const client: SorClient = buildSorClient(pool);

		expect(typeof client.retrieveKnowledge).toBe("function");
		expect(typeof client.retrieveContext).toBe("function");
		expect(typeof client.evaluatePolicy).toBe("function");
		expect(typeof client.recordProvenance).toBe("function");
	});

	it("retrieveKnowledge via client delegates to same logic", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(
			[
				{
					text: "text",
					section: "S",
					chunk_index: 0,
					fts_rank: "0.5",
					source: "fleet",
					document: "doc",
					version: 1,
					content_hash: "h",
					status: "active",
				},
			],
			recorded,
		);
		const client = buildSorClient(pool);

		const result = await client.retrieveKnowledge(pool, { query: "test" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items[0]!.provenance.content_hash).toBe("h");
		}
	});

	it("evaluatePolicy via client delegates to same logic", () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const client = buildSorClient(pool);

		const result = client.evaluatePolicy({
			toolName: "unknown-tool",
			input: {},
			effective: { allowedTools: [], mcpAllow: [] },
			rules: {},
		});

		expect(result.allowed).toBe(false);
		expect(result.decision).toBe("DENY");
	});

	it("recordProvenance via client dispatches correctly", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const client = buildSorClient(pool);

		await client.recordProvenance(pool, {
			topic: "content-sync",
			payload: { kind: "added", status: "active", sourceId: "doc:1", version: 1 },
		});

		expect(mockAppendAuditEvent).toHaveBeenCalledTimes(1);
		const event = mockAppendAuditEvent.mock.calls[0]![1] as SorEvent;
		expect(event.event_type).toBe("content_sync");
	});
});

describe("type contracts — ProvenanceRecord and SorClient compile against fixtures", () => {
	it("ProvenanceRecord is assignable from well-typed fixtures", () => {
		const accessRecord: ProvenanceRecord = {
			topic: "content-access",
			payload: { sessionId: "s1", mode: "aggregate", count: 1, topSources: [] },
		};
		const syncRecord: ProvenanceRecord = {
			topic: "content-sync",
			payload: { kind: "added", status: "active", sourceId: "d1", version: 1 },
		};
		const ctxRecord: ProvenanceRecord = {
			topic: "context-update",
			payload: { sourceId: "r1", version: 1, hash: "h", prevVersion: 0 },
		};
		const polRecord: ProvenanceRecord = {
			topic: "policy-sync",
			payload: {
				kind: "seeded",
				role: "coder",
				prevVersion: 0,
				nextVersion: 1,
				policyHash: "ph",
			},
		};

		expect(accessRecord.topic).toBe("content-access");
		expect(syncRecord.topic).toBe("content-sync");
		expect(ctxRecord.topic).toBe("context-update");
		expect(polRecord.topic).toBe("policy-sync");
	});

	it("SorClient interface matches buildSorClient return type", () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool([], recorded);
		const client: SorClient = buildSorClient(pool);
		const ref: SorClient = client;
		expect(ref).toBeDefined();
	});
});
