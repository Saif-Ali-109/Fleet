// P6.1/P6.2 sor:policy CLI tests (plan-sor.md §C9) + P7.3 (AT-5 drift).
// Recording-pool style — NO real DB — mirroring src/db/__tests__/policyRegistry.test.ts.
// index.ts is imported with a pre-set `--help` argv so main() returns
// immediately; FLEET_SKIP_SHUTDOWN_HANDLERS keeps real signal handlers off.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePolicyRegistry, hashAgentDef } from "../db/audit.ts";
import { canonicalPolicyHash, capabilitySnapshot } from "../fleet/policy.ts";
import type { FleetAgentDef } from "../fleet/types.ts";
import type { SorPolicyDeps } from "../index.ts";
import { RESERVED_NAMESPACE } from "../sor/kernel/types.ts";
import { GENESIS_HASH } from "../sor/signer.ts";
import type { Role } from "../types.ts";

process.env.FLEET_SKIP_SHUTDOWN_HANDLERS = "1";
const realArgv = process.argv;
process.argv = [process.argv[0] ?? "node", "index.ts", "--help"];
const usageSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const {
	policyDefsByRole,
	runSorPolicyCli,
	sorPolicyReconcile,
	sorPolicySeed,
	sorPolicyShow,
} = await import("../index.ts");
process.argv = realArgv;
usageSpy.mockRestore();

const DEFS: Record<Role, FleetAgentDef> = policyDefsByRole;
const ROLES: Role[] = [
	"analyzer",
	"planner",
	"coder",
	"tester",
	"reviewer",
	"pr",
];

type RegistryResponder = (
	text: string,
	values?: unknown[],
) => { rows: unknown[] } | undefined;

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

function makePool(
	responder?: RegistryResponder,
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

const KEY = "policy-cli-test-key";
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

const inserts = (q: RecordedQuery[]) =>
	q.filter((x) => x.text.includes("INSERT INTO agent_registry"));
const updates = (q: RecordedQuery[]) =>
	q.filter((x) => x.text.includes("UPDATE agent_registry"));
const appends = (q: RecordedQuery[]) =>
	q.filter((x) => x.text.includes("INSERT INTO audit_events"));

describe("sor:policy seed (P6.1)", () => {
	it("creates rows once for all six roles (v1 capability snapshot) and emits policy_sync", async () => {
		const { pool, queries } = makePool();
		const res = await sorPolicySeed({ pool, defs: DEFS });
		expect(res.ok).toBe(true);

		const seeds = inserts(queries);
		expect(seeds.length).toBe(6);
		expect(
			seeds.map((s) => s.values?.[0]).sort(),
		).toEqual([...ROLES].sort());
		for (const role of ROLES) {
			const s = seeds.find((x) => x.values?.[0] === role);
			expect(s).toBeDefined();
			const doc = capabilitySnapshot(DEFS[role], role);
			// $1 role, $2 metadata, $3 rules, $4 source_hash, $5 policy_hash
			expect(s?.values?.[2]).toEqual(doc);
			expect(s?.values?.[3]).toBe(hashAgentDef(DEFS[role]));
			expect(s?.values?.[4]).toBe(canonicalPolicyHash(doc));
		}

		const syncs = appends(queries);
		expect(syncs.length).toBe(6);
		for (const sync of syncs) {
			const payload = sync.values?.[8] as Record<string, unknown>;
			expect(payload.kind).toBe("seeded");
			expect(payload.namespace).toBe(RESERVED_NAMESPACE);
			expect(payload.document).toBeDefined();
		}
	});

	it("refuses to overwrite when a role already exists — never writes", async () => {
		const { pool, queries } = makePool((text) =>
			text.includes("WHERE role = ANY($1)")
				? { rows: [{ role: "analyzer" }, { role: "coder" }] }
				: undefined,
		);
		const res = await sorPolicySeed({ pool, defs: DEFS });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toContain("refusing to overwrite");
			expect(res.reason).toContain("analyzer");
			expect(res.reason).toContain("coder");
		}
		expect(inserts(queries).length).toBe(0);
		expect(updates(queries).length).toBe(0);
		expect(appends(queries).length).toBe(0);
	});
});

