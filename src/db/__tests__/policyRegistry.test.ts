import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzerDef } from "../../fleet/agents/analyzer.ts";
import { coderDef } from "../../fleet/agents/coder.ts";
import { plannerDef } from "../../fleet/agents/planner.ts";
import { prDef } from "../../fleet/agents/pr.ts";
import { reviewerDef } from "../../fleet/agents/reviewer.ts";
import { testerDef } from "../../fleet/agents/tester.ts";
import { canonicalPolicyHash, capabilitySnapshot } from "../../fleet/policy.ts";
import type { FleetAgentDef } from "../../fleet/types.ts";
import type { PolicyDocument } from "../../sor/kernel/types.ts";
import { RESERVED_NAMESPACE } from "../../sor/kernel/types.ts";
import { GENESIS_HASH } from "../../sor/signer.ts";
import type { Role } from "../../types.ts";
import {
	ensurePolicyRegistry,
	hashAgentDef,
	loadRolePolicy,
	reconcileRolePolicy,
} from "../audit.ts";

const DEFS: Record<Role, FleetAgentDef> = {
	analyzer: analyzerDef,
	planner: plannerDef,
	coder: coderDef,
	tester: testerDef,
	reviewer: reviewerDef,
	pr: prDef,
};

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

function makePool(responder?: RegistryResponder): {
	pool: Pool;
	queries: RecordedQuery[];
} {
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

const KEY = "policy-registry-test-key";
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

function seedRowForRole(role: Role): Record<string, unknown> {
	const doc = capabilitySnapshot(DEFS[role], role);
	return {
		rules: doc,
		policy_hash: canonicalPolicyHash(doc),
		policy_version: 1,
		source_hash: hashAgentDef(DEFS[role]),
	};
}

describe("ensurePolicyRegistry (P5.1)", () => {
	it("seeds all six roles insert-only with v1, snapshot doc, computed hash", async () => {
		const { pool, queries } = makePool();
		await ensurePolicyRegistry(pool, DEFS);

		const seeds = queries.filter((q) =>
			q.text.includes("INSERT INTO agent_registry"),
		);
		expect(seeds.length).toBe(6);
		const roles = seeds.map((s) => s.values?.[0]).sort();
		expect(roles).toEqual([...ROLES].sort());

		const coder = seeds.find((s) => s.values?.[0] === "coder");
		const doc = capabilitySnapshot(coderDef, "coder");
		// values: $1 role, $2 metadata, $3 rules, $4 source_hash, $5 policy_hash
		const meta = coder?.values?.[1] as Record<string, unknown>;
		expect(meta.capabilityTools).toEqual([...coderDef.tools]);
		expect(meta.capabilityMcp).toEqual([...coderDef.mcpAllow]);
		expect(meta.skillsDir).toBe("skills/coder");
		expect(coder?.values?.[2]).toEqual(doc);
		expect(coder?.values?.[3]).toBe(hashAgentDef(coderDef));
		expect(coder?.values?.[4]).toBe(canonicalPolicyHash(doc));

		// every seed emits policy_sync {kind:"seeded"} with document, non-fatal path
		const syncs = queries.filter((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(syncs.length).toBe(6);
		const first = syncs[0]?.values?.[8] as Record<string, unknown>;
		expect(first.kind).toBe("seeded");
		expect(first.namespace).toBe(RESERVED_NAMESPACE);
		expect(first.document).toBeDefined();
	});

	it("is idempotent on re-run: no re-insert, no events", async () => {
		const { pool, queries } = makePool((text, values) => {
			if (text.includes("FROM agent_registry WHERE role")) {
				const role = values?.[0] as Role;
				return { rows: [seedRowForRole(role)] };
			}
			return undefined;
		});
		await ensurePolicyRegistry(pool, DEFS);
		expect(
			queries.filter((q) => q.text.includes("INSERT INTO agent_registry"))
				.length,
		).toBe(0);
		expect(
			queries.filter((q) => q.text.includes("UPDATE agent_registry")).length,
		).toBe(0);
		expect(
			queries.filter((q) => q.text.includes("INSERT INTO audit_events")).length,
		).toBe(0);
	});
});

describe("legacy 014 backfill (P5.2)", () => {
	it("computes policy_hash from canonicalized existing rules at first boot, v1, no drift", async () => {
		const legacyRules = { some: "legacy-shape", nested: { a: 1 } };
		const { pool, queries } = makePool((text, values) => {
			if (text.includes("FROM agent_registry WHERE role")) {
				const role = values?.[0] as Role;
				if (role === "coder") {
					return {
						rows: [
							{
								rules: legacyRules,
								policy_hash: null,
								policy_version: 1,
								source_hash: "pre-014-hash",
							},
						],
					};
				}
				return { rows: [] };
			}
			return undefined;
		});
		await ensurePolicyRegistry(pool, DEFS);

		const update = queries.find((q) =>
			q.text.includes("UPDATE agent_registry"),
		);
		expect(update).toBeDefined();
		expect(update?.values?.[0]).toBe("coder");
		expect(update?.values?.[1]).toBe(
			canonicalPolicyHash(legacyRules as unknown as PolicyDocument),
		);
		// metadata capabilities reconciled at first boot, policy_version untouched
		const meta = update?.values?.[2] as Record<string, unknown>;
		expect(meta.capabilityTools).toEqual([...coderDef.tools]);
		expect(update?.values?.[3]).toBe(hashAgentDef(coderDef));
		// no policy_sync appended for the silent backfill — the only appends are
		// the five sibling roles seeding (all kind:"seeded", never drift)
		const syncs = queries.filter((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(syncs.length).toBe(5);
		for (const sync of syncs) {
			expect((sync.values![8] as Record<string, unknown>).kind).toBe("seeded");
		}
		// the other five roles still seed
		expect(
			queries.filter((q) => q.text.includes("INSERT INTO agent_registry"))
				.length,
		).toBe(5);
	});
});

describe("loadRolePolicy three-way split (P5.3)", () => {
	it("absent: no rows for the role ⇒ { status:'absent' }", async () => {
		const { pool } = makePool();
		expect(await loadRolePolicy(pool, "coder")).toEqual({
			status: "absent",
			policy: null,
		});
	});

	it("invalid: NULL policy_hash ⇒ fail-closed route", async () => {
		const { pool } = makePool((text) =>
			text.includes("FROM agent_registry")
				? {
						rows: [
							{
								rules: capabilitySnapshot(coderDef, "coder"),
								policy_hash: null,
								policy_version: 1,
								source_hash: "x",
							},
						],
					}
				: undefined,
		);
		const out = await loadRolePolicy(pool, "coder");
		expect(out.status).toBe("invalid");
		expect(out.status === "invalid" ? out.reason : "").toContain(
			"policy_hash is null",
		);
	});

	it("invalid: hash mismatch / malformed document ⇒ fail-closed route", async () => {
		const doc = capabilitySnapshot(coderDef, "coder");
		const p1 = makePool((text) =>
			text.includes("FROM agent_registry")
				? {
						rows: [
							{
								rules: doc,
								policy_hash: "f".repeat(64),
								policy_version: 1,
								source_hash: "x",
							},
						],
					}
				: undefined,
		);
		expect(await loadRolePolicy(p1.pool, "coder")).toEqual({
			status: "invalid",
			policy: null,
			reason: "policy hash mismatch",
		});

		const p2 = makePool((text) =>
			text.includes("FROM agent_registry")
				? {
						rows: [
							{
								rules: { schemaVersion: 2 },
								policy_hash: "e".repeat(64),
								policy_version: 1,
								source_hash: "x",
							},
						],
					}
				: undefined,
		);
		const out2 = await loadRolePolicy(p2.pool, "coder");
		expect(out2.status).toBe("invalid");
		expect(out2.status === "invalid" ? out2.reason : "").toContain(
			"invalid policy document",
		);
	});

	it("valid: canonical doc + matching hash ⇒ sor-usable policy", async () => {
		const doc = capabilitySnapshot(coderDef, "coder");
		const hash = canonicalPolicyHash(doc);
		const { pool } = makePool((text) =>
			text.includes("FROM agent_registry")
				? {
						rows: [
							{
								rules: doc,
								policy_hash: hash,
								policy_version: 3,
								source_hash: hashAgentDef(coderDef),
							},
						],
					}
				: undefined,
		);
		const out = await loadRolePolicy(pool, "coder");
		expect(out).toEqual({
			status: "valid",
			policy: {
				policyHash: hash,
				policyVersion: 3,
				sourceHash: hashAgentDef(coderDef),
				document: doc,
			},
		});
	});
});

describe("reconcileRolePolicy (P5.4)", () => {
	it("bumps policy_version even on unchanged content and updates source_hash", async () => {
		const doc = capabilitySnapshot(coderDef, "coder");
		let version = 2;
		const { pool, queries } = makePool((text) => {
			if (text.includes("SELECT policy_version")) {
				return { rows: [{ policy_version: version }] };
			}
			return undefined;
		});

		const out1 = await reconcileRolePolicy(pool, "coder", doc, DEFS);
		expect(out1).toEqual({ ok: true, policyVersion: 3, kind: "reconciled" });
		version = 3;
		const out2 = await reconcileRolePolicy(pool, "coder", doc, DEFS);
		expect(out2).toEqual({ ok: true, policyVersion: 4, kind: "reconciled" });

		const updates = queries.filter((q) =>
			q.text.includes("UPDATE agent_registry"),
		);
		expect(updates.length).toBe(2);
		expect(updates[0]?.values?.[0]).toBe("coder");
		expect(updates[0]?.values?.[1]).toEqual(doc);
		expect(updates[0]?.values?.[2]).toBe(canonicalPolicyHash(doc));
		expect(updates[0]?.values?.[3]).toBe(3);
		expect(updates[0]?.values?.[4]).toBe(hashAgentDef(coderDef));

		// policy_sync {kind:"reconciled"} carries prevVersion + full document
		const syncs = queries.filter((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(syncs.length).toBe(2);
		const payload = syncs[0]?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("reconciled");
		expect(payload.prevVersion).toBe(2);
		expect(payload.version).toBe(3);
		expect(payload.document).toEqual(doc);
	});

	it("rejects a malformed document or role mismatch without any write", async () => {
		const { pool, queries } = makePool();
		const bad = {
			...capabilitySnapshot(coderDef, "coder"),
			meta: { subject_role: "planner" },
		};
		const out = await reconcileRolePolicy(pool, "coder", bad, DEFS);
		expect(out.ok).toBe(false);
		expect(
			queries.filter((q) => q.text.includes("INSERT INTO agent_registry"))
				.length,
		).toBe(0);
		expect(
			queries.filter((q) => q.text.includes("UPDATE agent_registry")).length,
		).toBe(0);
	});

	it("drift-only path: source_hash mismatch records drift, never writes rules (FR-7/AT-5)", async () => {
		const { pool, queries } = makePool((text, values) => {
			if (text.includes("FROM agent_registry WHERE role")) {
				const role = values?.[0] as Role;
				if (role === "coder") {
					return {
						rows: [
							{
								rules: capabilitySnapshot(coderDef, "coder"),
								policy_hash: canonicalPolicyHash(
									capabilitySnapshot(coderDef, "coder"),
								),
								policy_version: 1,
								source_hash: "stale-ceiling-hash",
							},
						],
					};
				}
				return { rows: [seedRowForRole(role)] };
			}
			return undefined;
		});
		await ensurePolicyRegistry(pool, DEFS);

		expect(
			queries.filter((q) => q.text.includes("UPDATE agent_registry")).length,
		).toBe(0);
		expect(
			queries.filter((q) => q.text.includes("INSERT INTO agent_registry"))
				.length,
		).toBe(0);
		const syncs = queries.filter((q) =>
			q.text.includes("INSERT INTO audit_events"),
		);
		expect(syncs.length).toBe(1);
		const payload = syncs[0]?.values?.[8] as Record<string, unknown>;
		expect(payload.kind).toBe("drift-detected");
		expect(payload.document).toBeUndefined();
	});
});

describe("NON-FATAL policy appends (P5.5)", () => {
	it("a forced SOR-write failure warns and continues instead of aborting", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { pool } = makePool((text) => {
				if (text.includes("INSERT INTO audit_events")) {
					throw new Error("append unavailable");
				}
				return undefined;
			});
			await expect(ensurePolicyRegistry(pool, DEFS)).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("reconcile still succeeds when the policy_sync append fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const doc = capabilitySnapshot(coderDef, "coder");
			const { pool } = makePool((text) => {
				if (text.includes("SELECT policy_version")) {
					return { rows: [{ policy_version: 1 }] };
				}
				if (text.includes("INSERT INTO audit_events")) {
					throw new Error("chain unavailable");
				}
				return undefined;
			});
			const out = await reconcileRolePolicy(pool, "coder", doc, DEFS);
			expect(out).toEqual({ ok: true, policyVersion: 2, kind: "reconciled" });
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
