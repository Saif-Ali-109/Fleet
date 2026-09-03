-- migrations/014_agent_registry_policy.sql
-- Add Policy SoR versioning columns to agent_registry.
-- policy_hash is nullable and backfilled (canonicalized) at first manager boot (§21.3),
-- NOT by SQL here. policy_version defaults 1 (legacy rows = seeded v1).

-- UP:
ALTER TABLE agent_registry
  ADD COLUMN policy_hash TEXT,
  ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;

-- DOWN:
ALTER TABLE agent_registry
  DROP COLUMN policy_version,
  DROP COLUMN policy_hash;