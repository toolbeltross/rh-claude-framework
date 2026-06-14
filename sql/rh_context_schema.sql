-- rh_context schema — unified data model for Claude-generated context.
-- Per DELIBERATION-2026-06-13-context-data-model.md (14-agent panel) +
-- PLAN-2026-06-13-context-db.md. The "second database" is realized as
-- ctx_-namespaced tables INSIDE the existing rh_scribe DB (user decision:
-- extend rh_scribe so memory_artifact<->transcript_messages joins stay
-- single-DB). Idempotent: safe to re-apply.
--
-- Apply:    psql -U rh_scribe -h localhost -d rh_scribe -w -f sql/rh_context_schema.sql
-- Rollback: DROP every ctx_* table (md/jsonl remain canonical throughout).
--
-- SCOPE: Phase-1 spine + enriched telemetry. The graph/PKM layer
-- (link / tag / artifact_tag), trend_snapshot, and the standalone
-- fact_version ledger are DEFERRED to phase 2 (steward: zero wikilinks
-- today; memory_artifact carries inline temporal columns for now).
-- Requires PostgreSQL 18 (uuidv7()).

-- ============================================================ spine ========

-- One row per Claude session — the canonical join hub. Resolves the
-- 8-char(md) vs full-UUID(transcripts/events) mismatch ONCE: the full UUID
-- is the reference everywhere; the generated short id is a lookup handle for
-- legacy 8-char scribe rows only.
CREATE TABLE IF NOT EXISTS ctx_session (
  session_uuid    uuid PRIMARY KEY,
  session_sid8    text GENERATED ALWAYS AS (left(session_uuid::text, 8)) STORED,
  project_slug    text,
  cwd             text,
  entrypoint      text,
  primary_model   text,
  first_ts        timestamptz,
  last_ts         timestamptz,
  duration_ms     bigint,
  message_count   int,
  tool_call_count int,
  compaction_count int,
  context_peak_pct numeric,
  ingested_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ctx_session_sid8 ON ctx_session (session_sid8);

-- Backfill-only map from the irreversible 8-char md session id to a full
-- UUID, flagging collisions instead of silently picking one. Go-forward
-- writers capture the full UUID directly, so this is history-only.
CREATE TABLE IF NOT EXISTS ctx_session_attribution (
  session_short   text NOT NULL,
  session_full    uuid NOT NULL,
  resolution_source text,
  collision_count int NOT NULL DEFAULT 1,
  resolved_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_short, session_full)
);

-- Provenance + privacy spine: every content row traces to a canonical
-- md/jsonl source range with a RECORDED, ENFORCED privacy disposition.
-- This is what makes the DB a reversible shadow, not a second canon
-- (steward BLOCK 2: disposition must be non-null + constrained; prose
-- sources default to 'review-required' until content-scanned).
CREATE TABLE IF NOT EXISTS ctx_ingest_source (
  source_id        uuid PRIMARY KEY DEFAULT uuidv7(),
  canonical_path   text NOT NULL,
  source_kind      text NOT NULL,         -- scribe_md | learnings_md | transcript_jsonl | oversight_jsonl | telemetry_jsonl | prose_md
  ingested_through bigint NOT NULL DEFAULT 0,
  content_sha256   text,
  privacy_disposition text NOT NULL DEFAULT 'review-required'
    CHECK (privacy_disposition IN ('clean','blocklisted-skipped','redacted','review-required')),
  blocklist_version text NOT NULL DEFAULT 'unknown',
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  UNIQUE (canonical_path, source_kind)
);

-- ====================================================== content (hot) ======

