-- migrations/017_audit_backends_groq.sql
-- Widen audit_events.backend CHECK to accept the Groq provider alongside the
-- existing provider-era (gemini, openrouter, ollama) and legacy CLI backends.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_backend_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_backend_check
  CHECK (backend IN ('opencode', 'claude', 'codex', 'gemini', 'openrouter', 'groq', 'ollama'));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_backend_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_backend_check
  CHECK (backend IN ('opencode', 'claude', 'codex', 'gemini', 'openrouter', 'ollama'));
