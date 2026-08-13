// Signed System of Record DB layer — append/verify a tamper-evident audit log,
// plus the agent registry sync. Backed by migrations/004_sor.sql.
// run_id is the run-directory name (ctx.runId), NOT the run_outcomes UUID —
// it is the identifier shared by hooks, agentRunner, and orchestrator.

import type { Pool } from "pg";
import type { SorEvent, SorEventType } from "../sor/events.js";
import { GENESIS_HASH, signEvent } from "../sor/signer.js";

export interface AgentRegistryRow {
  role: string;
  metadata: Record<string, unknown>;
  rules: Record<string, unknown>;
  source_hash: string; // sha256 hex of the source agents/<role>.md
}

interface ChainRow {
  seq: string;
  hash: string;
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
  created_at: Date;
}

function requireSigningKey(): string {
  const key = process.env.SOR_SIGNING_KEY;
  if (!key || key.length === 0) {
    throw new Error(
      "SOR_SIGNING_KEY is not set. Configure it in .env or export it before appending/verifying audit events."
    );
  }
  return key;
}

/** Idempotent: ensure the singleton sor_chain row exists (id=1, seq=0, hash=GENESIS_HASH). */
export async function ensureChain(pool: Pool): Promise<void> {
  await pool.query(
    "INSERT INTO sor_chain (id, seq, hash) VALUES (1, 0, $1) ON CONFLICT (id) DO NOTHING",
    [GENESIS_HASH]
  );
}

/** Single-writer append. Transactional; row-locks the chain tail before signing + inserting. */
export async function appendAuditEvent(pool: Pool, event: SorEvent): Promise<void> {
  const key = requireSigningKey();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const chainResult = await client.query<ChainRow>(
      "SELECT seq, hash FROM sor_chain WHERE id = 1 FOR UPDATE"
    );
    const chain = chainResult.rows[0];
    if (!chain) {
      throw new Error("sor_chain (id=1) missing — call ensureChain() before appending audit events");
    }

    const nextSeq = Number(chain.seq) + 1;
    const normalized = { ...event, created_at: new Date(event.created_at).toISOString() };
    const hash = signEvent(key, chain.hash, normalized);

    await client.query(
      `INSERT INTO audit_events
        (run_id, seq, event_type, actor, backend, tool_name, tool_input, tool_output, payload, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.run_id,
        nextSeq,
        event.event_type,
        event.actor,
        event.backend,
        event.tool_name,
         event.tool_input ?? null,
         event.tool_output ?? null,
         event.payload,
         chain.hash,
         hash,
         normalized.created_at,
      ]
    );

    await client.query(
      "UPDATE sor_chain SET seq = $1, hash = $2, updated_at = now() WHERE id = 1",
      [nextSeq, hash]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Upsert each row into agent_registry by role (single atomic multi-row upsert). */
export async function syncAgentRegistry(pool: Pool, rows: AgentRegistryRow[]): Promise<void> {
  if (rows.length === 0) return;

  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of rows) {
    const i = params.length;
    tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
    params.push(row.role, row.metadata, row.rules, row.source_hash);
  }

  await pool.query(
    `INSERT INTO agent_registry (role, metadata, rules, source_hash)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (role) DO UPDATE
       SET metadata = EXCLUDED.metadata,
           rules = EXCLUDED.rules,
           source_hash = EXCLUDED.source_hash,
           synced_at = now()`,
    params
  );
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
export async function verifyChain(
  pool: Pool
): Promise<{ ok: boolean; firstBadSeq: number | null; total: number; counts: Record<string, number> }> {
  const key = requireSigningKey();
  const result = await pool.query<AuditEventRow>(
    `SELECT run_id, seq, event_type, actor, backend, tool_name,
            tool_input, tool_output, payload, prev_hash, hash, created_at
     FROM audit_events
     ORDER BY seq ASC`
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
    const recomputed = signEvent(key, row.prev_hash, eventFromRow(row));
    if (recomputed !== row.hash) {
      firstBadSeq = Number(row.seq);
      continue;
    }
    prevHash = row.hash;
  }

  return { ok: firstBadSeq === null, firstBadSeq, total: rows.length, counts };
}