-- Polymorphic curated retrieval node — one row per individually-addressable
-- distilled unit Claude can selectively load. body_distilled = curated
-- content; raw_line = verbatim md line (parity). Inline bi-temporal columns
-- (t_valid/t_invalid/superseded_by) ARE the queried truth (no separate
-- ledger in phase 1). Natural key (bucket, source_file, row_id) — matches
-- the migrated scribe_rows key so the two shadows reconcile.
CREATE TABLE IF NOT EXISTS ctx_memory_artifact (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  bucket          text NOT NULL CHECK (bucket IN
                    ('recommendations','cleanup','learnings','decision','incident','rollup','moc','session_state','code_review')),
  row_id          text NOT NULL,
  source_file     text NOT NULL,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE,
  memory_type     text CHECK (memory_type IN ('episodic','procedural','semantic')),
  severity        text CHECK (severity IN ('note','warn','block')),
  status          text CHECK (status IN ('open','active','resolved','stale','closed','invalidated')),
  session_id_full uuid,
  session_id_short text,
  title           text,
  body_distilled  text,
  raw_line        text,
  content_hash    text,
  ts              timestamptz,
  t_valid         timestamptz,
  t_invalid       timestamptz,
  superseded_by   uuid,
  last_recalled_at timestamptz,
  recall_count    int NOT NULL DEFAULT 0,
  token_estimate  int,
  frontmatter     jsonb,
  embedding_model_id text,                 -- pgvector deferred: column reserved, unpopulated
  body_tsv        tsvector GENERATED ALWAYS AS
                    (to_tsvector('english', left(coalesce(title,'') || ' ' || coalesce(body_distilled,''), 1048575))) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, source_file, row_id)
);
CREATE INDEX IF NOT EXISTS ctx_memory_artifact_tsv_gin ON ctx_memory_artifact USING GIN (body_tsv);
CREATE INDEX IF NOT EXISTS ctx_memory_artifact_session ON ctx_memory_artifact (session_id_full);
CREATE INDEX IF NOT EXISTS ctx_memory_artifact_bucket_status ON ctx_memory_artifact (bucket, status);
CREATE INDEX IF NOT EXISTS ctx_memory_artifact_active ON ctx_memory_artifact (bucket) WHERE t_invalid IS NULL;

-- Child observations of a learning artifact. Fixes the verified dual-write
-- gap (append-observation never reached Postgres) + makes recurrence
-- queryable. Incremental: one row per appended observation.
CREATE TABLE IF NOT EXISTS ctx_memory_observation (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  artifact_id     uuid REFERENCES ctx_memory_artifact(id) ON DELETE CASCADE,
  obs_date        date,
  session_id_full uuid,
  session_id_short text,
  observation     text NOT NULL,
  obs_hash        text NOT NULL,
  t_invalid       timestamptz,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, obs_hash)
);

-- ============================================== behavioral / telemetry =====

-- Typed oversight events (promoted from FTS-only log_entries). severity +
-- rule parsed at ingest so trend queries are GROUP BYs, not regex-over-prose.
CREATE TABLE IF NOT EXISTS ctx_oversight_event (
  id              bigserial PRIMARY KEY,
  ts              timestamptz,
  event_type      text NOT NULL,
  session_id      uuid,
  severity        text CHECK (severity IN ('note','warn','block')),
  rule_number     int,
  rule_ref        text,
  is_loop_break   boolean,
  consecutive_index int,
  data            jsonb,
  content_hash    text NOT NULL,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE,
  content_tsv     tsvector GENERATED ALWAYS AS
                    (to_tsvector('english', left(coalesce(data->>'reason','') || ' ' || coalesce(data::text,''), 1048575))) STORED,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS ctx_oversight_event_type_ts ON ctx_oversight_event (event_type, ts);
CREATE INDEX IF NOT EXISTS ctx_oversight_event_session ON ctx_oversight_event (session_id);

-- One row per tool failure. Retries are a self-edge (retry_of), never
-- independent rows — sum cost over retry_of IS NULL for unique-attempt cost,
-- over the whole chain for total burn.
CREATE TABLE IF NOT EXISTS ctx_telemetry_failure (
  id              text PRIMARY KEY,
  ts              timestamptz,
  session_id      uuid,
  tool_name       text,
  event_type      text,
  error_class     text CHECK (error_class IN
                    ('not_found','permission','size_limit','timeout','network','orphan','validation','config','other')),
  error           text,
  invocation_hash text,
  retry_of        text,
  retry_sequence  int,
  estimated_cost  numeric(12,6),
  duration_ms     bigint,
  prompt_id       text,
  prompt_snippet  text,
  cwd             text,
  tool_input      jsonb,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ctx_telemetry_failure_class ON ctx_telemetry_failure (error_class, ts);
CREATE INDEX IF NOT EXISTS ctx_telemetry_failure_session ON ctx_telemetry_failure (session_id);

-- Per-(session|day|agent) per-MODEL usage + cost. The clean answer to
-- "model cost" / "extended usage" — normalized rather than buried in jsonb.
CREATE TABLE IF NOT EXISTS ctx_model_usage (
  id              bigserial PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('session','day','agent')),
  session_id      uuid,
  agent_id        text,
  day             date,
  model_id        text NOT NULL,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  cache_read      bigint NOT NULL DEFAULT 0,
  cache_write     bigint NOT NULL DEFAULT 0,
  total_tokens    bigint GENERATED ALWAYS AS
                    (input_tokens + output_tokens + cache_read + cache_write) STORED,
  cost_usd        numeric(12,6) NOT NULL DEFAULT 0,
  message_count   int NOT NULL DEFAULT 0,
  ts              timestamptz,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE,
  UNIQUE (scope, session_id, agent_id, day, model_id)
);
CREATE INDEX IF NOT EXISTS ctx_model_usage_model ON ctx_model_usage (model_id, day);

-- Persisted per-session/day aggregates (today recomputed live + lost beyond
-- the live window). Rate columns are GENERATED so they're always correct:
-- tokens/min, output-tokens/min, cost/min, plus avg turn cost/duration.
CREATE TABLE IF NOT EXISTS ctx_telemetry_snapshot (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('session','day')),
  session_id      uuid,
  day             date,
  snapshot_ts     timestamptz NOT NULL DEFAULT now(),
  primary_model   text,
  wall_ms         bigint,                  -- active wall-clock for the rate denominators
  api_duration_ms bigint,
  tool_duration_ms bigint,
  total_cost      numeric(12,6) NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  cache_read      bigint NOT NULL DEFAULT 0,
  cache_write     bigint NOT NULL DEFAULT 0,
  message_count   int NOT NULL DEFAULT 0,
  tool_call_count int NOT NULL DEFAULT 0,
  lines_added     int,
  lines_removed   int,
  failure_count   int NOT NULL DEFAULT 0,
  rejection_count int NOT NULL DEFAULT 0,
  context_peak_pct numeric,
  model_mix       jsonb,
  -- derived throughput (NULL when wall_ms unknown/zero, never div-by-zero)
  tokens_per_min        numeric GENERATED ALWAYS AS
                    ((input_tokens + output_tokens) * 60000.0 / NULLIF(wall_ms, 0)) STORED,
  output_tokens_per_min numeric GENERATED ALWAYS AS
                    (output_tokens * 60000.0 / NULLIF(wall_ms, 0)) STORED,
  cost_per_min          numeric GENERATED ALWAYS AS
                    (total_cost * 60000.0 / NULLIF(wall_ms, 0)) STORED,
  avg_turn_cost         numeric GENERATED ALWAYS AS
                    (total_cost / NULLIF(message_count, 0)) STORED,
  avg_turn_duration_ms  numeric GENERATED ALWAYS AS
                    (wall_ms::numeric / NULLIF(message_count, 0)) STORED,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE,
  UNIQUE (scope, session_id, day, snapshot_ts)
);
CREATE INDEX IF NOT EXISTS ctx_telemetry_snapshot_day ON ctx_telemetry_snapshot (day) WHERE scope = 'day';
CREATE INDEX IF NOT EXISTS ctx_telemetry_snapshot_session ON ctx_telemetry_snapshot (session_id);

