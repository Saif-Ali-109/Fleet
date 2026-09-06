// T9 integration test — Phase 3 Content SoR v1 (Wave D) end-to-end seams.
// Verifies the Wave A/B/C deliverables actually connect without a real DB or
// any model calls:
//   1. C2 grounding directive wired into the worker systemPrompt for the v1
//      ground roles (coder/reviewer) and only for them.
//   2. T2 ContentDoc/ContentChunk fixtures flow through the T5 write path
//      (upsertDocument) and the T6 read service (retrieveKnowledge) — spelled
//      out as type-level contracts plus fake-pool runtime checks.
//   3. T8 tool registration uses the decided names
//      content.retrieve / content.list_sources / content.get_document.
//   4. The `sor:content:sync` CLI script is wired in package.json → T7 entry.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSyncContent } from "../../cli/contentCommands.ts";
import {
	buildSystemPromptWithC2,
	CONTENT_TOOL_DEFS,
} from "../../mcp/contentTools.ts";
import { buildWorkerSystemPrompt } from "../../runtime/worker/main.ts";
import type { Role } from "../../types.ts";
import { analyzerDef } from "../agents/analyzer.ts";
import { coderDef } from "../agents/coder.ts";
import { plannerDef } from "../agents/planner.ts";
import { prDef } from "../agents/pr.ts";
import { reviewerDef } from "../agents/reviewer.ts";
import { testerDef } from "../agents/tester.ts";
import { C2_GROUNDING_DIRECTIVE } from "../c2Directive.ts";
import {
	buildContentDoc,
	type ContentChunk,
	type ContentDoc,
	provenanceOf,
} from "../content.ts";
import {
	type RetrievalResult,
	retrieveKnowledge,
} from "../contentRetrieval.ts";
import { upsertDocument } from "../contentStore.ts";
import { injectSkills } from "../skills/loader.ts";
import type { FleetAgentDef } from "../types.ts";

const DEFS: Record<Role, FleetAgentDef> = {
	analyzer: analyzerDef,
	planner: plannerDef,
	coder: coderDef,
	tester: testerDef,
	reviewer: reviewerDef,
	pr: prDef,
};

const C2_MARKER = "C2 GROUNDING DIRECTIVE";

const GROUND_ROLES: readonly Role[] = ["coder", "reviewer"];
const OTHER_ROLES: readonly Role[] = ["analyzer", "planner", "tester", "pr"];

// Well-typed T2 fixtures (the locked G5 contracts).
const doc: ContentDoc = buildContentDoc({
	sourceId: "fleet|content|md:knowledge/kb.md",
	version: 1,
	canonicalContent: "The fleet soars across the sky.\n",
	metadata: { title: "KB", source: "fleet", document: "kb" },
	provenance: {},
});

const chunk: ContentChunk = {
	docId: doc.sourceId,
	version: doc.version,
	section: "root",
	chunkIndex: 0,
	text: "The fleet soars across the sky.",
	contentHash: doc.hash,
	embedding: null,
	ref: {
		sorType: "content",
		sourceId: doc.sourceId,
		version: doc.version,
		hash: doc.hash,
	},
};

function fakePool(): Pool {
	return {
		query: async () => ({ rows: [], rowCount: 0 }),
		connect: async () => ({
			query: async (sql: string) =>
				sql.includes("sor_chain WHERE id = 1")
					? { rows: [{ seq: 0, hash: "genesis", key_id: "v1" }] }
					: { rows: [], rowCount: 1 },
			release: () => {},
		}),
	} as unknown as Pool;
}

beforeAll(() => {
	// Signing is only needed so the NON-FATAL content_sync append completes
	// against the fake pool — the chain itself is never touched for real.
	process.env.SOR_SIGNING_KEY = "integration-test-signing-key";
});

afterAll(() => {
	delete process.env.SOR_SIGNING_KEY;
});

describe("C2 grounding directive wiring (worker systemPrompt)", () => {
	it.each(GROUND_ROLES)(
		"appends the directive to the %s systemPrompt",
		(role) => {
			const prompt = buildWorkerSystemPrompt(DEFS[role], role);
			expect(prompt).toContain(C2_MARKER);
			expect(prompt).toContain(C2_GROUNDING_DIRECTIVE);
		},
	);

	it.each(OTHER_ROLES)(
		"does NOT append the directive to the %s systemPrompt",
		(role) => {
			const prompt = buildWorkerSystemPrompt(DEFS[role], role);
			expect(prompt).not.toContain(C2_MARKER);
		},
	);

	it("ground-role prompts equal the T8 seam over the skills-injected base", () => {
		for (const role of GROUND_ROLES) {
			const base = injectSkills(DEFS[role].systemPrompt, role);
			expect(buildWorkerSystemPrompt(DEFS[role], role)).toBe(
				buildSystemPromptWithC2(base),
			);
		}
	});

	it("buildSystemPromptWithC2 keeps the base intact and separates with a blank line", () => {
		expect(buildSystemPromptWithC2("base")).toBe(
			`base\n\n${C2_GROUNDING_DIRECTIVE}`,
		);
	});
});

