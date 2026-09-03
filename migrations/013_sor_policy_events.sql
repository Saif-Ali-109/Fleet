-- migrations/013_sor_policy_events.sql
-- Widen audit_events.event_type CHECK to accept the six Policy SoR event types:
-- policy_state, policy_sync, policy_decision, content_sync, content_access, context_update.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'tool_call','wakeup','phase','registry_sync','finalize','model_switch',
    'model_recovered','all_models_exhausted','run_paused','run_resumed',
    'reservation','reservation_rejection','provider_completion','retry',
    'policy_state','policy_sync','policy_decision','content_sync','content_access','context_update'
  ));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN (
    'tool_call','wakeup','phase','registry_sync','finalize','model_switch',
    'model_recovered','all_models_exhausted','run_paused','run_resumed',
    'reservation','reservation_rejection','provider_completion','retry'
  ));