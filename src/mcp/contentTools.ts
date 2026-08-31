// Fleet Content SoR — read-only MCP tool definitions + C2 grounding wiring seam.
// PURE read-only tools: they call only the manager-side retrieval service
// (src/fleet/contentRetrieval.ts) and NEVER write to SOR or issue SQL DML.
// Also exports buildSystemPromptWithC2 (append C2 directive to a worker systemPrompt).

import type { Pool } from "pg";
import {
	getDocument,
	listSources,
	retrieveKnowledge,
	emitContentAccessAggregate,
	type GetDocumentResult,
	type ListSourcesResult,
	type RetrievalResult,
} from "../fleet/contentRetrieval.ts";
import { C2_GROUNDING_DIRECTIVE } from "../fleet/c2Directive.ts";

export interface ContentRetrieveArgs {
	query: string;
	source?: string;
	limit?: number;
}

export interface ContentGetDocumentArgs {
	source: string;
	document: string;
	section?: string;
	version?: number;
}

export interface ContentToolContext {
	sessionId?: string;
}

export interface ContentRetrieveHit {
	kind: "hit";
	items: { text: string; provenance: { source: string; document: string; section: string; version: number; content_hash: string } }[];
}

export type ContentRetrieveToolResult =
	| ContentRetrieveHit
	| { kind: "no-match"; message: string }
	| { kind: "unavailable"; message: string; error: string };

export type ContentGetDocumentToolResult =
	| { kind: "hit"; document: { text: string; provenance: { source: string; document: string; section: string; version: number; content_hash: string } } }
	| { kind: "not-found"; message: string }
	| { kind: "unavailable"; message: string; error: string };

export interface ContentListSourcesToolResult {
	sources: ListSourcesResult[];
}

// MCP tool-definition shape mirrors src/mcp/fleetServer.ts / server.ts
// (ListToolsRequestSchema tool entries: name + description + inputSchema).
export const CONTENT_TOOL_DEFS = [
	{
		name: "content.retrieve",
		description: "Retrieve authoritative Content SoR knowledge with mandatory provenance.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				source: { type: "string" },
				limit: { type: "number" },
			},
			required: ["query"],
		} as const,
	},
	{
		name: "content.list_sources",
		description: "List authoritative Content SoR sources and document versions.",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		} as const,
	},
	{
		name: "content.get_document",
		description: "Get an authoritative Content SoR document with full provenance.",
		inputSchema: {
			type: "object",
			properties: {
				source: { type: "string" },
				document: { type: "string" },
				section: { type: "string" },
				version: { type: "number" },
			},
			required: ["source", "document"],
		} as const,
	},
];

function isValidObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Fail closed: unknown/extra args are rejected so no write-typed or unexpected
// field can ever leak through these read-only handlers.
function rejectUnknownArgs(
	tool: string,
	args: unknown,
	allowed: string[],
): asserts args is Record<string, unknown> {
	if (!isValidObject(args)) {
		throw new Error(`Tool ${tool}: arguments must be an object`);
	}
	for (const key of Object.keys(args)) {
		if (!allowed.includes(key)) {
			throw new Error(`Tool ${tool}: unknown argument '${key}'`);
		}
	}
}

function reqString(
	v: unknown,
	key: string,
	tool: string,
): string {
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`Tool ${tool}: missing or invalid string argument '${key}'`);
	}
	return v;
}

function optString(
	v: unknown,
	key: string,
	tool: string,
): string | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new Error(`Tool ${tool}: invalid string argument '${key}'`);
	}
	return v;
}

function optNumber(
	v: unknown,
	key: string,
	tool: string,
): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "number" || Number.isNaN(v)) {
		throw new Error(`Tool ${tool}: invalid number argument '${key}'`);
	}
	return v;
}

function noMatchMessage(query: string): string {
	return `no authoritative content found for "${query}"`;
}

function emitPercallAccess(
	pool: Pool,
	sessionId: string | undefined,
	items: { provenance: { source: string } }[],
): void {
	// content_access evidence boundary (spec §10.9): per-call opt-in mode.
	// NON-FATAL: emitContentAccessAggregate warns and never throws.
	const topSources = [...new Set(items.map((i) => i.provenance.source))];
	emitContentAccessAggregate(pool, {
		sessionId: sessionId ?? "unspecified",
		mode: "percall",
		count: items.length,
		topSources,
	});
}

export async function handleContentRetrieve(
	pool: Pool,
	args: unknown,
	ctx?: ContentToolContext,
): Promise<ContentRetrieveToolResult> {
	rejectUnknownArgs("content.retrieve", args, ["query", "source", "limit"]);
	const query = reqString(args.query, "query", "content.retrieve");
	const source = optString(args.source, "source", "content.retrieve");
	const limit = optNumber(args.limit, "limit", "content.retrieve");

	const result: RetrievalResult = await retrieveKnowledge(pool, {
		query,
		...(source !== undefined ? { source } : {}),
		...(limit !== undefined ? { limit } : {}),
	});

	if (!result.ok) {
		return {
			kind: "unavailable",
			message: "knowledge source unavailable",
			error: result.error,
		};
	}
	if (result.kind === "no-match") {
		emitPercallAccess(pool, ctx?.sessionId, []);
		return { kind: "no-match", message: noMatchMessage(result.query) };
	}

	const items = result.items.map((i) => ({
		text: i.text,
		provenance: i.provenance,
	}));
	emitPercallAccess(pool, ctx?.sessionId, result.items);
	return { kind: "hit", items };
}

export async function handleContentListSources(
	pool: Pool,
	args: unknown,
): Promise<ContentListSourcesToolResult> {
	rejectUnknownArgs("content.list_sources", args, []);
	return { sources: await listSources(pool) };
}

export async function handleContentGetDocument(
	pool: Pool,
	args: unknown,
): Promise<ContentGetDocumentToolResult> {
	rejectUnknownArgs("content.get_document", args, [
		"source",
		"document",
		"section",
		"version",
	]);
	const source = reqString(args.source, "source", "content.get_document");
	const document = reqString(args.document, "document", "content.get_document");
	const section = optString(args.section, "section", "content.get_document");
	const version = optNumber(args.version, "version", "content.get_document");

	const result: GetDocumentResult = await getDocument(pool, {
		source,
		document,
		...(section !== undefined ? { section } : {}),
		...(version !== undefined ? { version } : {}),
	});

	if (!result.ok) {
		if (result.kind === "not-found") {
			return { kind: "not-found", message: "no authoritative content found" };
		}
		return {
			kind: "unavailable",
			message: "knowledge source unavailable",
			error: result.error ?? "",
		};
	}
	return {
		kind: "hit",
		document: { text: result.item.text, provenance: result.item.provenance },
	};
}

// C2 grounding directive seam (spec §10.7). Append the directive to a worker
// systemPrompt for Content SoR consumers. The physical append into the worker
// prompt assembly (src/runtime/worker/main.ts, near injectSkills) is owned by
// Wave D (T9) per plan-sor PART G4 — this helper is the testable wiring seam.
export function buildSystemPromptWithC2(base: string): string {
	return `${base}\n\n${C2_GROUNDING_DIRECTIVE}`;
}
