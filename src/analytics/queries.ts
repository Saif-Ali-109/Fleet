// Cross-run analytics queries against agent_actions + run_outcomes.
// Shared by the report generator (src/analytics/report.ts).

import { pool } from "../db/client.ts";

export interface RoleRow {
  role: string;
  model: string;
  count: number;
  total_cost_usd: number;
  avg_cost_per_run: number;
  success_rate: number;
}

export interface BackendRow {
  backend: string;
  count: number;
  total_cost_usd: number;
  success_rate: number;
}

export interface IterationRow {
  iteration: number;
  count: number;
  total_cost_usd: number;
  success_rate: number;
}

export interface FailingRoleRow {
  role: string;
  model: string;
  failure_count: number;
  failure_rate: number;
}

/** Cost and success by agent role + model. */
export async function costPerRole(
  from: string,
  to: string,
  repo?: string
): Promise<RoleRow[]> {
  const result = await pool.query<RoleRow>(
    `SELECT
      a.role,
      a.model,
      COUNT(*)::int AS count,
      SUM(a.cost_usd)::float AS total_cost_usd,
      (SUM(a.cost_usd) / COUNT(*))::float AS avg_cost_per_run,
      AVG(CASE WHEN a.ok THEN 100 ELSE 0 END)::float AS success_rate
    FROM agent_actions a
    JOIN run_outcomes r ON a.run_id = r.run_id
    WHERE a.started_at >= $1 AND a.started_at < ($2::timestamp + interval '1 day')
      AND ($3::text IS NULL OR r.repo = $3)
    GROUP BY a.role, a.model
    ORDER BY a.role, a.model`,
    [from, to, repo ?? null]
  );
  return result.rows;
}

/** Cost and success by backend (via run_outcomes join). */
export async function costPerBackend(
  from: string,
  to: string,
  repo?: string
): Promise<BackendRow[]> {
  const result = await pool.query<BackendRow>(
    `SELECT
      r.backend,
      COUNT(a.action_id)::int AS count,
      SUM(a.cost_usd)::float AS total_cost_usd,
      AVG(CASE WHEN a.ok THEN 100 ELSE 0 END)::float AS success_rate
    FROM agent_actions a
    JOIN run_outcomes r ON a.run_id = r.run_id
    WHERE a.started_at >= $1 AND a.started_at < ($2::timestamp + interval '1 day')
      AND ($3::text IS NULL OR r.repo = $3)
    GROUP BY r.backend
    ORDER BY r.backend`,
    [from, to, repo ?? null]
  );
  return result.rows;
}

/** Cost and success by iteration count of the run. */
export async function costPerIteration(
  from: string,
  to: string,
  repo?: string
): Promise<IterationRow[]> {
  const result = await pool.query<IterationRow>(
    `SELECT
      iterations_used AS iteration,
      COUNT(*)::int AS count,
      SUM(total_cost_usd)::float AS total_cost_usd,
      AVG(CASE WHEN status = 'completed' THEN 100 ELSE 0 END)::float AS success_rate
    FROM run_outcomes
    WHERE started_at >= $1 AND started_at < ($2::timestamp + interval '1 day')
      AND ($3::text IS NULL OR repo = $3)
    GROUP BY iterations_used
    ORDER BY iterations_used`,
    [from, to, repo ?? null]
  );
  return result.rows;
}

/** Top failing roles by failure count within the window. */
export async function topFailingRoles(
  from: string,
  to: string,
  repo?: string,
  limit: number = 10
): Promise<FailingRoleRow[]> {
  const result = await pool.query<FailingRoleRow>(
    `SELECT
      a.role,
      a.model,
      COUNT(*)::int AS failure_count,
      (COUNT(*)::float / NULLIF((SELECT COUNT(*)::float FROM agent_actions fa
         JOIN run_outcomes fr ON fa.run_id = fr.run_id
         WHERE fa.started_at >= $1 AND fa.started_at < ($2::timestamp + interval '1 day')
           AND fa.role = a.role AND fa.model = a.model
           AND ($3::text IS NULL OR fr.repo = $3)), 0))::float * 100 AS failure_rate
    FROM agent_actions a
    JOIN run_outcomes r ON a.run_id = r.run_id
    WHERE a.started_at >= $1 AND a.started_at < ($2::timestamp + interval '1 day') AND a.ok = false
      AND ($3::text IS NULL OR r.repo = $3)
    GROUP BY a.role, a.model
    ORDER BY failure_count DESC
    LIMIT $4`,
    [from, to, repo ?? null, limit]
  );
  return result.rows;
}