-- migrations/016_context_sor.sql
-- Context SoR v1: freshness-tracked context sources with operational state.

-- UP:
CREATE TABLE context_sor (
	source_id         TEXT NOT NULL,
	namespace         TEXT NOT NULL DEFAULT 'fleet',
	version           INTEGER NOT NULL,
	hash              TEXT NOT NULL,
	category          TEXT NOT NULL,
	operational_state JSONB NOT NULL DEFAULT '{}',
	fresh_until       TIMESTAMPTZ,
	stale_after       TIMESTAMPTZ,
	status            TEXT NOT NULL DEFAULT 'active',
	created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (source_id, version)
);

-- DOWN:
DROP TABLE IF EXISTS context_sor;
