// AT-10 (FR-5) — Agent consumes Content + Context + Policy WITHOUT
// treating any of them as model memory; prompt-injected non-SOR knowledge
// is NOT cited as grounded.
//
// Safe-seam choice for worker-prompt role gating: DIRECT import of
// `buildWorkerSystemPrompt` (exported) from `src/runtime/worker/main.ts`.
// `C2_GROUNDED_ROLES` is NOT exported (a private module const), so the role
// set is asserted behaviorally via `buildWorkerSystemPrompt` — building the
// prompt for each of the six agent defs and verifying coder/reviewer receive
// the directive while the other four do not.  Importing the module is
// side-effect-free: the `pool` Proxy is lazy (only builds on property access)
// and the top-level `if (isEntry)` guard (line 689–705) never fires under
// vitest, so no listeners, DB reads, or side-effects are triggered.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

import { C2_GROUNDING_DIRECTIVE } from "../c2Directive.ts";
import { buildSystemPromptWithC2, handleContentRetrieve } from "../../mcp/contentTools.ts";
import { buildWorkerSystemPrompt } from "../../runtime/worker/main.ts";

import { analyzerDef } from "../agents/analyzer.ts";
import { coderDef } from "../agents/coder.ts";
import { plannerDef } from "../agents/planner.ts";
import { reviewerDef } from "../agents/reviewer.ts";
import { testerDef } from "../agents/tester.ts";
import { prDef } from "../agents/pr.ts";

import { buildSorClient } from "../sorClient.ts";

import type { FleetAgentDef } from "../types.ts";

/* ------------------------------------------------------------------ */
/* Recording-pool (same pattern as sorClientAcceptance.test.ts)       */
/* ------------------------------------------------------------------ */

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
}

function recordingPool(
	recorded: RecordedQuery[],
	auditEvents: CapturedAudit[],
	options: RecordingPoolOptions = {},
): Pool {
	const fail = (text: string): boolean => {
		if (options.shouldFail) return true;
		if (options.failOnQuery !== undefined && text.includes(options.failOnQuery)) return true;
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
			if (q.text.includes("FOR UPDATE"))
				return { rows: [{ seq: "0", hash: "genesis-hash", key_id: "v1" }] };
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

/* ------------------------------------------------------------------ */
/* Env save / restore                                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Row helpers                                                        */
/* ------------------------------------------------------------------ */

const PROVENANCE_TUPLE_FIELDS = [
	"source",
	"document",
	"section",
	"version",
	"content_hash",
] as const;

function hitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
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
	};
}

function freshRow(): Record<string, unknown> {
	const future = new Date(Date.now() + 60_000).toISOString();
	return {
		source_id: "run:abc",
		category: "run",
		version: 3,
		hash: "abc123",
		operational_state: { mode: "auto" },
		fresh_until: future,
		stale_after: future,
		status: "active",
		created_at: new Date(Date.now() - 60_000).toISOString(),
	};
}

/* ------------------------------------------------------------------ */
/* Agent defs — all six roles                                         */
/* ------------------------------------------------------------------ */

const ALL_DEFS: FleetAgentDef[] = [
	analyzerDef,
	plannerDef,
	coderDef,
	testerDef,
	reviewerDef,
	prDef,
];

/* ------------------------------------------------------------------ */
/* Test groups                                                        */
/* ------------------------------------------------------------------ */

