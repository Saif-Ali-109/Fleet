-- migrations/006_audit_backends.sql
-- Widen audit_events.backend CHECK to accept the provider-era backends
-- (gemini, openrouter, ollama) alongside the legacy CLI fleet values.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_backend_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_backend_check
  CHECK (backend IN ('opencode', 'claude', 'codex', 'gemini', 'openrouter', 'ollama'));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_backend_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_backend_check
  CHECK (backend IN ('opencode', 'claude', 'codex'));
