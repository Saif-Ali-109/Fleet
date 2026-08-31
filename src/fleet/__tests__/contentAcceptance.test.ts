// Phase 3 Content SoR acceptance tests (sor-spec §17.1) — contentAcceptance.
//
//   AT-1 (FR-4/12/15): every retrieval item carries the exact provenance tuple
//       { source, document, section, version, content_hash }, where content_hash
//       is the canonical content_sor document hash (never a chunk hash); and a
//       forged / no-resolvable-canonical vector hit is NOT an answer (K3/C1) —
//       the retrieval service only surfaces items resolved through a canonical
//       content_sor row (status='active'), so an 'invalid' or missing canonical
//       row is never presented.
//
//   AT-2 (FR-14): infra failure ⇒ { ok:false, kind:"unavailable", error }; a
//       zero-hit success is DISTINCT ⇒ { ok:true, kind:"no-match", query }. The
//       MCP tool handler maps unavailable → "knowledge source unavailable" and
//       no-match → "no authoritative content found for <query>" (C2 stance).
//
//   Phase 2 AT-3..AT-6 regression: the Content SoR retrieval tools are P-I1
//       policy gated exactly like every other tool (§21.4 — no read exemption).
//       A role whose policy does not grant a content tool cannot call it; a
//       granted role can. Asserted at the same level as the Phase 2 gating
//       suites (planWorkerPolicy ceiling∩grant + evaluateToolCall/computeEffectiveTools),
//       because the content tools are exposed manager-side and governed by the
//       shared mcpAllow grant mechanism.
//
// No model calls and no real DB — recording/mock pools and pure functions only.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The C2 mapping suite (below) mocks the retrieval service. To keep the earlier
// AT-1/AT-2 read-path suites on the REAL retrieveKnowledge, the mock factory
// delegates to the actual implementation by default; only the C2 suite overrides
// it with mockResolvedValue. (vi.mock is scoped per-file, so this single factory
// governs every import in this file.)
const mocks = vi.hoisted(() => ({
	retrieveKnowledge: vi.fn<typeof retrieveKnowledge>(),
	listSources: vi.fn(),
	getDocument: vi.fn(),
	emitContentAccessAggregate: vi.fn(),
}));

vi.mock("../contentRetrieval.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../contentRetrieval.ts")>();
	const delegate = (fn: typeof mocks.retrieveKnowledge, impl: unknown) =>
		fn.mockImplementation(impl as never);
	return {
		...actual,
		retrieveKnowledge: delegate(mocks.retrieveKnowledge, actual.retrieveKnowledge),
		listSources: mocks.listSources.mockImplementation(actual.listSources as never),
		getDocument: mocks.getDocument.mockImplementation(actual.getDocument as never),
		emitContentAccessAggregate: mocks.emitContentAccessAggregate.mockImplementation(
			actual.emitContentAccessAggregate as never,
		),
	};
});

// ----- Phase 2 P-I1 gating imports (regression) -----
import { coderDef } from "../agents/coder.ts";
import { reviewerDef } from "../agents/reviewer.ts";
import {
	buildContentDoc,
	type ContentDoc,
	provenanceOf,
	syncOutcome,
} from "../content.ts";
import {
	type RetrievalResult,
	retrieveKnowledge,
} from "../contentRetrieval.ts";
import {
	capabilitySnapshot,
	emptyPolicy,
	type PolicyDocument,
} from "../policy.ts";
import {
	computeEffectiveTools,
	evaluateToolCall,
	type EffectiveToolSet,
} from "../policyEval.ts";
import { planWorkerPolicy } from "../../runtime/worker/main.ts";
import type { FleetAgentDef, ToolName } from "../types.ts";