describe("sor:policy reconcile (P6.1, P6.2)", () => {
	it("validates the file, bumps policy_version, updates source_hash and emits policy_sync with the document", async () => {
		const dir = await mkdtemp(join(tmpdir(), "polcli-"));
		const file = join(dir, "coder.json");
		const doc = capabilitySnapshot(DEFS.coder, "coder");
		await writeFile(file, JSON.stringify(doc, null, 2));
		try {
			const { pool, queries } = makePool((text) =>
				text.includes("SELECT policy_version")
					? { rows: [{ policy_version: 2 }] }
					: undefined,
			);
			const res = await sorPolicyReconcile(
				{ pool, defs: DEFS },
				"coder",
				file,
			);
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.detail).toContain("policy_version=3");

			const update = updates(queries)[0];
			expect(update).toBeDefined();
			// $1 role, $2 rules, $3 policy_hash, $4 policy_version, $5 source_hash
			expect(update?.values?.[0]).toBe("coder");
			expect(update?.values?.[1]).toEqual(doc);
			expect(update?.values?.[2]).toBe(canonicalPolicyHash(doc));
			expect(update?.values?.[3]).toBe(3);
			expect(update?.values?.[4]).toBe(hashAgentDef(DEFS.coder));

			const sync = appends(queries)[0];
			expect(sync).toBeDefined();
			const payload = sync?.values?.[8] as Record<string, unknown>;
			expect(payload.kind).toBe("reconciled");
			expect(payload.prevVersion).toBe(2);
			expect(payload.version).toBe(3);
			expect(payload.document).toEqual(doc);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid-JSON file with {ok:false} and never writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "polcli-"));
		const file = join(dir, "bad.json");
		await writeFile(file, "{ this is not json");
		try {
			const { pool, queries } = makePool();
			const res = await sorPolicyReconcile(
				{ pool, defs: DEFS },
				"coder",
				file,
			);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toContain("invalid JSON");
			expect(inserts(queries).length).toBe(0);
			expect(updates(queries).length).toBe(0);
			expect(appends(queries).length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a schema-invalid document with {ok:false} and never writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "polcli-"));
		const file = join(dir, "bad-schema.json");
		await writeFile(
			file,
			JSON.stringify({ ...capabilitySnapshot(DEFS.coder, "coder"), schemaVersion: 99 }),
		);
		try {
			const { pool, queries } = makePool();
			const res = await sorPolicyReconcile(
				{ pool, defs: DEFS },
				"coder",
				file,
			);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.reason).toContain("schemaVersion must be 1");
			expect(inserts(queries).length).toBe(0);
			expect(updates(queries).length).toBe(0);
			expect(appends(queries).length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a subject_role mismatch with {ok:false} and never writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "polcli-"));
		const file = join(dir, "mismatch.json");
		await writeFile(
			file,
			JSON.stringify({
				...capabilitySnapshot(DEFS.coder, "coder"),
				meta: { subject_role: "planner" },
			}),
		);
		try {
			const { pool, queries } = makePool();
			const res = await sorPolicyReconcile(
				{ pool, defs: DEFS },
				"coder",
				file,
			);
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.reason).toContain("does not match role 'coder'");
			}
			expect(inserts(queries).length).toBe(0);
			expect(updates(queries).length).toBe(0);
			expect(appends(queries).length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unknown role or missing file at the CLI boundary", async () => {
		const { pool, queries } = makePool();
		const unknown = await sorPolicyReconcile(
			{ pool, defs: DEFS },
			"codex",
			"whatever.json",
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.reason).toContain("unknown role");

		const missing = await sorPolicyReconcile(
			{ pool, defs: DEFS },
			"coder",
			join(tmpdir(), "no-such-policy-file.json"),
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toContain("policy file not found");
		expect(inserts(queries).length).toBe(0);
		expect(updates(queries).length).toBe(0);
	});
});

