-- migrations/009_quota_pause_events.sql
-- Widen audit_events.event_type CHECK to accept the PAUSE-on-exhaustion
-- lifecycle events (SPEC.md §11.5): run_paused, run_resumed.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize', 'model_switch', 'model_recovered', 'all_models_exhausted', 'run_paused', 'run_resumed'));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize', 'model_switch', 'model_recovered', 'all_models_exhausted'));
