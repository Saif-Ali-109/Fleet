// Unit tests for the `sor:context` CLI command (C5, Phase 4).
// Recording-pool style — NO real DB. All I/O faked; audit append chain-row
// special-cased for the FOR UPDATE tail read.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContextCli } from "../cli/contextCommands.ts";
import { putContext } from "../fleet/contextStore.ts";
import { GENESIS_HASH } from "../sor/signer.ts";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

type Responder = (
	text: string,
	values?: unknown[],
) => { rows: unknown[] } | undefined;

function makePool(
	responder?: Responder,
): { pool: Pool; queries: RecordedQuery[] } {
	const queries: RecordedQuery[] = [];
	const respond = async (...args: unknown[]) => {
		const text =
			typeof args[0] === "string"
				? args[0]
				: ((args[0] as { text: string }).text ?? "");
		const values =
			typeof args[0] === "string"
				? (args[1] as unknown[] | undefined)
				: undefined;
		queries.push({ text, values });
		const hit = responder?.(text, values);
		if (hit) return hit;
		if (text.includes("FOR UPDATE")) {
			return { rows: [{ seq: "0", hash: GENESIS_HASH, key_id: "v1" }] };
		}
		return { rows: [] };
	};
	return {
		pool: {
			query: respond,
			connect: async () => ({ query: respond, release: () => {} }),
		} as unknown as Pool,
		queries,
	};
}

const ORG_SOURCE_ID = "fleet|org-constraints";
const ORG = {
	allowedGitHosts: ["github.com"],
	pushPolicy: "deny",
	worktreeOwnership: "fleet",
};

const KEY = "context-cli-test-key";
let savedSigning: string | undefined;
let savedV1: string | undefined;
let savedKeyId: string | undefined;

beforeEach(() => {
	savedSigning = process.env.SOR_SIGNING_KEY;
	savedV1 = process.env.SOR_KEY_V1;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = KEY;
	process.env.SOR_KEY_V1 = KEY;
	process.env.SOR_KEY_ID = "v1";
});

afterEach(() => {
	if (savedSigning === undefined) {
		delete process.env.SOR_SIGNING_KEY;
		delete process.env.SOR_KEY_V1;
	} else {
		process.env.SOR_SIGNING_KEY = savedSigning;
		process.env.SOR_KEY_V1 = savedV1;
	}
	if (savedKeyId === undefined) {
		delete process.env.SOR_KEY_ID;
	} else {
		process.env.SOR_KEY_ID = savedKeyId;
	}
});

const ctxInserts = (q: RecordedQuery[]) =>
	q.filter((x) => x.text.includes("INSERT INTO context_sor"));
const auditAppends = (q: RecordedQuery[]) =>
	q.filter((x) => x.text.includes("INSERT INTO audit_events"));
const linesOf = (lines: string[]) => lines.join("\n");

