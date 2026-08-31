// Unit tests for read-only MCP content tools + C2 grounding wiring seam.
// No real DB, no model calls — contentRetrieval.ts is vi.mocked.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C2_GROUNDING_DIRECTIVE } from "../c2Directive.ts";

const mocks = vi.hoisted(() => ({
	retrieveKnowledge: vi.fn(),
	listSources: vi.fn(),
	getDocument: vi.fn(),
	emitContentAccessAggregate: vi.fn(),
}));

vi.mock("../contentRetrieval.ts", () => ({
	retrieveKnowledge: mocks.retrieveKnowledge,
	listSources: mocks.listSources,
	getDocument: mocks.getDocument,
	emitContentAccessAggregate: mocks.emitContentAccessAggregate,
}));

import {
	CONTENT_TOOL_DEFS,
	buildSystemPromptWithC2,
	handleContentGetDocument,
	handleContentListSources,
	handleContentRetrieve,
} from "../../mcp/contentTools.ts";

const pool = {} as Pool;

beforeEach(() => {
	mocks.retrieveKnowledge.mockReset();
	mocks.listSources.mockReset();
	mocks.getDocument.mockReset();
	mocks.emitContentAccessAggregate.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tool registration shape", () => {
	it("registers exactly the three read-only content tools", () => {
		expect(CONTENT_TOOL_DEFS.map((d) => d.name)).toEqual([
			"content.retrieve",
			"content.list_sources",
			"content.get_document",
		]);
	});

	it("content.retrieve requires only 'query'", () => {
		const def = CONTENT_TOOL_DEFS.find((d) => d.name === "content.retrieve")!;
		expect(def.inputSchema.required).toEqual(["query"]);
		expect((def.inputSchema.properties as any)?.query?.type).toBe("string");
	});

	it("content.get_document requires source+document and is read-only-shaped", () => {
		const def = CONTENT_TOOL_DEFS.find((d) => d.name === "content.get_document")!;
		expect(def.inputSchema.required).toEqual(["source", "document"]);
		const props = def.inputSchema.properties as Record<string, any>;
		expect(props.source.type).toBe("string");
		expect(props.document.type).toBe("string");
		expect(props.section.type).toBe("string");
		expect(props.version.type).toBe("number");
		// No write-related fields are exposed (read-only tools only).
		expect(Object.keys(props).sort()).toEqual([
			"document",
			"section",
			"source",
			"version",
		]);
	});
});

describe("content.retrieve handler", () => {
	it("maps hit items to { text, provenance } and emits percall content_access", async () => {
		mocks.retrieveKnowledge.mockResolvedValue({
			ok: true,
			kind: "hit",
			items: [
				{
					text: "chunk a",
					provenance: {
						source: "fleet",
						document: "guide",
						section: "Intro",
						version: 2,
						content_hash: "hash-a",
					},
					score: 0.8,
				},
			],
		});

		const result = await handleContentRetrieve(pool, { query: "question" }, { sessionId: "sess-1" });

		expect(result.kind).toBe("hit");
		if (result.kind === "hit") {
			expect(result.items).toEqual([
				{
					text: "chunk a",
					provenance: {
						source: "fleet",
						document: "guide",
						section: "Intro",
						version: 2,
						content_hash: "hash-a",
					},
				},
			]);
		}

		expect(mocks.retrieveKnowledge).toHaveBeenCalledWith(pool, {
			query: "question",
		});
		expect(mocks.emitContentAccessAggregate).toHaveBeenCalledTimes(1);
		const [emittedPool, params] = mocks.emitContentAccessAggregate.mock.calls[0]!;
		expect(emittedPool).toBe(pool);
		expect(params).toMatchObject({
			sessionId: "sess-1",
			mode: "percall",
			count: 1,
			topSources: ["fleet"],
		});
	});

	it("maps no-match to the C2-correct message and emits zero-count access", async () => {
		mocks.retrieveKnowledge.mockResolvedValue({
			ok: true,
			kind: "no-match",
			query: "something rare",
		});

		const result = await handleContentRetrieve(pool, { query: "something rare" }, { sessionId: "sess-2" });

		expect(result).toEqual({
			kind: "no-match",
			message: 'no authoritative content found for "something rare"',
		});
		expect(mocks.emitContentAccessAggregate).toHaveBeenCalledWith(
			pool,
			expect.objectContaining({ mode: "percall", count: 0, sessionId: "sess-2" }),
		);
	});

	it("maps unavailable to the source-unavailable message with error detail", async () => {
		mocks.retrieveKnowledge.mockResolvedValue({
			ok: false,
			kind: "unavailable",
			error: "connection refused",
		});

		const result = await handleContentRetrieve(pool, { query: "x" });

		expect(result).toEqual({
			kind: "unavailable",
			message: "knowledge source unavailable",
			error: "connection refused",
		});
		expect(mocks.emitContentAccessAggregate).not.toHaveBeenCalled();
	});

	it("rejects unknown (write-typed) arguments — read-only fail-closed", async () => {
		await expect(
			handleContentRetrieve(pool, { query: "x", write: true }),
		).rejects.toThrow("unknown argument 'write'");
		expect(mocks.retrieveKnowledge).not.toHaveBeenCalled();
	});

	it("passes source and limit through when provided", async () => {
		mocks.retrieveKnowledge.mockResolvedValue({ ok: true, kind: "no-match", query: "x" });
		await handleContentRetrieve(pool, { query: "x", source: "fleet", limit: 3 });
		expect(mocks.retrieveKnowledge).toHaveBeenCalledWith(pool, {
			query: "x",
			source: "fleet",
			limit: 3,
		});
	});
});

