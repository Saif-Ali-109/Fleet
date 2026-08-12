// Database client — pg.Pool wrapper with typed query methods.
// Shared by the orchestrator (src/orchestrator.ts) and the MCP server (src/mcp/server.ts).

import pg from "pg";
import type { RunOutcome } from "./schema.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Configure it in .env or export it before starting."
  );
}

const poolSize = parseInt(process.env.DATABASE_POOL_SIZE ?? "10", 10);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: poolSize,
});

pool.on("error", (err) => {
  console.error("[db] Pool error:", err.message);
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
}

interface LogTraceEvent {
  run_id: string;
  role: string;
  model: string;
  event_seq: number;
  event_type: string;
  tokens: Record<string, unknown>;
  cost_usd: number;
  trace_path: string;
  created_at: Date;
}

interface LogCostLedgerParams {
  run_id: string;
  role: string;
  model: string;
  backend: string;
  tokens: Record<string, unknown>;
  cost_usd: number;
  action_type: string;
  trace_path: string | null;
}

class DbClient {
  async createRun(params: CreateRunParams): Promise<string> {
    const existing = await this.getRunByRepoIssue(params.repo, params.issue_number);
    if (existing) {
      return existing.run_id;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ run_id: string }>(
        `INSERT INTO run_outcomes (
          repo, issue_number, issue_title, status, total_cost_usd,
          iterations_used, started_at, completed_at, gate_status, backend
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      await client.query("COMMIT");
      const row = result.rows[0];
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
    const client = await pool.connect();
    try {
      const current = await client.query<{ gate_status: string }>(
        "SELECT gate_status FROM run_outcomes WHERE run_id = $1",
        [params.run_id]
      );
      if (current.rowCount === 0) {
        return false;
      }

      const row = current.rows[0];
      if (!row) {
        return false;
      }

      let gateStatus: Record<string, unknown> = {};
      try {
        gateStatus = JSON.parse(row.gate_status);
      } catch {
        gateStatus = {};
      }

      gateStatus[params.phase] = { status: params.status, iteration: params.iteration };

      await client.query(
        "UPDATE run_outcomes SET gate_status = $1 WHERE run_id = $2",
        [JSON.stringify(gateStatus), params.run_id]
      );
      return true;
    } finally {
      client.release();
    }
  }

  async logAgentAction(params: LogAgentActionParams): Promise<string> {
    const client = await pool.connect();
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE run_outcomes
         SET pr_url = $1, total_cost_usd = $2, status = $3,
             completed_at = $4, gate_status = $5
         WHERE run_id = $6`,
        [
          params.pr_url,
          params.total_cost,
          "completed",
          new Date(),
          params.gate_status,
          params.run_id,
        ]
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getRun(run_id: string): Promise<RunOutcome | null> {
    const result = await pool.query<RunOutcome & { gate_status: string }>(
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

  async getRunByRepoIssue(repo: string, issue_number: number): Promise<RunOutcome | null> {
    const result = await pool.query<RunOutcome & { gate_status: string }>(
      "SELECT * FROM run_outcomes WHERE repo = $1 AND issue_number = $2 ORDER BY started_at DESC LIMIT 1",
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

  async logTraceEvents(events: LogTraceEvent[]): Promise<void> {
    if (events.length === 0) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO trace_events (
            run_id, role, model, event_seq, event_type,
            tokens, cost_usd, trace_path, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.run_id,
            event.role,
            event.model,
            event.event_seq,
            event.event_type,
            JSON.stringify(event.tokens),
            event.cost_usd,
            event.trace_path,
            event.created_at,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async logCostLedger(params: LogCostLedgerParams): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO cost_ledger (
          run_id, role, model, backend, tokens,
          cost_usd, action_type, trace_path, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.run_id,
          params.role,
          params.model,
          params.backend,
          JSON.stringify(params.tokens),
          params.cost_usd,
          params.action_type,
          params.trace_path,
          new Date(),
        ]
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await pool.end();
  }
}

const db = new DbClient();

export { db, pool, DbClient };
export type {
  CreateRunParams,
  UpdateRunStatusParams,
  LogAgentActionParams,
  FinalizeRunParams,
  LogTraceEvent,
  LogCostLedgerParams,
};