describe("sor:context seed-org", () => {
	it("reads a temp JSON file, writes org-constraints as manager and emits context_update with prevVersion", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ctxcli-"));
		const file = join(dir, "org.json");
		await writeFile(file, JSON.stringify(ORG));
		try {
			const { pool, queries } = makePool();
			const lines: string[] = [];
			const res = await runContextCli({
				pool,
				argv: ["seed-org", file],
				log: (l) => lines.push(l),
			});
			expect(res.ok).toBe(true);

			const inserts = ctxInserts(queries);
			expect(inserts.length).toBe(1);
			const row = inserts[0];
			// $1 source_id, $2 namespace, $3 version, $4 hash, $5 category,
			// $6 operational_state, $7 fresh_until, $8 stale_after, $9 status, $10 created_at
			expect(row?.values?.[0]).toBe(ORG_SOURCE_ID);
			expect(row?.values?.[1]).toBe("fleet");
			expect(row?.values?.[2]).toBe(1);
			expect(row?.values?.[4]).toBe("org-constraints");
			expect(JSON.parse(row?.values?.[5] as string)).toEqual(ORG);

			const audit = auditAppends(queries);
			expect(audit.length).toBe(1);
			const payload = audit[0]?.values?.[8] as Record<string, unknown>;
			expect(payload.event_type ?? payload.sorType).toBeTruthy();
			expect(payload.sorType).toBe("context");
			expect(payload.sourceId).toBe(ORG_SOURCE_ID);
			expect(payload.actor).toBe("manager");
			expect(payload.prevVersion).toBe(0);

			expect(linesOf(lines)).toContain("added");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a missing file with {ok:false} and no DB write", async () => {
		const { pool, queries } = makePool();
		const res = await runContextCli({
			pool,
			argv: ["seed-org", join(tmpdir(), "no-such-org.json")],
			log: () => {},
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("cannot read");
		expect(ctxInserts(queries).length).toBe(0);
		expect(auditAppends(queries).length).toBe(0);
	});

	it("rejects malformed JSON with {ok:false} and no DB write", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ctxcli-"));
		const file = join(dir, "bad.json");
		await writeFile(file, "{ this is not json");
		try {
			const { pool, queries } = makePool();
			const res = await runContextCli({
				pool,
				argv: ["seed-org", file],
				log: () => {},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toContain("invalid JSON");
			expect(ctxInserts(queries).length).toBe(0);
			expect(auditAppends(queries).length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a schema-invalid payload with {ok:false} and no DB write", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ctxcli-"));
		const file = join(dir, "bad-schema.json");
		await writeFile(
			file,
			JSON.stringify({ allowedGitHosts: "not-an-array", pushPolicy: "maybe" }),
		);
		try {
			const { pool, queries } = makePool();
			const res = await runContextCli({
				pool,
				argv: ["seed-org", file],
				log: () => {},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toContain("malformed org-constraints");
			expect(ctxInserts(queries).length).toBe(0);
			expect(auditAppends(queries).length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("requires a file argument", async () => {
		const { pool } = makePool();
		const res = await runContextCli({ pool, argv: ["seed-org"], log: () => {} });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("requires <file>");
	});
});

describe("sor:context show", () => {
	it("prints state + fresh + staleAfter on a hit", async () => {
		const { pool } = makePool((text) =>
			text.includes("FROM context_sor")
				? {
						rows: [
							{
								source_id: ORG_SOURCE_ID,
								category: "org-constraints",
								version: 1,
								hash: "abc",
								operational_state: ORG,
								fresh_until: "2099-01-01T00:00:00.000Z",
								stale_after: "2099-01-02T00:00:00.000Z",
								status: "active",
								created_at: "2026-01-01T00:00:00.000Z",
							},
						],
					}
				: undefined,
		);
		const lines: string[] = [];
		const res = await runContextCli({
			pool,
			argv: ["show"],
			log: (l) => lines.push(l),
		});
		expect(res.ok).toBe(true);
		expect(linesOf(lines)).toContain("fresh: true");
		expect(linesOf(lines)).toContain("staleAfter:");
		expect(linesOf(lines)).toContain("state:");
	});

	it("returns {ok:false} reason 'not found' when no row", async () => {
		const { pool } = makePool();
		const res = await runContextCli({ pool, argv: ["show"], log: () => {} });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not found");
	});

	it("reads a specific sourceId when provided", async () => {
		const { pool, queries } = makePool((text, values) =>
			text.includes("FROM context_sor") && values?.[1] === "fleet|other"
				? {
						rows: [
							{
								source_id: "fleet|other",
								category: "org-constraints",
								version: 2,
								hash: "x",
								operational_state: { allowedGitHosts: [], pushPolicy: "allow", worktreeOwnership: "fleet" },
								fresh_until: null,
								stale_after: null,
								status: "active",
								created_at: "2026-02-01T00:00:00.000Z",
							},
						],
					}
				: undefined,
		);
		const lines: string[] = [];
		const res = await runContextCli({
			pool,
			argv: ["show", "fleet|other"],
			log: (l) => lines.push(l),
		});
		expect(res.ok).toBe(true);
		expect(linesOf(lines)).toContain("state:");
		expect(queries.some((q) => q.text.includes("AND source_id"))).toBe(true);
	});
});

describe("sor:context list", () => {
	it("prints one line per source", async () => {
		const { pool } = makePool((text) =>
			text.includes("FROM context_sor")
				? {
						rows: [
							{
								source_id: ORG_SOURCE_ID,
								category: "org-constraints",
								version: 1,
								status: "active",
							},
							{
								source_id: "fleet|run|abc",
								category: "run",
								version: 3,
								status: "active",
							},
						],
					}
				: undefined,
		);
		const lines: string[] = [];
		const res = await runContextCli({
			pool,
			argv: ["list"],
			log: (l) => lines.push(l),
		});
		expect(res.ok).toBe(true);
		expect(linesOf(lines)).toContain(
			`${ORG_SOURCE_ID} | org-constraints | 1 | active`,
		);
		expect(linesOf(lines)).toContain("fleet|run|abc | run | 3 | active");
	});

	it("filters by category when supplied", async () => {
		const { pool, queries } = makePool((text, values) =>
			text.includes("FROM context_sor") && values?.[0] === "org-constraints"
				? {
						rows: [
							{
								source_id: ORG_SOURCE_ID,
								category: "org-constraints",
								version: 1,
								status: "active",
							},
						],
					}
				: text.includes("FROM context_sor")
					? { rows: [] }
					: undefined,
		);
		const lines: string[] = [];
		const res = await runContextCli({
			pool,
			argv: ["list", "org-constraints"],
			log: (l) => lines.push(l),
		});
		expect(res.ok).toBe(true);
		expect(linesOf(lines)).toContain(
			`${ORG_SOURCE_ID} | org-constraints | 1 | active`,
		);
		expect(queries.some((q) => q.text.includes("category = $1"))).toBe(true);
	});
});

describe("sor:context usage & dispatch", () => {
	it("prints usage on --help and no subcommand", async () => {
		for (const argv of [[], ["--help"], ["-h"]]) {
			const { pool } = makePool();
			const lines: string[] = [];
			const res = await runContextCli({
				pool,
				argv,
				log: (l) => lines.push(l),
			});
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.detail).toContain("usage: sor:context");
			expect(linesOf(lines)).toContain("seed-org");
			expect(linesOf(lines)).toContain("show");
			expect(linesOf(lines)).toContain("list");
		}
	});

	it("returns {ok:false} for an unknown subcommand", async () => {
		const { pool } = makePool();
		const res = await runContextCli({
			pool,
			argv: ["frobnicate"],
			log: () => {},
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("unknown subcommand");
	});
});

describe("agent-rejection surfacing", () => {
	it("the service rejects an agent writer directly", async () => {
		const { pool } = makePool();
		const res = await putContext(pool, {
			sourceId: ORG_SOURCE_ID,
			category: "org-constraints",
			state: ORG,
			actor: "agent",
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("agents cannot write context");
	});

	it("sor:context always provisions as manager (never rejected as agent)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ctxcli-"));
		const file = join(dir, "org.json");
		await writeFile(file, JSON.stringify(ORG));
		try {
			const { pool, queries } = makePool();
			const res = await runContextCli({
				pool,
				argv: ["seed-org", file],
				log: () => {},
			});
			expect(res.ok).toBe(true);
			// The audit context_update event carried actor "manager", which only
			// happens when putContext was called with the manager actor.
			const audit = auditAppends(queries).at(-1);
			const payload = audit?.values?.[8] as Record<string, unknown>;
			expect(payload?.actor).toBe("manager");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
