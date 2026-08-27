// Database client — pg.Pool wrapper with typed query methods.
// Shared by the orchestrator (src/orchestrator.ts) and the MCP server (src/mcp/server.ts).

import pg from "pg";
import type { Pool as PoolType } from "pg";
import type { RunOutcome } from "./schema.ts";

const { Pool } = pg;

// The pg.Pool is built LAZILY so the module can be imported with no
// DATABASE_URL set (e.g. `npm run dry` with zero DB setup). Import never
// throws; the first real query builds the pool and throws there if
// DATABASE_URL is missing.
let lazyPool: PoolType | null = null;

function getPool(): PoolType {
  if (!lazyPool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. Configure it in .env or export it before starting."
      );
    }
    const poolSize = parseInt(process.env.DATABASE_POOL_SIZE ?? "10", 10);
    lazyPool = new Pool({
      connectionString: DATABASE_URL,
      max: poolSize,
    });
    lazyPool.on("error", (err: Error) => {
      console.error("[db] Pool error:", err.message);
    });
  }
  return lazyPool;
}

/** Named export that preserves the existing `import { pool }` shape. A Proxy
 *  that lazily builds the real pg.Pool on first property access, so call sites
 *  like `pool.query`, `ensureChain(pool)` and `appendAuditEvent(pool, …)` keep
 *  working unchanged. Methods are bound to the underlying pool. */
