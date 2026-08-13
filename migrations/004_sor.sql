-- migrations/004_sor.sql
-- Signed system of record: tamper-evident audit log, chain tail pointer, agent registry.

-- UP:
CREATE TABLE audit_events (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       TEXT,
  seq          BIGINT NOT NULL UNIQUE,
  event_type   TEXT NOT NULL CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize')),
  actor        TEXT NOT NULL,
  backend      TEXT CHECK (backend IN ('opencode', 'claude', 'codex')),
  tool_name    TEXT,
  tool_input   JSONB,
  tool_output  JSONB,
  payload      JSONB NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_run_id ON audit_events (run_id);
CREATE INDEX idx_audit_events_created_at ON audit_events (created_at);

CREATE TABLE sor_chain (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  seq        BIGINT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

INSERT INTO sor_chain (id, seq, hash) VALUES (1, 0, '6d756c74692d6f726368657374726174696f6e2d736f722d67656e65736973');

CREATE TABLE agent_registry (
  role        TEXT PRIMARY KEY,
  metadata    JSONB NOT NULL,
  rules       JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  synced_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- DOWN:
DROP TABLE IF EXISTS agent_registry;
DROP TABLE IF EXISTS sor_chain;
DROP TABLE IF EXISTS audit_events;
