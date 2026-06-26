-- Migration: scribe_rows UNIQUE key (bucket, row_id) -> (bucket, source_file, row_id)
-- PLAN-2026-06-13-context-db.md Phase 2. Replacement-assessment in that plan.
--
-- Why: the old key let per-project copies (same row_id, different source_file)
-- clobber each other on upsert, and left the two shadows un-reconcilable with
-- ctx_memory_artifact's (bucket, source_file, row_id) key. Inspection 2026-06-13:
-- 65 rows, 0 NULL source_file, 0 would-be duplicates under the new key, only
-- 2 backslash-spelled rows (leaked temp rows) to normalize.
--
-- Apply:    psql -U rh_scribe -d rh_scribe -w -f sql/migrations/2026-06-13-scribe-rows-key.sql
-- Rollback: restore from the pre-migration backup of scribe_rows, or
--           ALTER TABLE scribe_rows DROP CONSTRAINT scribe_rows_bucket_source_file_row_id_key,
--           ADD CONSTRAINT scribe_rows_bucket_row_id_key UNIQUE (bucket, row_id);
-- IMPORTANT: deploy the updated scribe-db.js (ON CONFLICT target) BEFORE running
-- this, or live upserts referencing the old (bucket,row_id) target will error.
-- Idempotent: safe to re-run.

BEGIN;

-- 1. Canonicalize any backslash source_file spellings to forward-slash so the
--    new key matches what canonicalSourceFile() writes going forward.
UPDATE scribe_rows
   SET source_file = replace(source_file, chr(92), '/')
 WHERE strpos(source_file, chr(92)) > 0;

-- 2. Drop the old narrow key.
ALTER TABLE scribe_rows DROP CONSTRAINT IF EXISTS scribe_rows_bucket_row_id_key;

-- 3. Add the widened key (guarded for idempotent re-run).
DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'scribe_rows'::regclass
      AND conname = 'scribe_rows_bucket_source_file_row_id_key'
  ) THEN
    ALTER TABLE scribe_rows
      ADD CONSTRAINT scribe_rows_bucket_source_file_row_id_key
      UNIQUE (bucket, source_file, row_id);
  END IF;
END
$migrate$;

COMMIT;
