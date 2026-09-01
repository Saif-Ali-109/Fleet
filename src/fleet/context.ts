import { sha256Hex, canonicalizeText } from "../sor/kernel/hash.ts";
import { freshnessOf } from "../sor/kernel/provenance.ts";

export type ContextCategory = "run" | "org-constraints";

export interface ContextDoc {
	sorType: "context";
	sourceId: string;
	namespace: "fleet";
	version: number;
	hash: string;
	category: ContextCategory;
	state: unknown;
	freshUntil?: string;
	staleAfter?: string;
	status: "active" | "superseded";
}

export type ContextReadResult =
	| { ok: true; item: { state: unknown; fresh: boolean; staleAfter: string; version: number } }
	| { ok: false; kind: "not-found" | "unavailable"; error?: string };

const BASE_TTL_HOURS = 24;
const MS_PER_HOUR = 3600_000;

const CATEGORY_ENV_KEYS: Record<ContextCategory, string> = {
	run: "CONTEXT_TTL_RUN_HOURS",
	"org-constraints": "CONTEXT_TTL_ORG_HOURS",
};

function parsePositiveNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return n;
}

export function baseTtlMs(env?: NodeJS.ProcessEnv): number {
	const hours = parsePositiveNumber(env?.CONTEXT_TTL_HOURS) ?? BASE_TTL_HOURS;
	return hours * MS_PER_HOUR;
}

export function ttlForCategory(category: ContextCategory, env?: NodeJS.ProcessEnv): number {
	const baseMs = baseTtlMs(env);
	const hours = parsePositiveNumber(env?.[CATEGORY_ENV_KEYS[category]]);
	return hours === undefined ? baseMs : hours * MS_PER_HOUR;
}

export function contextFreshness(
	doc: { updatedAt: string; category: ContextCategory },
	env?: NodeJS.ProcessEnv,
): ReturnType<typeof freshnessOf> {
	const ttlMs = ttlForCategory(doc.category, env);
	return freshnessOf({ updatedAt: doc.updatedAt, ttlMs });
}

export function computeContextHash(state: unknown): string {
	return sha256Hex(canonicalizeText(JSON.stringify(state)));
}
