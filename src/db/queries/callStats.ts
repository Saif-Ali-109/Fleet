import type { Pool } from "pg";

export interface AgentCallStats {
  role: string;
  model: string | null;
  provider: string | null;
  sessionId: string | null;
  toolCalls: number;
  modelCalls: number;
  skillLoads: number;
  toolBreakdown: Record<string, number>;
}

export interface SessionCallTotals {
  tools: number;
  models: number;
  skills: number;
}

/** Upsert per-agent call stats. Non-fatal: warns on error, never throws. */
export async function upsertAgentCallStats(
  pool: Pool,
  runId: string,
  stats: AgentCallStats,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO agent_call_stats (run_id, role, model, provider, session_id, tool_calls, model_calls, skill_loads, tool_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (run_id, role) DO UPDATE SET
         model = EXCLUDED.model,
         provider = EXCLUDED.provider,
         session_id = EXCLUDED.session_id,
         tool_calls = EXCLUDED.tool_calls,
         model_calls = EXCLUDED.model_calls,
         skill_loads = EXCLUDED.skill_loads,
         tool_breakdown = EXCLUDED.tool_breakdown`,
      [runId, stats.role, stats.model, stats.provider, stats.sessionId,
       stats.toolCalls, stats.modelCalls, stats.skillLoads,
       JSON.stringify(stats.toolBreakdown)],
    );
  } catch (err) {
    console.warn("[callStats] upsert failed (non-fatal):", (err as Error).message);
  }
}

/** Sum call counters across all 6 agents for a given run. Returns zeros if no rows. */
export async function sessionCallTotals(
  pool: Pool,
  runId: string,
): Promise<SessionCallTotals> {
  try {
    const res = await pool.query(
      `SELECT COALESCE(SUM(tool_calls), 0)::int AS tools,
              COALESCE(SUM(model_calls), 0)::int AS models,
              COALESCE(SUM(skill_loads), 0)::int AS skills
       FROM agent_call_stats WHERE run_id = $1`,
      [runId],
    );
    const row = res.rows[0];
    return { tools: row.tools, models: row.models, skills: row.skills };
  } catch (err) {
    console.warn("[callStats] totals query failed (non-fatal):", (err as Error).message);
    return { tools: 0, models: 0, skills: 0 };
  }
}
