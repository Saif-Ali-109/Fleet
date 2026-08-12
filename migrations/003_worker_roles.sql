-- migrations/003_worker_roles.sql
-- Dynamic workforce: hireable/retirable worker roles without editing opencode.json.

-- UP:
CREATE TABLE worker_roles (
  role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES run_outcomes(run_id) ON DELETE CASCADE,
  role_name TEXT NOT NULL,
  model TEXT,
  backend TEXT,
  permissions JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'retired')),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  started_at TIMESTAMP,
  ended_at TIMESTAMP
);

-- DOWN:
DROP TABLE IF EXISTS worker_roles;