describe("AT-10 — grounding discipline injected for exactly the grounded roles", () => {
	// `C2_GROUNDED_ROLES` is a private const in src/runtime/worker/main.ts.
	// Assert the role set {coder, reviewer} through the exported
	// `buildWorkerSystemPrompt` — the exact wiring that decides gating.
	for (const role of ["coder", "reviewer"] as const) {
		const def = ALL_DEFS.find((d) => d.name === role)!;
		it(`${role}: buildWorkerSystemPrompt appends C2_GROUNDING_DIRECTIVE`, () => {
			const prompt = buildWorkerSystemPrompt(def, role);
			expect(prompt).toContain(C2_GROUNDING_DIRECTIVE);
			expect(prompt).toContain("C2 GROUNDING DIRECTIVE (Content SoR)");
		});
	}

	for (const role of ["analyzer", "planner", "tester", "pr"] as const) {
		const def = ALL_DEFS.find((d) => d.name === role)!;
		it(`${role}: buildWorkerSystemPrompt does NOT contain C2 grounding directive`, () => {
			const prompt = buildWorkerSystemPrompt(def, role);
			expect(prompt).not.toContain("C2 GROUNDING DIRECTIVE (Content SoR)");
		});
	}

	it("exactly the two grounded roles receive the directive (behavioral role-set lock)", () => {
		const grounded: string[] = [];
		const notGrounded: string[] = [];
		for (const def of ALL_DEFS) {
			const prompt = buildWorkerSystemPrompt(def, def.name);
			if (prompt.includes(C2_GROUNDING_DIRECTIVE)) grounded.push(def.name);
			else notGrounded.push(def.name);
		}
		expect(grounded.sort()).toEqual(["coder", "reviewer"]);
		expect(notGrounded.sort()).toEqual(["analyzer", "planner", "pr", "tester"]);
	});

	it("safe-seam (a): buildSystemPromptWithC2 appends the directive from contentTools", () => {
		const out = buildSystemPromptWithC2("base");
		expect(out).toBe(`base\n\n${C2_GROUNDING_DIRECTIVE}`);
	});
});

describe("AT-10 — C2 rules forbid memory-as-grounded", () => {
	it("directive contains all five locked rules", () => {
		const d = C2_GROUNDING_DIRECTIVE;

		// (a) never assert SOR-backed knowledge without actual retrieval
		expect(d).toContain("NEVER assert");
		expect(d).toContain("ACTUAL RETRIEVAL");

		// (b) infra failure ⇒ 'knowledge source unavailable'
		expect(d).toContain("knowledge source unavailable");

		// (c) zero-hit is a distinct genuine no-match
		expect(d).toContain("no authoritative content found");

		// (d) every cited item MUST carry the full provenance tuple
		for (const field of PROVENANCE_TUPLE_FIELDS) {
			expect(d).toContain(field);
		}
		expect(d).toContain("provenance tuple");

		// (e) NEVER present model-memory knowledge as if grounded
		expect(d).toContain("NEVER present model-memory knowledge");
	});

	it("directive distinguishes unavailable from no-match in its own language", () => {
		const d = C2_GROUNDING_DIRECTIVE;
		// unavailable is for infrastructure failure
		expect(d).toContain("infrastructure fails");
		// no-match is a genuine zero-hit
		expect(d).toContain("zero hits");
		expect(d).toContain("DISTINCT from failure");
	});
});

