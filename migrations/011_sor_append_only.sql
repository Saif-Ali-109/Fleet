-- migrations/011_sor_append_only.sql
-- Create append-only trigger on audit_events to prevent UPDATE/DELETE

-- UP:
CREATE OR REPLACE FUNCTION prevent_audit_events_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events table is append-only: UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_events_update_delete();

-- DOWN:
DROP TRIGGER IF EXISTS audit_events_append_only_trigger ON audit_events;
DROP FUNCTION IF EXISTS prevent_audit_events_update_delete();