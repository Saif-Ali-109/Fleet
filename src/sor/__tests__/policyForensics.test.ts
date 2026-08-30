// P7.4 / AT-6 (§17.1): policy version/hash reconstructible from the audit
// chain — `policy_state` (session claim) → `policy_sync` (full document embed)
// for any historical `policyVersion` (FR-22, §12.3 forensic reconstruction).
//
// Events flow through `appendAuditEvent` unchanged (verify path sees them as
// ordinary signed rows), so the test lays down a seeded v1 + reconciled v2 +
// drift v3 chain with a matching `policy_state` claim, then RE-READS the rows
// the way a forensic reader would and rebuilds the historical documents,
// checking canonicalPolicyHash against the claimed hash.
//
// Recording-pool mock mirroring src/__tests__/audit.test.ts — no real DB.

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent, emitPolicySync } from "../../db/audit.ts";
import { canonicalPolicyHash, type PolicyDocument } from "../../fleet/policy.ts";
import { RESERVED_NAMESPACE } from "../../sor/kernel/types.ts";

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

/** Doubles as the pool AND the connecting client so both ensureChain()
 *  (pool.query for the sor_chain INSERT) and appendAuditEvent
 *  (pool.connect → client BEGIN/SELECT/INSERT/UPDATE/COMMIT) work. Records
 *  every audit_events INSERT so the chain can be re-read forensically; the
 *  mock tail ADVANCES on each UPDATE so prev_hash chaining is real. */
function chainingPool(recorded: RecordedQuery[]): Pool {
	let tail: { seq: string; hash: string } = { seq: "0", hash: "genesis" };
	const stubQuery = async (...args: unknown[]) => {
		const q: RecordedQuery =
			typeof args[0] === "string"
				? { text: args[0], values: args[1] as unknown[] | undefined }
				: (args[0] as RecordedQuery);
		recorded.push(q);
		if (q.text.includes("FOR UPDATE")) {
			return { rows: [tail] };
		}
		if (q.text.startsWith("UPDATE sor_chain")) {
			tail = {
				seq: String(q.values?.[0] ?? 0),
				hash: q.values?.[1] as string,
			};
		}
		return { rows: [] };
	};
	const client = {
		query: stubQuery,
		release: () => {},
	};
	return {
		query: stubQuery,
		connect: async () => client,
	} as unknown as Pool;
}

/** Re-read the chain the way verifyChain / a forensic reader does: every
 *  audit_events INSERT becomes a row holding its signed + payload fields. */
interface ForensicRow {
	seq: number;
	event_type: string;
	payload: Record<string, unknown>;
	prev_hash: string | null;
	hash: string | null;
}

function rereadChain(recorded: RecordedQuery[]): ForensicRow[] {
	const rows: ForensicRow[] = [];
	for (const q of recorded) {
		if (!q.text.startsWith("INSERT INTO audit_events")) continue;
		const v = q.values ?? [];
		rows.push({
			seq: Number(v[1]),
			event_type: v[2] as string,
			payload: (v[8] ?? {}) as Record<string, unknown>,
			prev_hash: (v[9] as string | undefined) ?? null,
			hash: (v[10] as string | undefined) ?? null,
		});
	}
	return rows.sort((a, b) => a.seq - b.seq);
}

/** The §12.3 reconstruction: for a claimed policy version, find the NEWEST
 *  `policy_sync` carrying that version AND an embedded full document.
 *  `drift-detected` syncs carry no document and therefore cannot satisfy an
 *  authorization claim — that asymmetry is part of the audit contract. */
function reconstructPolicyDocument(
	rows: ForensicRow[],
	version: number,
): PolicyDocument | null {
	const sync = [...rows]
		.filter((r) => r.event_type === "policy_sync")
		.reverse()
		.find(
			(r) =>
				r.payload.version === version &&
				r.payload.document !== undefined &&
				r.payload.document !== null,
		);
	return sync ? (sync.payload.document as PolicyDocument) : null;
}

function docV1(): PolicyDocument {
	return {
		schemaVersion: 1,
		meta: { subject_role: "coder" },
		allowedTools: ["read", "grep"],
		mcpAllow: [],
		toolRules: {},
	};
}

function docV2(): PolicyDocument {
	return {
		schemaVersion: 1,
		meta: { subject_role: "coder" },
		allowedTools: ["read"],
		mcpAllow: [],
		toolRules: {
			read: [{ op: "deny", when: { path: "path", match: "^/etc/" } }],
		},
	};
}

const KEY = "test-signing-key";
let savedKey: string | undefined;
let savedKeyId: string | undefined;

beforeEach(() => {
	savedKey = process.env.SOR_SIGNING_KEY;
	savedKeyId = process.env.SOR_KEY_ID;
	process.env.SOR_SIGNING_KEY = KEY;
	process.env.SOR_KEY_V1 = KEY;
	process.env.SOR_KEY_ID = "v1";
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env.SOR_SIGNING_KEY;
		delete process.env.SOR_KEY_V1;
	} else {
		process.env.SOR_SIGNING_KEY = savedKey;
		process.env.SOR_KEY_V1 = savedKey;
	}
	if (savedKeyId === undefined) {
		delete process.env.SOR_KEY_ID;
	} else {
		process.env.SOR_KEY_ID = savedKeyId;
	}
});

