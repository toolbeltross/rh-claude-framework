-- 2026-06-15-scribe-proposals.sql
-- Adds LLM-proposed-disposition columns to scribe_rows for the daily
-- scribe-triage driver (rh-scribe-triage.js) + the /scribe disposition UI.
-- PLAN-2026-06-15-scribe-disposition-ui (closes F-K).
--
-- The nightly driver writes ONLY these proposed_* columns (propose-only
-- invariant); the canonical `status` flip happens when the user applies a
-- disposition through the UI. Idempotent: safe to re-apply.
--
-- Apply: psql -U rh_scribe -h localhost -d rh_scribe -w -f sql/migrations/2026-06-15-scribe-proposals.sql

ALTER TABLE scribe_rows ADD COLUMN IF NOT EXISTS proposed_disposition text;
ALTER TABLE scribe_rows ADD COLUMN IF NOT EXISTS proposed_rationale   text;
ALTER TABLE scribe_rows ADD COLUMN IF NOT EXISTS proposed_followup    text;
ALTER TABLE scribe_rows ADD COLUMN IF NOT EXISTS proposed_at          timestamptz;

-- Partial index: the triage driver selects open rows with no proposal yet.
CREATE INDEX IF NOT EXISTS scribe_rows_untriaged
  ON scribe_rows (bucket, ts)
  WHERE status = 'open' AND proposed_at IS NULL;