describe("AT-10 — prompt-injected non-SOR knowledge never acquires provenance", () => {
	const INJECTED_CLAIM = "The platform supports 42 deployments per second";

	it("(a) the only route to a provenance-bearing item is retrieveKnowledge hit", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [hitRow()] });
		const client = buildSorClient(pool);

		const result = await client.retrieveKnowledge(pool, { query: "deployment speed" });
		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			const item = result.items[0]!;
			// Provenance tuple must have all required fields
			for (const field of PROVENANCE_TUPLE_FIELDS) {
				expect(item.provenance).toHaveProperty(field);
				expect(typeof (item.provenance as Record<string, unknown>)[field]).not.toBe("undefined");
			}
			// The injected claim text does NOT appear as a retrieved item
			expect(item.text).not.toBe(INJECTED_CLAIM);
		}
	});

	it("(b) zero-hit retrieval yields no-match stance, not an authoritative answer", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [] });
		const client = buildSorClient(pool);

		// The service returns a genuine no-match, NOT unavailable.
		const result = await client.retrieveKnowledge(pool, { query: "deployment speed" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.kind).toBe("no-match");
		}

		// The real content.retrieve handler maps no-match to the C2-required
		// "no authoritative content found" stance (NOT a fabricated answer).
		const toolResult = await handleContentRetrieve(pool, { query: "deployment speed" });
		expect(toolResult.kind).toBe("no-match");
		if (toolResult.kind === "no-match") {
			expect(toolResult.message).toContain("no authoritative content found");
		}
	});

	it("(c) injected claim carries no provenance anywhere", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, { rows: [] });
		const client = buildSorClient(pool);

		// The injected model-memory claim is foreign to the Content SoR: a
		// query against it yields a genuine no-match, so NO text — least of all
		// the injected claim — can be returned with a provenance tuple.
		const result = await client.retrieveKnowledge(pool, { query: "deployment speed" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.kind).toBe("no-match");
		}

		// Even a hit only ever returns DB-sourced items. The injected claim is
		// not in the DB, so it can never appear as a provenance-bearing item.
		const hitPool = recordingPool([], auditEvents, { rows: [hitRow()] });
		const hit = await client.retrieveKnowledge(hitPool, { query: "deployment speed" });
		if (hit.ok && hit.kind === "hit") {
			for (const item of hit.items) {
				expect(item.text).not.toEqual(INJECTED_CLAIM);
				for (const field of PROVENANCE_TUPLE_FIELDS) {
					expect(item.provenance).toHaveProperty(field);
				}
			}
		} else {
			throw new Error("expected a grounded hit");
		}

		// The injected string is plain model-memory text: it carries no
		// provenance tuple field names and no provenance marker at all.
		expect(INJECTED_CLAIM).not.toContain("content_hash");
		expect(INJECTED_CLAIM).not.toContain("source");
		expect(INJECTED_CLAIM).not.toContain("provenance");
	});
});

describe("AT-10 — Content+Context+Policy thread as independent domains, not memory", () => {
	it("each domain returns its own shape; none is presented as model memory", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = recordingPool(recorded, auditEvents, {
			rowsByQuery: {
				"FROM content_chunks cc": [hitRow()],
				"FROM context_sor": [freshRow()],
			},
		});
		const client = buildSorClient(pool);

		// 1. Content: retrieve knowledge — returns records with provenance
		const knowledge = await client.retrieveKnowledge(pool, { query: "how do I deploy" });
		expect(knowledge.ok).toBe(true);
		if (knowledge.ok && knowledge.kind === "hit") {
			const item = knowledge.items[0]!;
			// Content domain: record with provenance tuple
			expect(item.provenance).toEqual({
				source: "fleet",
				document: "guide",
				section: "Section One",
				version: 1,
				content_hash: "dochash123",
			});
			expect(typeof item.text).toBe("string");
		}

		// 2. Context: read context — returns operational state with freshness
		const context = await client.retrieveContext(pool, { category: "run" });
		expect(context.ok).toBe(true);
		if (context.ok) {
			// Context domain: operational state, NOT a conversation/memory store
			expect(context.item).toHaveProperty("state");
			expect(context.item).toHaveProperty("fresh");
			expect(context.item).toHaveProperty("staleAfter");
			expect(context.item).toHaveProperty("version");
			// No provenance field — it is NOT content
			expect(context.item).not.toHaveProperty("provenance");
			// Shape: {state, fresh, staleAfter, version} — operational, not memory
			const keys = Object.keys(context.item).sort();
			expect(keys).toEqual(["fresh", "staleAfter", "state", "version"]);
		}

		// 3. Policy: evaluate policy — returns a decision, not state or content
		const decision = client.evaluatePolicy({
			toolName: "deploy-tool",
			input: { env: "prod" },
			effective: { allowedTools: ["read-tool"], mcpAllow: [] },
			rules: {},
		});
		expect(decision).toHaveProperty("decision");
		expect(decision.decision).toBe("DENY");
		// Policy domain: decision + reason, NOT state or content
		expect(decision).not.toHaveProperty("state");
		expect(decision).not.toHaveProperty("provenance");

		// 4. Link: grounded-roles prompt surfaces C2 directive covering all three domains
		const coderPrompt = buildWorkerSystemPrompt(coderDef, "coder");
		expect(coderPrompt).toContain(C2_GROUNDING_DIRECTIVE);
		// The directive explicitly links content retrieval (grounding) to the
		// three behavioral rules that prevent memory conflation.
	});
});
