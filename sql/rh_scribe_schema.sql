-- rh_scribe schema — scribe dual-write shadow + transcript full-text search.
-- PLAN-2026-06-11-scribe-postgres-fts.md Phase 1. Idempotent: safe to re-apply.
-- Apply: psql -U rh_scribe -h localhost -d rh_scribe -w -f sql/rh_scribe_schema.sql
-- Rollback: DROP DATABASE rh_scribe (md files remain canonical throughout).

CREATE TABLE IF NOT EXISTS scribe_rows (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL CHECK (bucket IN ('recommendations','cleanup','learnings')),
  row_id      text NOT NULL,
  session_id  text,
  ts          timestamptz,
  content     text NOT NULL,
  status      text,
  source_file text,
  raw_line    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, row_id)
);

CREATE TABLE IF NOT EXISTS transcripts (
  session_id       text PRIMARY KEY,
  project_slug     text,
  path             text NOT NULL,
  first_ts         timestamptz,
  last_ts          timestamptz,
  message_count    int NOT NULL DEFAULT 0,
  -- byte offset already ingested; incremental re-ingest resumes here
  ingested_through bigint NOT NULL DEFAULT 0,
  ingested_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcript_messages (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES transcripts(session_id) ON DELETE CASCADE,
  turn        int,
  role        text NOT NULL,
  ts          timestamptz,
  content     text NOT NULL,
  -- left() guards the 1 MB tsvector input limit on pathological messages
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(content, 1048575))) STORED
);

CREATE INDEX IF NOT EXISTS transcript_messages_tsv_gin
  ON transcript_messages USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS transcript_messages_session
  ON transcript_messages (session_id);
CREATE INDEX IF NOT EXISTS scribe_rows_bucket_status
  ON scribe_rows (bucket, status);

-- Log entries (supervisory log, oversight events, telemetry failures, …)
-- Added 2026-06-11 (log-FTS extension). Same idempotent convention.
CREATE TABLE IF NOT EXISTS log_entries (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  seq         int NOT NULL,
  ts          timestamptz,
  content     text NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(content, 1048575))) STORED,
  UNIQUE (source, seq)
);
CREATE INDEX IF NOT EXISTS log_entries_tsv_gin ON log_entries USING GIN (content_tsv);

CREATE TABLE IF NOT EXISTS ingest_offsets (
  source           text PRIMARY KEY,
  ingested_through bigint NOT NULL DEFAULT 0,
  entries          int NOT NULL DEFAULT 0,
  ingested_at      timestamptz NOT NULL DEFAULT now()
);
