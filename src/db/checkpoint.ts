// Checkpoint API — durable per-step status tracking for pause/resume.
// Wraps the shared pool from ./client.js backed by the agent_steps table.

import { pool } from "./client.ts";

interface StepIdRow {
  step_id: string;
}

interface StepNameRow {
  step_name: string;
}

async function startStep(
  run_id: string,
  role: string,
  iteration: number,
  step_name: string
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<StepIdRow>(
      `INSERT INTO agent_steps (run_id, role, iteration, step_name, status, started_at)
       VALUES ($1, $2, $3, $4, 'pending', now())
       RETURNING step_id`,
      [run_id, role, iteration, step_name]
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("startStep failed to retrieve step_id");
    }
    await client.query(
      "UPDATE agent_steps SET status = 'running' WHERE step_id = $1",
      [row.step_id]
    );
    await client.query("COMMIT");
    return row.step_id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markStepSuccess(step_id: string): Promise<void> {
  await pool.query(
    "UPDATE agent_steps SET status = 'success', completed_at = now() WHERE step_id = $1",
    [step_id]
  );
}

async function markStepFailed(step_id: string, error: string): Promise<void> {
  await pool.query(
    "UPDATE agent_steps SET status = 'failed', error_message = $2, completed_at = now() WHERE step_id = $1",
    [step_id, error]
  );
}

async function getCompletedSteps(
  run_id: string,
  role: string,
  iteration: number
): Promise<string[]> {
  const result = await pool.query<StepNameRow>(
    `SELECT step_name FROM agent_steps
     WHERE run_id = $1 AND role = $2 AND iteration = $3 AND status = 'success'
     ORDER BY started_at`,
    [run_id, role, iteration]
  );
  return result.rows.map((row) => row.step_name);
}

async function getLastFailedStep(
  run_id: string,
  role: string
): Promise<string | null> {
  const result = await pool.query<StepNameRow>(
    `SELECT step_name FROM agent_steps
     WHERE run_id = $1 AND role = $2 AND status = 'failed'
     ORDER BY started_at DESC LIMIT 1`,
    [run_id, role]
  );
  const row = result.rows[0];
  return row ? row.step_name : null;
}

const checkpoint = {
  startStep,
  markStepSuccess,
  markStepFailed,
  getCompletedSteps,
  getLastFailedStep,
};

export { checkpoint, startStep, markStepSuccess, markStepFailed, getCompletedSteps, getLastFailedStep };