// The content retrieval tools (decided names, plan-sor §G5 / contentTools.ts).
const CONTENT_TOOLS = [
	"content.retrieve",
	"content.list_sources",
	"content.get_document",
] as const;
type ContentToolName = (typeof CONTENT_TOOLS)[number];

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function recordingPool(
	rows: Record<string, unknown>[],
	recorded: RecordedQuery[],
	options?: { shouldFail?: boolean; failMessage?: string },
): Pool {
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
		connect: async () => ({
			query: async () => ({ rows: [], rowCount: 1 }),
			release: () => {},
		}),
	} as unknown as Pool;
}

// A well-formed T2 ContentDoc whose hash is the canonical document hash.
const DOC: ContentDoc = buildContentDoc({
	sourceId: "fleet|content|md:kb.md",
	version: 2,
	canonicalContent: "The fleet soars across the sky.\n",
	metadata: { title: "KB", source: "fleet", document: "kb" },
	provenance: {},
});

// ---- AT-1 ---------------------------------------------------------------

describe("AT-1 — provenance on every output (FR-4/12/15) + canonical-only (K3/C1)", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		delete process.env.CONTENT_EMBED_RANK;
	});

	afterEach(() => {
		delete process.env.CONTENT_EMBED_RANK;
	});

	it("provenanceOf emits the exact five-field tuple with the canonical doc hash", () => {
		const tuple = provenanceOf(
			{
				sorType: "content",
				sourceId: DOC.sourceId,
				version: DOC.version,
				hash: DOC.hash,
			},
			"fleet",
			"kb",
			"Introduction",
		);
		// Exact shape and field names (contract, C3).
		expect(Object.keys(tuple).sort()).toEqual([
			"content_hash",
			"document",
			"section",
			"source",
			"version",
		]);
		expect(tuple).toEqual({
			source: "fleet",
			document: "kb",
			section: "Introduction",
			version: DOC.version,
			content_hash: DOC.hash,
		});
		// content_hash is the canonical document hash, not a chunk hash.
		expect(tuple.content_hash).toBe(DOC.hash);
		expect(tuple.content_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("every retrieveKnowledge hit item carries the exact provenance tuple", async () => {
		const pool = recordingPool(
			[
				{
					text: "chunk text",
					section: "Introduction",
					chunk_index: 0,
					fts_rank: "0.9",
					source: "fleet",
					document: "kb",
					version: String(DOC.version),
					content_hash: DOC.hash,
					status: "active",
				},
				{
					text: "second chunk",
					section: "Details",
					chunk_index: 1,
					fts_rank: "0.4",
					source: "fleet",
					document: "kb",
					version: String(DOC.version),
					content_hash: DOC.hash,
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, { query: "soars" });

		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(2);
			for (const item of result.items) {
				// Exact tuple on EVERY item.
				expect(Object.keys(item.provenance).sort()).toEqual([
					"content_hash",
					"document",
					"section",
					"source",
					"version",
				]);
				expect(item.provenance.source).toBe("fleet");
				expect(item.provenance.document).toBe("kb");
				expect(item.provenance.version).toBe(DOC.version);
				// content_hash is the canonical doc hash (never a chunk hash).
				expect(item.provenance.content_hash).toBe(DOC.hash);
			}
			// section is carried through for citation resolution (source → doc → section).
			expect(result.items.map((i) => i.provenance.section)).toEqual([
				"Introduction",
				"Details",
			]);
		}
	});

	it("a forged vector hit with no resolvable canonical content_sor row is never an answer (K3/C1)", async () => {
		// The retrieval service resolves chunks ONLY through a canonical content_sor
		// row: the SQL always INNER JOINs content_chunks to content_sor on
		// (doc_id, version) and filters cs.status='active'. A chunk whose canonical
		// row is missing (no JOIN match) or status='invalid' drops out of the result
		// set — it is never surfaced as an answer.
		process.env.CONTENT_EMBED_RANK = "true";

		// The DB applies the canonical-resolution filter; the only rows that survive
		// are those with a resolvable active canonical row. Simulate the real
		// Postgres outcome after the JOIN + status filter.
		const pool = recordingPool(
			[
				// A legitimately resolvable chunk — surfaces with a full tuple.
				{
					text: "canonical chunk",
					section: "Real",
					chunk_index: 0,
					fts_rank: "0.8",
					vector_dist: "0.1",
					source: "fleet",
					document: "kb",
					version: String(DOC.version),
					content_hash: DOC.hash,
					status: "active",
				},
			],
			recorded,
		);

		const result = await retrieveKnowledge(pool, {
			query: "soars",
			queryEmbedding: [0.1, 0.2, 0.3],
		});

		// Only the resolvable-canonical item is returned — no forged/no-record hit
		// is presented (the DB omitted it), and every surfaced item resolves to a
		// canonical content_sor row via content_hash + join provenance.
		expect(result.ok).toBe(true);
		if (result.ok && result.kind === "hit") {
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.provenance.content_hash).toBe(DOC.hash);
			expect(result.items[0]!.provenance.document).toBe("kb");
		}

		// The SQL that enforces K3/C1 is literally present: canonical resolution via
		// the JOIN and the status='active' filter (invalid → not served, §4.4).
		const select = recorded.find((q) => q.text.includes("FROM content_chunks cc"));
		expect(select).toBeDefined();
		expect(select?.text).toContain("JOIN content_sor cs");
		expect(select?.text).toContain("cc.doc_id = cs.source_id");
		expect(select?.text).toContain("cc.version = cs.version");
		expect(select?.text).toContain("cs.status = 'active'");
	});

	it("unparseable/invalid canonical rows are filtered to status='active' in both FTS and vector paths", async () => {
		// Both the FTS-primary and vector-ranked retrieval SQL must resolve through a
		// canonical content_sor row whose status is 'active' — an 'invalid' (unparseable,
		// §4.4) canonical row is never served as authoritative.
		const recordedFts: RecordedQuery[] = [];
		await retrieveKnowledge(recordingPool([], recordedFts), { query: "x" });

		process.env.CONTENT_EMBED_RANK = "true";
		const recordedVec: RecordedQuery[] = [];
		await retrieveKnowledge(recordingPool([], recordedVec), {
			query: "x",
			queryEmbedding: [0.1],
		});
		delete process.env.CONTENT_EMBED_RANK;

		for (const recorded of [recordedFts, recordedVec]) {
			const select = recorded.find((q) => q.text.includes("FROM content_chunks cc"));
			expect(select).toBeDefined();
			expect(select?.text).toContain("JOIN content_sor cs");
			expect(select?.text).toContain("cs.status = 'active'");
		}
	});

	it("AT-1 idempotent re-sync: unchanged canonical content is not a new version (FR-13)", () => {
		const sameContent = buildContentDoc({
			sourceId: DOC.sourceId,
			version: DOC.version,
			canonicalContent: DOC.canonicalContent, // identical canonical text
			metadata: DOC.metadata,
			provenance: DOC.provenance,
		});
		expect(syncOutcome(DOC, sameContent)).toEqual({
			kind: "unchanged",
			version: DOC.version,
		});

		const changed = buildContentDoc({
			sourceId: DOC.sourceId,
			version: DOC.version,
			canonicalContent: "Completely different canonical text.\n",
			metadata: DOC.metadata,
			provenance: DOC.provenance,
		});
		expect(syncOutcome(DOC, changed)).toEqual({
			kind: "updated",
			version: DOC.version + 1,
		});
	});
});

// ---- AT-2 ---------------------------------------------------------------

describe("AT-2 — unavailable ≠ no-match (FR-14/C2)", () => {
	let recorded: RecordedQuery[];

	beforeEach(() => {
		recorded = [];
		delete process.env.CONTENT_EMBED_RANK;
	});

	afterEach(() => {
		delete process.env.CONTENT_EMBED_RANK;
	});

	it("infra failure ⇒ { ok:false, kind:'unavailable', error }", async () => {
		const pool = recordingPool([], recorded, {
			shouldFail: true,
			failMessage: "connection refused",
		});
		const result = await retrieveKnowledge(pool, { query: "soars" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("unavailable");
			expect(result.error).toContain("connection refused");
		}
	});

	it("zero-hit success is DISTINCT ⇒ { ok:true, kind:'no-match', query }", async () => {
		const pool = recordingPool([], recorded);
		const result: RetrievalResult = await retrieveKnowledge(pool, {
			query: "abracadabra",
		});
		expect(result).toEqual({ ok: true, kind: "no-match", query: "abracadabra" });
		// no-match is a SUCCESS (ok:true) — never 'unavailable'.
		expect(result.ok).toBe(true);
		expect("error" in result).toBe(false);
	});
});

// ---- AT-2 C2 mapping (MCP tool handler) ---------------------------------

describe("AT-2 — MCP tool handler maps unavailable vs no-match to the C2 stance (FR-14)", () => {
	beforeEach(() => {
		mocks.retrieveKnowledge.mockReset();
		mocks.listSources.mockReset();
		mocks.getDocument.mockReset();
		mocks.emitContentAccessAggregate.mockReset();
	});

	it("maps infra-unavailable to 'knowledge source unavailable' (never guesses)", async () => {
		const { handleContentRetrieve } = await import("../../mcp/contentTools.ts");
		mocks.retrieveKnowledge.mockResolvedValue({
			ok: false,
			kind: "unavailable",
			error: "db down",
		});

		const result = await handleContentRetrieve({} as Pool, { query: "x" });

		expect(result).toEqual({
			kind: "unavailable",
			message: "knowledge source unavailable",
			error: "db down",
		});
		// The agent is directed to state unavailable, never to answer from memory.
		expect(result.kind).toBe("unavailable");
	});

	it("maps zero-hit to the distinct 'no authoritative content found for <query>'", async () => {
		const { handleContentRetrieve } = await import("../../mcp/contentTools.ts");
		mocks.retrieveKnowledge.mockResolvedValue({
			ok: true,
			kind: "no-match",
			query: "rare phrase",
		});

		const result = await handleContentRetrieve({} as Pool, { query: "rare phrase" });

		expect(result).toEqual({
			kind: "no-match",
			message: 'no authoritative content found for "rare phrase"',
		});
		// Not 'unavailable' — a genuine, distinct no-match.
		expect(result.kind).toBe("no-match");
	});
});

// ---- Phase 2 AT-3..AT-6 regression: content tools are P-I1 gated ---------

describe("Phase 2 AT-3..AT-6 regression — content retrieval tools are P-I1 gated (§21.4, no read exemption)", () => {
	function contentDef(withContentTools: boolean): FleetAgentDef {
		return {
			...coderDef,
			mcpAllow: withContentTools ? [...CONTENT_TOOLS] : [],
		};
	}

	it("AT-3: a role whose policy grants a content tool is allowed; one without it is denied", () => {
		// A granted role (CODED ceiling grants the tools + policy grants them).
		const grantedDef = contentDef(true);
		const grantedDoc: PolicyDocument = {
			...capabilitySnapshot(grantedDef, "coder"),
			mcpAllow: [...CONTENT_TOOLS],
		};
		const grantedPlan = planWorkerPolicy(grantedDef, {
			mode: "sor",
			policyVersion: 1,
			policyHash: "h",
			document: grantedDoc,
		});
		// Ceiling ∩ grant: the granted tools are in the effective mcpAllow.
		for (const tool of CONTENT_TOOLS) {
			expect(grantedPlan.mcpAllow).toContain(tool);
		}

		// An ungranted role: ceiling grants the tools but the POLICY grant omits them.
		const ungrantedDoc: PolicyDocument = {
			...capabilitySnapshot(grantedDef, "coder"),
			mcpAllow: [], // policy grants NO content tools
		};
		const ungrantedPlan = planWorkerPolicy(grantedDef, {
			mode: "sor",
			policyVersion: 1,
			policyHash: "h",
			document: ungrantedDoc,
		});
		// Effective mcpAllow = ceiling ∩ grant = ∅ ⇒ the worker registers no content
		// tool ⇒ a call to one is an unknown-tool DENY (never executed).
		expect(ungrantedPlan.mcpAllow).toEqual([]);

		const effective: EffectiveToolSet = {
			allowedTools: ungrantedPlan.tools,
			mcpAllow: ungrantedPlan.mcpAllow,
		};
		for (const tool of CONTENT_TOOLS) {
			const decision = evaluateToolCall(tool, { query: "x" }, effective, {});
			expect(decision.allowed).toBe(false);
			expect(decision.decision).toBe("DENY");
		}
	});

	it("AT-3: an ungranted content tool is side-effectless — evaluateToolCall denies it without exec", () => {
		// Mirror the accepted Phase 2 gating style (policyEval.test.ts): a tool with
		// no effective grant is an implicit DENY (unknown tool) — not executed.
		const effective: EffectiveToolSet = { allowedTools: [], mcpAllow: [] };
		for (const tool of CONTENT_TOOLS) {
			expect(evaluateToolCall(tool, {}, effective, {})).toEqual({
				allowed: false,
				decision: "DENY",
				reason: `unknown tool: ${tool}`,
			});
		}
	});

	it("AT-4: a content-tool grant cannot exceed the capability ceiling", () => {
		// Even if the policy grants every content tool, a role whose def ceiling does
		// not include them gets none (code capability never silently grants).
		const plainDef = contentDef(false); // ceiling has NO content tools
		const doc: PolicyDocument = {
			...capabilitySnapshot(plainDef, "coder"),
			mcpAllow: [...CONTENT_TOOLS], // grant offers them
		};
		const plan = planWorkerPolicy(plainDef, {
			mode: "sor",
			policyVersion: 1,
			policyHash: "h",
			document: doc,
		});
		expect(plan.mcpAllow).toEqual([]);

		const effective = computeEffectiveTools(
			{ tools: plainDef.tools, mcpAllow: plainDef.mcpAllow },
			doc,
		);
		for (const tool of CONTENT_TOOLS) {
			expect(effective.mcpAllow).not.toContain(tool);
		}
	});

	it("AT-4/AT-5: coder & reviewer defs carry no content grant today, so no worker has the tools absent a deliberate grant", () => {
		// Per the adopted §8.2 manager-side design, content retrieval tools are gated
		// through the shared mcpAllow grant mechanism and are NOT a code hardcode for
		// any role. This asserts the def-level baseline the P-I1 ceiling/grant revolver
		// operates on: neither coder nor reviewer impersonally hardcode a content grant;
		// any grant must come from a deliberate policy grant (drift-aware, AT-5).
		expect(coderDef.mcpAllow).toEqual([]);
		expect(reviewerDef.mcpAllow).toEqual([]);
		for (const role of [coderDef, reviewerDef] as const) {
			const plan = planWorkerPolicy(role, {
				mode: "sor",
				policyVersion: 1,
				policyHash: "h",
				document: capabilitySnapshot(role, role.name),
			});
			// capabilitySnapshot of an empty-mcpAllow def grants nothing by default.
			expect(plan.mcpAllow).toEqual([]);
		}
	});

	it("AT-5/AT-6: content tools follow the empty-grant (FR-11) and drift discipline — a zero-grant doc grants nothing", () => {
		// FR-11: an empty-but-valid policy document grants zero content tools and the
		// mode stays 'sor' (no silent grant, no downgrade to compatibility).
		const grantedDef = contentDef(true);
		const empty = emptyPolicy("coder");
		const effective = computeEffectiveTools(
			{ tools: grantedDef.tools, mcpAllow: grantedDef.mcpAllow },
			empty,
		);
		expect(effective.mcpAllow).toEqual([]);
		for (const tool of CONTENT_TOOLS) {
			expect(
				evaluateToolCall(tool, {}, effective, empty.toolRules).allowed,
			).toBe(false);
		}
	});
});
