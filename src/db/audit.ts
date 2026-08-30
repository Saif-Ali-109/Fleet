// Signed System of Record DB layer — append/verify a tamper-evident audit log,
// plus the agent registry sync. Backed by migrations/004_sor.sql.
// run_id is the run-directory name (ctx.runId), NOT the run_outcomes UUID —
// it is the identifier shared by hooks, agentRunner, and orchestrator.

import type { Pool } from "pg";
import type { SorEvent, SorEventType } from "../sor/events.ts";
import { getCurrentKey, getCurrentKeyId, getKey } from "../sor/keyRegistry.ts";
import { GENESIS_HASH, canonicalJson, signEvent } from "../sor/signer.ts";
import {
	canonicalPolicyHash,
	capabilitySnapshot,
	emptyPolicy,
	sha256Hex,
	validatePolicyDocument,
} from "../fleet/policy.ts";
import {
	RESERVED_NAMESPACE,
	type PolicyDocument,
} from "../sor/kernel/types.ts";
import type { FleetAgentDef } from "../fleet/types.ts";
import type { Role } from "../types.ts";

export interface AgentRegistryRow {
	role: string;
	metadata: Record<string, unknown>;
	rules: Record<string, unknown>;
	source_hash: string; // sha256 hex of the source agents/<role>.md
}

interface ChainRow {
	seq: string;
	hash: string;
	key_id: string;
}

interface AuditEventRow {
	run_id: string | null;
	seq: string;
	event_type: string;
	actor: string;
	backend: string | null;
	tool_name: string | null;
	tool_input: unknown;
	tool_output: unknown;
	payload: Record<string, unknown>;
	prev_hash: string;
	hash: string;
	key_id: string;
	created_at: Date;
}

/** Coerce a value into something pg can bind to a JSONB column without loss.
 *  Primitives must be pre-serialized (a bare string would otherwise be cast by
 *  Postgres as raw JSON syntax and rejected); objects/arrays pass through for
 *  pg's own serialization; null stays null. */
export function toJsonbParam(v: unknown): unknown {
	if (v === undefined || v === null) return null;
	if (
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	) {
		return JSON.stringify(v);
	}
	return v;
}

function _requireSigningKey(): string {
	const key = process.env.SOR_SIGNING_KEY;
	if (!key || key.length === 0) {
		throw new Error(
			"SOR_SIGNING_KEY is not set. Configure it in .env or export it before appending/verifying audit events.",
		);
	}
	return key;
}

/** Idempotent: ensure the singleton sor_chain row exists (id=1, seq=0, hash=GENESIS_HASH).
 *  The genesis row records the CURRENT key id so a fresh install under a
 *  nonzero SOR_KEY_ID gets a consistent tail from the start. */
export async function ensureChain(pool: Pool): Promise<void> {
	await pool.query(
		"INSERT INTO sor_chain (id, seq, hash, key_id) VALUES (1, 0, $1, $2) ON CONFLICT (id) DO NOTHING",
		[GENESIS_HASH, getCurrentKeyId()],
	);
}

