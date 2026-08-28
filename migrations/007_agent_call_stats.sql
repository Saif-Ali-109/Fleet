-- migrations/007_agent_call_stats.sql
-- Per-agent call counters: tool calls, model API calls, skill loads.

-- UP:
CREATE TABLE agent_call_stats (
  stat_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID REFERENCES run_outcomes(run_id),
  role           TEXT NOT NULL,
  model          TEXT,
  provider       TEXT,
  session_id     TEXT,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  model_calls    INTEGER NOT NULL DEFAULT 0,
  skill_loads    INTEGER NOT NULL DEFAULT 0,
  tool_breakdown JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (run_id, role)
);

CREATE INDEX idx_agent_call_stats_run_id ON agent_call_stats (run_id);

-- DOWN:
DROP TABLE IF EXISTS agent_call_stats;