describe("content.list_sources handler", () => {
	it("returns { sources } from listSources", async () => {
		mocks.listSources.mockResolvedValue([
			{ source: "fleet", document: "guide", version: 2, status: "active" },
		]);

		const result = await handleContentListSources(pool, {});

		expect(result).toEqual({
			sources: [{ source: "fleet", document: "guide", version: 2, status: "active" }],
		});
		expect(mocks.listSources).toHaveBeenCalledWith(pool);
	});

	it("rejects any arguments (read-only, no write surface)", async () => {
		await expect(
			handleContentListSources(pool, { source: "fleet" }),
		).rejects.toThrow("unknown argument 'source'");
		expect(mocks.listSources).not.toHaveBeenCalled();
	});
});

describe("content.get_document handler", () => {
	it("returns full provenance on hit", async () => {
		mocks.getDocument.mockResolvedValue({
			ok: true,
			item: {
				text: "doc content",
				provenance: {
					source: "fleet",
					document: "api",
					section: "Reference",
					version: 1,
					content_hash: "dochash",
				},
				score: 1.0,
			},
		});

		const result = await handleContentGetDocument(pool, {
			source: "fleet",
			document: "api",
		});

		expect(result).toEqual({
			kind: "hit",
			document: {
				text: "doc content",
				provenance: {
					source: "fleet",
					document: "api",
					section: "Reference",
					version: 1,
					content_hash: "dochash",
				},
			},
		});
		expect(mocks.getDocument).toHaveBeenCalledWith(pool, {
			source: "fleet",
			document: "api",
		});
	});

	it("maps not-found to 'no authoritative content found' style", async () => {
		mocks.getDocument.mockResolvedValue({ ok: false, kind: "not-found" });

		const result = await handleContentGetDocument(pool, {
			source: "fleet",
			document: "nonexistent",
		});

		expect(result).toEqual({
			kind: "not-found",
			message: "no authoritative content found",
		});
	});

	it("maps unavailable to source-unavailable style with error detail", async () => {
		mocks.getDocument.mockResolvedValue({
			ok: false,
			kind: "unavailable",
			error: "pool down",
		});

		const result = await handleContentGetDocument(pool, {
			source: "fleet",
			document: "api",
		});

		expect(result).toEqual({
			kind: "unavailable",
			message: "knowledge source unavailable",
			error: "pool down",
		});
	});

	it("passes section and version through", async () => {
		mocks.getDocument.mockResolvedValue({ ok: false, kind: "not-found" });
		await handleContentGetDocument(pool, {
			source: "fleet",
			document: "api",
			section: "Reference",
			version: 2,
		});
		expect(mocks.getDocument).toHaveBeenCalledWith(pool, {
			source: "fleet",
			document: "api",
			section: "Reference",
			version: 2,
		});
	});
});

describe("buildSystemPromptWithC2", () => {
	it("appends the C2 grounding directive to the base and separates with blank line", () => {
		const base = "You are a coding agent.";
		const out = buildSystemPromptWithC2(base);
		expect(out).toBe(`${base}\n\n${C2_GROUNDING_DIRECTIVE}`);
	});

	it("includes the directive markers (unavailable ≠ no-match, provenance tuple)", () => {
		const out = buildSystemPromptWithC2("base");
		expect(out).toContain("knowledge source unavailable");
		expect(out).toContain("no authoritative content found");
		expect(out).toContain("content_hash");
		expect(out).toContain("provenance");
	});
});