/** Single-writer append. Transactional; row-locks the chain tail before signing + inserting. */
export async function appendAuditEvent(
	pool: Pool,
	event: SorEvent,
): Promise<void> {
	const keyId = getCurrentKeyId();
	const key = getCurrentKey();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const chainResult = await client.query<ChainRow>(
			"SELECT seq, hash, key_id FROM sor_chain WHERE id = 1 FOR UPDATE",
		);
		const chain = chainResult.rows[0];
		if (!chain) {
			throw new Error(
				"sor_chain (id=1) missing — call ensureChain() before appending audit events",
			);
		}

		const nextSeq = Number(chain.seq) + 1;
		const normalized = {
			...event,
			created_at: new Date(event.created_at).toISOString(),
		};
		// Embed the same key id that is written to the row and to sor_chain
		// (chain.key_id is the OLD tail key until we commit). verifyChain
		// recomputes with row.key_id, so both must agree for the first
		// post-rotation append to verify.
		const hash = signEvent(key, chain.hash, normalized, keyId);

		await client.query(
			`INSERT INTO audit_events
        (run_id, seq, event_type, actor, backend, tool_name, tool_input, tool_output, payload, prev_hash, hash, key_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			[
				event.run_id,
				nextSeq,
				event.event_type,
				event.actor,
				event.backend,
				event.tool_name,
				toJsonbParam(event.tool_input),
				toJsonbParam(event.tool_output),
				toJsonbParam(event.payload),
				chain.hash,
				hash,
				keyId,
				normalized.created_at,
			],
		);

		await client.query(
			"UPDATE sor_chain SET seq = $1, hash = $2, key_id = $3, updated_at = now() WHERE id = 1",
			[nextSeq, hash, keyId],
		);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export type LoadedRolePolicy =
	| {
			status: "valid";
			policy: {
				policyHash: string;
				policyVersion: number;
				sourceHash: string;
				document: PolicyDocument;
			};
	  }
	| { status: "absent"; policy: null }
	| { status: "invalid"; policy: null; reason: string };

interface RegistryRow {
	rules: unknown;
	policy_hash: string | null;
	policy_version: number;
	source_hash: string | null;
}

/** Canonical hash of the current `FleetAgentDef` — the capability ceiling a
 *  policy row is reconciled against (`agent_registry.source_hash`, §9.2). */
export function hashAgentDef(def: FleetAgentDef): string {
	return sha256Hex(canonicalJson(def));
}

/** Seed-time `metadata` snapshot per §9.4/§21.3 (systemPromptSha, skillsDir, capabilities). */
function defMetadata(def: FleetAgentDef): Record<string, unknown> {
	return {
		systemPromptSha: sha256Hex(def.systemPrompt),
		skillsDir: def.skillsDir,
		capabilityTools: [...def.tools],
		capabilityMcp: [...def.mcpAllow],
	};
}

export interface PolicySyncEvent {
	kind: "seeded" | "reconciled" | "updated" | "drift-detected";
	role: Role;
	prevVersion: number;
	nextVersion: number;
	policyHash: string;
	document?: PolicyDocument;
}

/** NON-FATAL `policy_sync` append (§12.2, C4). Any failure warns and continues. */
export async function emitPolicySync(
	pool: Pool,
	sync: PolicySyncEvent,
): Promise<void> {
	try {
		await ensureChain(pool);
		const event: SorEvent = {
			run_id: null,
			event_type: "policy_sync",
			actor: "manager",
			backend: null,
			tool_name: null,
			tool_input: null,
			tool_output: null,
			payload: {
				sorType: "policy",
				sourceId: sync.role,
				namespace: RESERVED_NAMESPACE,
				version: sync.nextVersion,
				hash: sync.policyHash,
				actor: "manager",
				ts: new Date().toISOString(),
				kind: sync.kind,
				prevVersion: sync.prevVersion,
				...(sync.document !== undefined ? { document: sync.document } : {}),
			},
			created_at: new Date().toISOString(),
		};
		await appendAuditEvent(pool, event);
	} catch (err) {
		console.warn(
			`[sor] policy_sync skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Insert-only seed for one role's `agent_registry` row (fresh install, §9.4). */
async function seedRegistryRow(
	pool: Pool,
	role: Role,
	def: FleetAgentDef,
): Promise<void> {
	const doc = capabilitySnapshot(def, role);
	const policyHash = canonicalPolicyHash(doc);
	await pool.query(
		`INSERT INTO agent_registry (role, metadata, rules, source_hash, policy_hash, policy_version, synced_at)
     VALUES ($1, $2, $3, $4, $5, 1, now())`,
		[
			role,
			toJsonbParam(defMetadata(def)),
			toJsonbParam(doc),
			hashAgentDef(def),
			policyHash,
		],
	);
	await emitPolicySync(pool, {
		kind: "seeded",
		role,
		prevVersion: 0,
		nextVersion: 1,
		policyHash,
		document: doc,
	});
}

/** Idempotent registry bootstrap: seed missing rows, backfill legacy 014 rows,
 *  and record drift on `source_hash` mismatch (FR-7 — never auto-rewrite `rules`). */
export async function ensurePolicyRegistry(
	pool: Pool,
	defs: Record<Role, FleetAgentDef>,
): Promise<void> {
	for (const role of Object.keys(defs) as Role[]) {
		const def = defs[role];
		if (!def) continue;
		const sourceHash = hashAgentDef(def);
		const result = await pool.query<RegistryRow>(
			"SELECT rules, policy_hash, policy_version, source_hash FROM agent_registry WHERE role = $1",
			[role],
		);
		const row = result.rows[0];
		if (!row) {
			await seedRegistryRow(pool, role, def);
			continue;
		}
		if (row.policy_hash === null) {
			// Legacy 014 backfill (§21.3): hash the canonicalized existing rules
			// at first boot, reconcile the metadata snapshot, before any drift check.
			const rules = row.rules;
			const doc: PolicyDocument =
				rules !== null &&
				typeof rules === "object" &&
				!Array.isArray(rules)
					? (rules as unknown as PolicyDocument)
					: emptyPolicy(role);
			const policyHash = canonicalPolicyHash(doc);
			await pool.query(
				`UPDATE agent_registry
           SET policy_hash = $2, metadata = $3, source_hash = $4, synced_at = now()
          WHERE role = $1`,
				[role, policyHash, toJsonbParam(defMetadata(def)), sourceHash],
			);
			continue;
		}
		if (row.source_hash === null || row.source_hash !== sourceHash) {
			await emitPolicySync(pool, {
				kind: "drift-detected",
				role,
				prevVersion: row.policy_version,
				nextVersion: row.policy_version,
				policyHash: row.policy_hash,
			});
		}
	}
}

/** Load one role's validated policy document split three ways: `absent` (no row),
 *  `invalid` (malformed / NULL hash / hash mismatch) or `valid` (sor-usable). */
export async function loadRolePolicy(
	pool: Pool,
	role: Role,
): Promise<LoadedRolePolicy> {
	const result = await pool.query<RegistryRow>(
		"SELECT rules, policy_hash, policy_version, source_hash FROM agent_registry WHERE role = $1",
		[role],
	);
	const row = result.rows[0];
	if (!row) {
		return { status: "absent", policy: null };
	}
	if (row.policy_hash === null) {
		return {
			status: "invalid",
			policy: null,
			reason: "policy_hash is null or malformed",
		};
	}
	const doc = row.rules as unknown;
	const check = validatePolicyDocument(doc, role);
	if (!check.ok) {
		return {
			status: "invalid",
			policy: null,
			reason: `invalid policy document: ${check.reason}`,
		};
	}
	if (canonicalPolicyHash(doc as PolicyDocument) !== row.policy_hash) {
		return {
			status: "invalid",
			policy: null,
			reason: "policy hash mismatch",
		};
	}
	return {
		status: "valid",
		policy: {
			policyHash: row.policy_hash,
			policyVersion: row.policy_version,
			sourceHash: row.source_hash ?? "",
			document: doc as PolicyDocument,
		},
	};
}

/** Explicit admin reconcile (§9.4): validate the document, write the NEXT
 *  policy version (even on unchanged content — §4.3), update `source_hash` to
 *  the current ceiling, and emit `policy_sync {kind:"reconciled", document}`. */
export async function reconcileRolePolicy(
	pool: Pool,
	role: Role,
	doc: PolicyDocument,
	defs: Record<Role, FleetAgentDef>,
): Promise<
	| { ok: true; policyVersion: number; kind: "reconciled" }
	| { ok: false; reason: string }
> {
	const check = validatePolicyDocument(doc, role);
	if (!check.ok) {
		return { ok: false, reason: check.reason };
	}
	const def = defs[role];
	if (!def) {
		return { ok: false, reason: `no FleetAgentDef for role ${role}` };
	}
	const sourceHash = hashAgentDef(def);
	const policyHash = canonicalPolicyHash(doc);
	const prevResult = await pool.query<{ policy_version: number }>(
		"SELECT policy_version FROM agent_registry WHERE role = $1",
		[role],
	);
	const prevRow = prevResult.rows[0];
	const prevVersion = prevRow?.policy_version ?? 0;
	const nextVersion = prevVersion + 1;
	if (!prevRow) {
		await pool.query(
			`INSERT INTO agent_registry (role, metadata, rules, source_hash, policy_hash, policy_version, synced_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())`,
			[
				role,
				toJsonbParam(defMetadata(def)),
				toJsonbParam(doc),
				sourceHash,
				policyHash,
			],
		);
	} else {
		await pool.query(
			`UPDATE agent_registry
         SET rules = $2, policy_hash = $3, policy_version = $4, source_hash = $5, synced_at = now()
        WHERE role = $1`,
			[role, toJsonbParam(doc), policyHash, nextVersion, sourceHash],
		);
	}
	await emitPolicySync(pool, {
		kind: "reconciled",
		role,
		prevVersion,
		nextVersion,
		policyHash,
		document: doc,
	});
	return { ok: true, policyVersion: nextVersion, kind: "reconciled" };
}

function eventFromRow(row: AuditEventRow): SorEvent {
	return {
		run_id: row.run_id,
		event_type: row.event_type as SorEventType,
		actor: row.actor,
		backend: row.backend,
		tool_name: row.tool_name,
		tool_input: row.tool_input,
		tool_output: row.tool_output,
		payload: row.payload,
		created_at: row.created_at.toISOString(),
	};
}

/** Replay verification. Recomputes the hash chain and checks prev_hash linkage row by row. */
export async function verifyChain(pool: Pool): Promise<{
	ok: boolean;
	firstBadSeq: number | null;
	total: number;
	counts: Record<string, number>;
}> {
	const result = await pool.query<AuditEventRow>(
		`SELECT run_id, seq, event_type, actor, backend, tool_name,
            tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
     FROM audit_events
     ORDER BY seq ASC`,
	);
	const rows = result.rows;

	const counts: Record<string, number> = {};
	let prevHash = GENESIS_HASH;
	let firstBadSeq: number | null = null;

	for (const row of rows) {
		counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
		if (firstBadSeq !== null) continue; // already failed; keep tallying the rest

		if (row.prev_hash !== prevHash) {
			firstBadSeq = Number(row.seq);
			continue;
		}

		// Get the key for this row's key_id
		const key = getKey(row.key_id);
		if (!key) {
			firstBadSeq = Number(row.seq);
			continue;
		}

		const recomputed = signEvent(
			key,
			row.prev_hash,
			eventFromRow(row),
			row.key_id,
		);
		if (recomputed !== row.hash) {
			firstBadSeq = Number(row.seq);
			continue;
		}
		prevHash = row.hash;
	}

	return { ok: firstBadSeq === null, firstBadSeq, total: rows.length, counts };
}