describe("sor:policy show (P6.1)", () => {
	it("prints the document tuple (document, policy_version, policy_hash, source_hash)", async () => {
		const doc = capabilitySnapshot(DEFS.reviewer, "reviewer");
		const hash = canonicalPolicyHash(doc);
		const source = hashAgentDef(DEFS.reviewer);
		const { pool } = makePool((text) =>
			text.includes("FROM agent_registry")
				? {
						rows: [
							{
								rules: doc,
								policy_hash: hash,
								policy_version: 4,
								source_hash: source,
							},
						],
					}
				: undefined,
		);
		const res = await sorPolicyShow({ pool, defs: DEFS }, "reviewer");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.detail).toContain("role:           reviewer");
			expect(res.detail).toContain("policy_version: 4");
			expect(res.detail).toContain(`policy_hash:    ${hash}`);
			expect(res.detail).toContain(`source_hash:    ${source}`);
			expect(res.detail).toContain(JSON.stringify(doc, null, 2));
		}
	});

	it("returns {ok:false} for a missing row, with zero writes", async () => {
		const { pool, queries } = makePool();
		const res = await sorPolicyShow({ pool, defs: DEFS }, "pr");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toContain("run 'sor:policy seed' first");
		expect(inserts(queries).length).toBe(0);
		expect(updates(queries).length).toBe(0);
		expect(appends(queries).length).toBe(0);
	});
});

describe("sor:policy dispatch (C9 wiring)", () => {
	it("routes seed / reconcile <role> <file> / show <role> and rejects bad argv", async () => {
		const { pool } = makePool();
		const deps: SorPolicyDeps = { pool, defs: DEFS };

		const noSub = await runSorPolicyCli(deps, []);
		expect(noSub.ok).toBe(false);
		if (!noSub.ok) expect(noSub.reason).toContain("requires a subcommand");

		const badSub = await runSorPolicyCli(deps, ["frobnicate"]);
		expect(badSub.ok).toBe(false);
		if (!badSub.ok) expect(badSub.reason).toContain("unknown sor:policy");

		const badReconcile = await runSorPolicyCli(deps, ["reconcile"]);
		expect(badReconcile.ok).toBe(false);
		if (!badReconcile.ok) {
			expect(badReconcile.reason).toContain("requires <role> <file>");
		}

		const badShow = await runSorPolicyCli(deps, ["show"]);
		expect(badShow.ok).toBe(false);
		if (!badShow.ok) expect(badShow.reason).toContain("show requires <role>");

		const showSeed = await runSorPolicyCli(deps, ["seed"]);
		expect(showSeed.ok).toBe(true);
	});
});

describe("P7.3 AT-5: drift cannot silently grant", () => {
	it("records drift-detected with no document and never writes rules on a source_hash mismatch", async () => {
		const { pool, queries } = makePool((text, values) => {
			if (text.includes("FROM agent_registry WHERE role")) {
				const role = values?.[0] as Role;
				if (role === "coder") {
					return {
						rows: [
							{
								rules: capabilitySnapshot(DEFS.coder, "coder"),
								policy_hash: canonicalPolicyHash(
									capabilitySnapshot(DEFS.coder, "coder"),
								),
								policy_version: 1,
								source_hash: "stale-ceiling-hash",
							},
						],
					};
				}
				// matching current-ceiling rows for the other five roles: no seed,
				// no drift — isolates the single coder drift event.
				return {
					rows: [
						{
							rules: capabilitySnapshot(DEFS[role], role),
							policy_hash: canonicalPolicyHash(
								capabilitySnapshot(DEFS[role], role),
							),
							policy_version: 1,
							source_hash: hashAgentDef(DEFS[role]),
						},
					],
				};
			}
			return undefined;
		});
		await ensurePolicyRegistry(pool, DEFS);

		expect(updates(queries).length).toBe(0);
		const syncs = appends(queries);
		expect(syncs.length).toBe(1);
		const payload = syncs[0]?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("drift-detected");
		expect(payload.document).toBeUndefined();
		// no auto-rewrite of rules ⇒ no silent grant of any new capability
		for (const record of queries) {
			expect(record.text.includes("SET rules")).toBe(false);
		}
	});
});