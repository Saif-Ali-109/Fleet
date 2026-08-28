-- migrations/008_sor_quota_events.sql
-- Widen audit_events.event_type CHECK to accept the Gemini rate-limit
-- lifecycle events (PLAN.md "Rate-limit fallback system"): model_switch,
-- model_recovered, all_models_exhausted.

-- UP:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize', 'model_switch', 'model_recovered', 'all_models_exhausted'));

-- DOWN:
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_type_check
  CHECK (event_type IN ('tool_call', 'wakeup', 'phase', 'registry_sync', 'finalize'));
