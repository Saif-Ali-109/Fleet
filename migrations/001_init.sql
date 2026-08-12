-- migrations/001_init.sql
-- Initial schema: system of record tables for runs, traces, actions, and cost.

-- UP:
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE run_outcomes (
  run_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo             TEXT NOT NULL,
  issue_number     INTEGER NOT NULL,
  issue_title      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed')),
  pr_url           TEXT,
  total_cost_usd   NUMERIC NOT NULL,
  iterations_used  INTEGER NOT NULL,
  started_at       TIMESTAMP NOT NULL,
  completed_at     TIMESTAMP,
  gate_status      JSONB NOT NULL,
  backend          TEXT NOT NULL
);

CREATE TABLE trace_events (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES run_outcomes(run_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  model       TEXT NOT NULL,
  event_seq   INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  tokens      JSONB NOT NULL,
  cost_usd    NUMERIC NOT NULL,
  trace_path  TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE agent_actions (
  action_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES run_outcomes(run_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  model       TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  text        TEXT NOT NULL,
  tokens      JSONB NOT NULL,
  cost_usd    NUMERIC NOT NULL,
  error       TEXT,
  trace_path  TEXT NOT NULL,
  started_at  TIMESTAMP NOT NULL,
  ended_at    TIMESTAMP NOT NULL,
  attempts    JSONB NOT NULL
);

CREATE TABLE cost_ledger (
  entry_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES run_outcomes(run_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  model       TEXT NOT NULL,
  backend     TEXT NOT NULL,
  tokens      JSONB NOT NULL,
  cost_usd    NUMERIC NOT NULL,
  action_type TEXT NOT NULL,
  trace_path  TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- DOWN:
DROP TABLE IF EXISTS cost_ledger;
DROP TABLE IF EXISTS agent_actions;
DROP TABLE IF EXISTS trace_events;
DROP TABLE IF EXISTS run_outcomes;
