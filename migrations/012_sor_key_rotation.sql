-- migrations/011_sor_key_rotation.sql
-- SOR key rotation support

-- UP:
ALTER TABLE audit_events ADD COLUMN key_id TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE sor_chain ADD COLUMN key_id TEXT NOT NULL DEFAULT 'v1';

-- DOWN:
ALTER TABLE audit_events DROP COLUMN key_id;
ALTER TABLE sor_chain DROP COLUMN key_id;
