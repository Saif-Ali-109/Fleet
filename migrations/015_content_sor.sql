-- migrations/015_content_sor.sql
-- Content SoR v1: authoritative content store + derived chunk index with pgvector.
-- Requires Postgres ≥ 14 with pgvector extension available on the deploy target.

-- UP:
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE content_sor (
	source_id        TEXT NOT NULL,
	namespace        TEXT NOT NULL DEFAULT 'fleet',
	version          INTEGER NOT NULL,
	hash             TEXT NOT NULL,
	canonical_content TEXT NOT NULL,
	metadata         JSONB NOT NULL DEFAULT '{}',
	provenance       JSONB NOT NULL DEFAULT '{}',
	status           TEXT NOT NULL DEFAULT 'active',
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (source_id, version)
);

CREATE TABLE content_chunks (
	doc_id        TEXT NOT NULL,
	version       INTEGER NOT NULL,
	section       TEXT NOT NULL,
	chunk_index   INTEGER NOT NULL,
	text          TEXT NOT NULL,
	content_hash  TEXT NOT NULL,
	embedding     vector(1536),
	ref           JSONB NOT NULL,
	PRIMARY KEY (doc_id, version, chunk_index)
);

CREATE INDEX content_chunks_doc_version_idx ON content_chunks (doc_id, version);
CREATE INDEX content_chunks_text_fts_idx ON content_chunks USING GIN (to_tsvector('english', text));

-- DOWN:
DROP INDEX IF EXISTS content_chunks_text_fts_idx;
DROP INDEX IF EXISTS content_chunks_doc_version_idx;
DROP TABLE IF EXISTS content_chunks;
DROP TABLE IF EXISTS content_sor;
DROP EXTENSION IF EXISTS vector;