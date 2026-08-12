// Hiring API — hire/retire worker roles against policy limits, backed by the
// worker_roles table. All quotas derive from active (pending/running) workers.

import { pool } from "../db/client.js";
import type { WorkforcePolicy } from "./policy.js";

const ACTIVE_STATUSES = ["pending", "running"];
const VALID_STATUSES = ["pending", "running", "success", "failed", "retired"];

interface WorkerIdRow {
  role_id: string;
}

interface CountRow {
  count: string;
}

export interface CanHireResult {
  allowed: boolean;
  reason?: string;
}

export async function canHire(
  role_name: string,
  backend: string,
  policy: WorkforcePolicy
): Promise<CanHireResult> {
  if (!policy.authorized_roles.includes(role_name)) {
    return { allowed: false, reason: "role not authorized" };
  }
  if (policy.deny_hire_roles.includes(role_name)) {
    return { allowed: false, reason: "role is denied" };
  }

  const backendLimit = policy.max_per_backend[backend];
  if (backendLimit !== undefined && backendLimit >= 0) {
    const backendActive = await countActiveByBackend(backend);
    if (backendActive >= backendLimit) {
      return {
        allowed: false,
        reason: `backend '${backend}' at max (${backendActive}/${backendLimit})`,
      };
    }
  }

  const totalActive = await countActiveTotal();
  if (totalActive >= policy.max_concurrent_workers) {
    return {
      allowed: false,
      reason: `max concurrent workers reached (${totalActive}/${policy.max_concurrent_workers})`,
    };
  }

  return { allowed: true };
}

async function countActiveByBackend(backend: string): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT COUNT(*) AS count FROM worker_roles
     WHERE backend = $1 AND status = ANY($2)`,
    [backend, ACTIVE_STATUSES]
  );
  const row = result.rows[0];
  return Number(row?.count ?? "0");
}

async function countActiveTotal(): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT COUNT(*) AS count FROM worker_roles
     WHERE status = ANY($1)`,
    [ACTIVE_STATUSES]
  );
  const row = result.rows[0];
  return Number(row?.count ?? "0");
}

export async function hireWorker(
  role_name: string,
  backend: string,
  model: string,
  policy: WorkforcePolicy
): Promise<string> {
  const check = await canHire(role_name, backend, policy);
  if (!check.allowed) {
    throw new Error(`Cannot hire '${role_name}': ${check.reason ?? "not allowed"}`);
  }

  const result = await pool.query<WorkerIdRow>(
    `INSERT INTO worker_roles (run_id, role_name, model, backend, permissions, status, created_at)
     VALUES (NULL, $1, $2, $3, NULL, 'pending', now())
     RETURNING role_id`,
    [role_name, model, backend]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("hireWorker failed to retrieve role_id");
  }
  return row.role_id;
}

export async function updateWorkerStatus(
  worker_id: string,
  status: string,
  output_path?: string
): Promise<void> {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(
      `Invalid worker status "${status}". Must be one of: ${VALID_STATUSES.join(", ")}`
    );
  }

  const permissions = output_path && output_path.length > 0 ? { output_path } : null;
  await pool.query(
    `UPDATE worker_roles
     SET status = $2, ended_at = now(), permissions = $3
     WHERE role_id = $1`,
    [worker_id, status, permissions === null ? null : JSON.stringify(permissions)]
  );
}

export async function retireWorker(worker_id: string): Promise<void> {
  await pool.query(
    "UPDATE worker_roles SET status = 'retired', ended_at = now() WHERE role_id = $1",
    [worker_id]
  );
}