// Fleet Context SoR — CLI command `sor:context`.
// Org-constraint provisioning + context reads. Manager-only write path (§11.5):
// seed-org always writes with actor "manager"; agents never write. No model calls.

import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { putContext } from "../fleet/contextStore.ts";
import {
	getContext,
	getOrgConstraints,
	listContexts,
} from "../fleet/contextRetrieval.ts";
import type { ContextCategory } from "../fleet/context.ts";

export interface OrgConstraints {
	allowedGitHosts: string[];
	pushPolicy: "allow" | "deny";
	worktreeOwnership: string;
}

export type ContextCliResult = {
	ok: boolean;
	detail?: string;
	reason?: string;
};

const ORG_SOURCE_ID = "fleet|org-constraints";

const USAGE = `usage: sor:context <subcommand>

subcommands:
  seed-org <file>      provision org-level action constraints from a JSON file
                       (e.g. { allowedGitHosts: string[], pushPolicy: "allow"|"deny", worktreeOwnership: string })
  show [sourceId]      print the latest context state + freshness (default org-constraints)
  list [category]      list context sources as 'sourceId | category | version | status'
  --help               show this usage
`;

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate an org-constraints payload against the §11.2 shape. Returns null when valid. */
function validateOrgConstraints(raw: unknown): string | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return "malformed org-constraints: expected an object";
	}
	const v = raw as Record<string, unknown>;
	if (
		!Object.prototype.hasOwnProperty.call(v, "allowedGitHosts") ||
		!isStringArray(v.allowedGitHosts)
	) {
		return "malformed org-constraints: allowedGitHosts must be a string[]";
	}
	if (
		!Object.prototype.hasOwnProperty.call(v, "pushPolicy") ||
		(v.pushPolicy !== "allow" && v.pushPolicy !== "deny")
	) {
		return "malformed org-constraints: pushPolicy must be \"allow\" | \"deny\"";
	}
	if (
		!Object.prototype.hasOwnProperty.call(v, "worktreeOwnership") ||
		typeof v.worktreeOwnership !== "string"
	) {
		return "malformed org-constraints: worktreeOwnership must be a string";
	}
	return null;
}

async function seedOrg(pool: Pool, file: string, log: (l: string) => void): Promise<ContextCliResult> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		return {
			ok: false,
			reason: `cannot read org-constraints file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			ok: false,
			reason: `invalid JSON in org-constraints file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const malformed = validateOrgConstraints(raw);
	if (malformed !== null) {
		return { ok: false, reason: malformed };
	}

	const result = await putContext(pool, {
		sourceId: ORG_SOURCE_ID,
		category: "org-constraints",
		state: raw as OrgConstraints,
		actor: "manager",
	});
	if (!result.ok) {
		return { ok: false, reason: result.reason };
	}
	log(
		`[sor:context] seeded org-constraints (${ORG_SOURCE_ID}) -> ${result.kind} v${result.version}`,
	);
	return {
		ok: true,
		detail: `org-constraints ${result.kind} as v${result.version}`,
	};
}

async function show(pool: Pool, sourceId: string | undefined, log: (l: string) => void): Promise<ContextCliResult> {
	const result =
		sourceId === undefined
			? await getOrgConstraints(pool)
			: await getContext(pool, { sourceId, category: "org-constraints" });

	if (!result.ok) {
		if (result.kind === "not-found") {
			return { ok: false, reason: "not found" };
		}
		return { ok: false, reason: result.error ?? "unavailable" };
	}

	log(`state: ${JSON.stringify(result.item.state)}`);
	log(`fresh: ${result.item.fresh}`);
	log(`staleAfter: ${result.item.staleAfter}`);
	return {
		ok: true,
		detail: `state=${JSON.stringify(result.item.state)} fresh=${result.item.fresh} staleAfter=${result.item.staleAfter}`,
	};
}

async function list(pool: Pool, category: ContextCategory | undefined, log: (l: string) => void): Promise<ContextCliResult> {
	const result = await listContexts(pool, category === undefined ? undefined : { category });
	if (!result.ok) {
		return { ok: false, reason: result.error };
	}
	if (result.items.length === 0) {
		log("(no context sources)");
		return { ok: true, detail: "no context sources" };
	}
	for (const item of result.items) {
		log(`${item.sourceId} | ${item.category} | ${item.version} | ${item.status}`);
	}
	return {
		ok: true,
		detail: `listed ${result.items.length} context source(s)`,
	};
}

/** Subcommand dispatcher for `sor:context`. Never writes as actor "agent" (§FR-17). */
export async function runContextCli(opts: {
	pool: Pool;
	argv: string[];
	log?: (line: string) => void;
}): Promise<ContextCliResult> {
	const log = opts.log ?? ((line: string) => console.log(line));
	const args = opts.argv;
	const sub = args[0];

	if (sub === undefined || sub === "--help" || sub === "-h") {
		log(USAGE.trimEnd());
		return { ok: true, detail: USAGE };
	}

	switch (sub) {
		case "seed-org": {
			const file = args[1];
			if (file === undefined) {
				return { ok: false, reason: "seed-org requires <file>" };
			}
			return await seedOrg(opts.pool, file, log);
		}
		case "show":
			return await show(opts.pool, args[1], log);
		case "list": {
			const cat = args[1];
			if (cat !== undefined && cat !== "org-constraints" && cat !== "run") {
				return { ok: false, reason: `unknown category: ${cat}` };
			}
			return await list(opts.pool, cat as ContextCategory | undefined, log);
		}
		default:
			return { ok: false, reason: "unknown subcommand" };
	}
}

async function main(): Promise<void> {
	let code = 0;
	try {
		const { pool } = await import("../db/client.ts");
		const result = await runContextCli({
			pool,
			argv: process.argv.slice(2),
		});
		if (!result.ok) {
			console.error(`[sor:context] ${result.reason ?? "failed"}`);
			code = 1;
		}
		await pool.end();
	} catch (err) {
		console.error(
			"[sor:context] failed:",
			err instanceof Error ? err.message : String(err),
		);
		code = 1;
	}
	process.exitCode = code;
}

const isEntry =
	process.argv[1] &&
	import.meta.url === new URL("file://" + process.argv[1]).href;

if (isEntry) {
	main();
}