describe("P7.4 AT-6: forensic reread from policy_state → policy_sync", () => {
	it("reconstructs the historical document for the claimed version and its hash matches", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = chainingPool(recorded);
		const v1 = docV1();
		const v2 = docV2();
		const h1 = canonicalPolicyHash(v1);
		const h2 = canonicalPolicyHash(v2);

		// Chain: seeded v1 → reconciled v2 (both embed the full document).
		await emitPolicySync(pool, {
			kind: "seeded",
			role: "coder",
			prevVersion: 0,
			nextVersion: 1,
			policyHash: h1,
			document: v1,
		});
		await emitPolicySync(pool, {
			kind: "reconciled",
			role: "coder",
			prevVersion: 1,
			nextVersion: 2,
			policyHash: h2,
			document: v2,
		});
		// Session claim (worker init, sor mode) pointing at version 2.
		await appendAuditEvent(pool, {
			run_id: "run-policy-1",
			event_type: "policy_state",
			actor: "coder",
			backend: "gemini",
			tool_name: null,
			tool_input: null,
			tool_output: null,
			payload: {
				sorType: "policy",
				sourceId: "coder",
				namespace: RESERVED_NAMESPACE,
				version: 2,
				hash: h2,
				actor: "coder",
				ts: "2026-08-30T00:00:00.000Z",
				mode: "sor",
				policyVersion: 2,
				policyHash: h2,
				sourceHash: "def-hash-1",
			},
			created_at: "2026-08-30T00:00:00.000Z",
		});

		const rows = rereadChain(recorded);
		const state = rows.find((r) => r.event_type === "policy_state");
		expect(state).toBeDefined();
		const claim = state?.payload;
		expect(claim?.mode).toBe("sor");
		expect(claim?.policyVersion).toBe(2);
		expect(claim?.policyHash).toBe(h2);

		// Forensic reconstruction of the claimed version.
		const rebuilt = reconstructPolicyDocument(rows, claim?.policyVersion as number);
		expect(rebuilt).toEqual(v2);
		expect(canonicalPolicyHash(rebuilt as PolicyDocument)).toBe(h2);
		// The chain-stored sync hash also agrees with the rebuilt document.
		const syncV2 = rows.find(
			(r) => r.event_type === "policy_sync" && r.payload.version === 2,
		);
		expect(syncV2?.payload.hash).toBe(h2);
		// prev_hash linkage is intact across all three appends.
		for (let i = 1; i < rows.length; i++) {
			const row = rows[i];
			const prev = rows[i - 1];
			expect(row?.prev_hash).toBe(prev?.hash);
		}
	});

	it("reconstructs a HISTORICAL version (seeded v1) independently of the latest", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = chainingPool(recorded);
		const v1 = docV1();
		const v2 = docV2();
		await emitPolicySync(pool, {
			kind: "seeded",
			role: "coder",
			prevVersion: 0,
			nextVersion: 1,
			policyHash: canonicalPolicyHash(v1),
			document: v1,
		});
		await emitPolicySync(pool, {
			kind: "reconciled",
			role: "coder",
			prevVersion: 1,
			nextVersion: 2,
			policyHash: canonicalPolicyHash(v2),
			document: v2,
		});

		const rows = rereadChain(recorded);
		const rebuiltV1 = reconstructPolicyDocument(rows, 1);
		expect(rebuiltV1).toEqual(v1);
		expect(canonicalPolicyHash(rebuiltV1 as PolicyDocument)).toBe(
			canonicalPolicyHash(v1),
		);
	});

	it("drift versions carry no document — a v3 claim cannot be satisfied forensically (no silent grant)", async () => {
		const recorded: RecordedQuery[] = [];
		const pool = chainingPool(recorded);
		const v2 = docV2();
		await emitPolicySync(pool, {
			kind: "reconciled",
			role: "coder",
			prevVersion: 1,
			nextVersion: 2,
			policyHash: canonicalPolicyHash(v2),
			document: v2,
		});
		// Drift on the next code change: version 3 exists but has NO document.
		await emitPolicySync(pool, {
			kind: "drift-detected",
			role: "coder",
			prevVersion: 2,
			nextVersion: 3,
			policyHash: canonicalPolicyHash(v2),
		});

		const rows = rereadChain(recorded);
		const drift = rows.find(
			(r) => r.event_type === "policy_sync" && r.payload.version === 3,
		);
		expect(drift?.payload.kind).toBe("drift-detected");
		expect(drift?.payload.document).toBeUndefined();
		expect(reconstructPolicyDocument(rows, 3)).toBeNull();
		// The last document-bearing version still reconstructs exactly.
		const rebuiltV2 = reconstructPolicyDocument(rows, 2);
		expect(rebuiltV2).toEqual(v2);
		expect(canonicalPolicyHash(rebuiltV2 as PolicyDocument)).toBe(
			canonicalPolicyHash(v2),
		);
	});
});