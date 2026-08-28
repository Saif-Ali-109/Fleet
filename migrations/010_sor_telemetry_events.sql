-- migrations/010_sor_telemetry_events.sql
-- Widen audit_events.event_type CHECK to accept new SOR telemetry events:
-- reservation, reservation_rejection, provider_completion, retry

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize', 'model_switch', 'model_recovered', 'all_models_exhausted', 'run_paused', 'run_resumed', 'reservation', 'reservation_rejection', 'provider_completion', 'retry'));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize', 'model_switch', 'model_recovered', 'all_models_exhausted', 'run_paused', 'run_resumed'));