const pool: PoolType = new Proxy({} as PoolType, {
  get(target, prop: PropertyKey): unknown {
    // Honor overrides placed on the target (e.g. `vi.spyOn(pool, "query")` in
    // tests) before falling through to the lazily-built real pool.
    if (Object.prototype.hasOwnProperty.call(target, prop)) {
      return (target as unknown as Record<PropertyKey, unknown>)[prop];
    }
    const p = getPool();
    const value = (p as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(p) : value;
  },
  has(_target, prop: PropertyKey): boolean {
    return prop in getPool();
  },
});

interface CreateRunParams {
  repo: string;
  issue_number: number;
  backend: string;
}

interface UpdateRunStatusParams {
  run_id: string;
  phase: string;
  status: string;
  iteration: number;
}

interface LogAgentActionParams {
  run_id: string;
  role: string;
  model: string;
  ok: boolean;
  text: string;
  tokens: Record<string, unknown>;
  cost_usd: number;
  trace_path: string;
  started_at: Date;
  ended_at: Date;
  attempts: unknown[];
}

interface FinalizeRunParams {
  run_id: string;
  pr_url: string | null;
  total_cost: number;
  gate_status: string;
  status: string;
  /** Real iteration count; falls back to the max iteration recorded in gate_status. */
  iterationsUsed?: number;
}

class DbClient {
  async createRun(params: CreateRunParams): Promise<string> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // Repo is lowercased inside SQL on write and compared via lower(repo)
      // on read so GitHub slug casing can never fork run identity.
      const result = await client.query<{ run_id: string }>(
        `INSERT INTO run_outcomes (
          repo, issue_number, issue_title, status, total_cost_usd,
          iterations_used, started_at, completed_at, gate_status, backend
        ) VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (repo, issue_number) DO NOTHING
        RETURNING run_id`,
        [
          params.repo,
          params.issue_number,
          "",
          "running",
          0,
          0,
          new Date(),
          null,
          "{}",
          params.backend,
        ]
      );
      let row = result.rows[0];
      if (!row) {
        const existing = await client.query<{ run_id: string }>(
          "SELECT run_id FROM run_outcomes WHERE lower(repo) = lower($1) AND issue_number = $2 ORDER BY started_at DESC LIMIT 1",
          [params.repo, params.issue_number]
        );
        row = existing.rows[0];
      }
      await client.query("COMMIT");
      if (!row) {
        throw new Error("Failed to retrieve run_id after insert");
      }
      return row.run_id;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateRunStatus(params: UpdateRunStatusParams): Promise<boolean> {
    const patch = JSON.stringify({
      [params.phase]: { status: params.status, iteration: params.iteration },
    });
    const result = await getPool().query(
      "UPDATE run_outcomes SET gate_status = gate_status || $1::jsonb WHERE run_id = $2",
      [patch, params.run_id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async logAgentAction(params: LogAgentActionParams): Promise<string> {
    const client = await getPool().connect();
    try {
      const result = await client.query<{ action_id: string }>(
        `INSERT INTO agent_actions (
          run_id, role, model, ok, text, tokens, cost_usd, error,
          trace_path, started_at, ended_at, attempts
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING action_id`,
        [
          params.run_id,
          params.role,
          params.model,
          params.ok,
          params.text,
          JSON.stringify(params.tokens),
          params.cost_usd,
          null,
          params.trace_path,
          params.started_at,
          params.ended_at,
          JSON.stringify(params.attempts),
        ]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Failed to retrieve action_id after insert");
      }
      return row.action_id;
    } finally {
      client.release();
    }
  }

  async finalizeRun(params: FinalizeRunParams): Promise<boolean> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE run_outcomes
         SET pr_url = $1, total_cost_usd = $2, status = $3,
             completed_at = $4, gate_status = $5,
             iterations_used = COALESCE(
               $6,
               (SELECT MAX((v ->> 'iteration')::int)
                  FROM jsonb_each(gate_status) AS e(k, v)
                 WHERE jsonb_typeof(v) = 'object' AND v ? 'iteration'),
               iterations_used
             )
         WHERE run_id = $7`,
        [
          params.pr_url,
          params.total_cost,
          params.status,
          new Date(),
          params.gate_status,
          params.iterationsUsed ?? null,
          params.run_id,
        ]
      );
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getRun(run_id: string): Promise<RunOutcome | null> {
    const result = await getPool().query<RunOutcome & { gate_status: string }>(
      "SELECT * FROM run_outcomes WHERE run_id = $1",
      [run_id]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    let gateStatus: Record<string, unknown> = {};
    try {
      gateStatus = JSON.parse(row.gate_status);
    } catch {
      gateStatus = {};
    }

    return {
      ...row,
      gate_status: JSON.stringify(gateStatus),
    } as RunOutcome;
  }

  /**
   * Whether ANY run for this repo+issue has ever completed, matched
   * case-insensitively so `Owner/Repo` and `owner/repo` share one identity.
   * `getRunByRepoIssue` only looks at the single most recent row, so a
   * completed run followed by a later failed retry (e.g. a re-triggered
   * webhook) would report "not completed" even though the issue was already
   * fixed. This checks across all rows instead of relying on recency.
   */
  async hasCompletedRun(repo: string, issue_number: number): Promise<boolean> {
    const result = await getPool().query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM run_outcomes WHERE lower(repo) = lower($1) AND issue_number = $2 AND status = 'completed') AS exists",
      [repo, issue_number]
    );
    return result.rows[0]?.exists === true;
  }

  async getRunByRepoIssue(repo: string, issue_number: number): Promise<RunOutcome | null> {
    const result = await getPool().query<RunOutcome & { gate_status: string }>(
      "SELECT * FROM run_outcomes WHERE lower(repo) = lower($1) AND issue_number = $2 ORDER BY started_at DESC LIMIT 1",
      [repo, issue_number]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    let gateStatus: Record<string, unknown> = {};
    try {
      gateStatus = JSON.parse(row.gate_status);
    } catch {
      gateStatus = {};
    }

    return {
      ...row,
      gate_status: JSON.stringify(gateStatus),
    } as RunOutcome;
  }

  async close(): Promise<void> {
    if (lazyPool) {
      await lazyPool.end();
    }
  }
}

const db = new DbClient();

export { db, pool, DbClient };
export type {
  CreateRunParams,
  UpdateRunStatusParams,
  LogAgentActionParams,
  FinalizeRunParams,
};