-- Per-subagent reliability + cost. Rate columns generated like the snapshot.
CREATE TABLE IF NOT EXISTS ctx_subagent_run (
  agent_id        text PRIMARY KEY,
  parent_session_id uuid,
  agent_type      text,
  status          text CHECK (status IN ('ok','orphaned','failed')),
  first_ts        timestamptz,
  last_ts         timestamptz,
  duration_ms     bigint,
  tool_call_count int,
  total_cost      numeric(12,6) NOT NULL DEFAULT 0,
  total_tokens    bigint NOT NULL DEFAULT 0,
  primary_model   text,
  cost_per_min    numeric GENERATED ALWAYS AS
                    (total_cost * 60000.0 / NULLIF(duration_ms, 0)) STORED,
  tokens_per_min  numeric GENERATED ALWAYS AS
                    (total_tokens * 60000.0 / NULLIF(duration_ms, 0)) STORED,
  source_id       uuid REFERENCES ctx_ingest_source(source_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ctx_subagent_run_type ON ctx_subagent_run (agent_type);

-- Per-attempt audit of the THIRD (ctx_) write, so silent divergence is
-- detectable without a full parity sweep (same discipline as the existing
-- scribe_db_write_failed oversight event, for ctx).
CREATE TABLE IF NOT EXISTS ctx_dualwrite_log (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_type     text NOT NULL,
  entity_natural_key text,
  attempt_ts      timestamptz NOT NULL DEFAULT now(),
  result          text NOT NULL,           -- ok | skipped | failed
  error           text,
  md_source_file  text,
  triggering_writer text
);
CREATE INDEX IF NOT EXISTS ctx_dualwrite_log_result_ts ON ctx_dualwrite_log (result, attempt_ts);

-- ============================ extend existing transcript_messages (cold) ===
-- Additive per-turn telemetry on the EXISTING table (do not redesign it).
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS input_tokens  int;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS output_tokens int;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS cache_read    int;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS cache_write   int;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS cost_usd      numeric(12,6); -- NULL = not captured, 0 = measured zero
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS duration_ms   bigint;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS tool_calls    int;
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS source_id     uuid;
