-- migrations/002_agent_steps.sql
-- Durable checkpointing: per-step status tracking for resume support.

-- UP:
CREATE TABLE agent_steps (
  step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES run_outcomes(run_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  iteration INT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- DOWN:
DROP TABLE IF EXISTS agent_steps;