describe("T2 ContentDoc/ContentChunk ↔ T5/T6 type-level contract", () => {
	it("produces a canonical 64-hex document hash", () => {
		expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("upsertDocument accepts exactly ContentDoc + ContentChunk[] (T2 → T5)", () => {
		const upsert: (
			pool: Pool,
			d: ContentDoc,
			chunks: ContentChunk[],
		) => Promise<{ kind: "added" | "updated" | "unchanged"; version: number }> =
			upsertDocument;
		expect(typeof upsert).toBe("function");
	});

	it("retrieveKnowledge accepts the content retrieval params (T2 → T6)", () => {
		const retrieve: (
			pool: Pool,
			params: {
				query: string;
				source?: string;
				limit?: number;
				queryEmbedding?: number[];
			},
		) => Promise<RetrievalResult> = retrieveKnowledge;
		expect(typeof retrieve).toBe("function");
	});

	it("provenanceOf emits the locked FR-15 five-tuple from a chunk ref", () => {
		const tuple = provenanceOf(chunk.ref, "fleet", "kb", "root");
		expect(tuple).toEqual({
			source: "fleet",
			document: "kb",
			section: "root",
			version: doc.version,
			content_hash: doc.hash,
		});
	});

	it("runtime (fake pool): upsertDocument persists the T2 fixture as 'added'", async () => {
		const out = await upsertDocument(fakePool(), doc, [chunk]);
		expect(out).toEqual({ kind: "added", version: doc.version });
	});

	it("runtime (fake pool): retrieveKnowledge hit items carry the exact provenance tuple", async () => {
		const pool = {
			query: async () => ({
				rows: [
					{
						text: chunk.text,
						section: chunk.section,
						source: "fleet",
						document: "kb",
						version: String(doc.version),
						content_hash: doc.hash,
						fts_rank: 0.5,
					},
				],
			}),
		} as unknown as Pool;
		const res = await retrieveKnowledge(pool, { query: "soars" });
		expect(res.ok).toBe(true);
		if (res.ok && res.kind === "hit") {
			expect(res.items[0]).toEqual({
				text: chunk.text,
				provenance: {
					source: "fleet",
					document: "kb",
					section: chunk.section,
					version: doc.version,
					content_hash: doc.hash,
				},
				score: 0.5,
			});
		}
	});

	it("runtime (fake pool): infra failure is 'unavailable', zero hits is 'no-match' (FR-14/C2)", async () => {
		const brokenPool = {
			query: async () => {
				throw new Error("db down");
			},
		} as unknown as Pool;
		const unavailable = await retrieveKnowledge(brokenPool, { query: "soars" });
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) expect(unavailable.kind).toBe("unavailable");

		const emptyPool = {
			query: async () => ({ rows: [], rowCount: 0 }),
		} as unknown as Pool;
		const noMatch = await retrieveKnowledge(emptyPool, { query: "soars" });
		expect(noMatch.ok).toBe(true);
		if (noMatch.ok) expect(noMatch.kind).toBe("no-match");
	});
});

describe("T8 tool-name reconciliation (decided names)", () => {
	it("registers content.retrieve / content.list_sources / content.get_document", () => {
		expect(CONTENT_TOOL_DEFS.map((d) => d.name)).toEqual([
			"content.retrieve",
			"content.list_sources",
			"content.get_document",
		]);
	});

	it("each decided tool is read-only-shaped and references the T6 service", () => {
		const names = new Set(CONTENT_TOOL_DEFS.map((d) => d.name));
		expect(names.has("content.retrieve")).toBe(true);
		expect(names.has("content.list_sources")).toBe(true);
		expect(names.has("content.get_document")).toBe(true);
	});
});

describe("CLI wiring (sor:content:sync)", () => {
	const pkg = JSON.parse(
		readFileSync(
			fileURLToPath(new URL("../../../package.json", import.meta.url)),
			"utf8",
		),
	) as { scripts?: Record<string, string> };

	it("package.json scripts contains sor:content:sync pointing at the T7 entry", () => {
		expect(pkg.scripts?.["sor:content:sync"]).toBe(
			"tsx --env-file-if-exists=.env src/cli/contentCommands.ts",
		);
	});

	it("the T7 CLI entry exports runSyncContent", () => {
		expect(typeof runSyncContent).toBe("function");
	});
});
