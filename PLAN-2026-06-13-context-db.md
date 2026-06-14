# PLAN 2026-06-13 — rh_context: unified context data model (3rd parallel write)

**Source:** [DELIBERATION-2026-06-13-context-data-model.md](DELIBERATION-2026-06-13-context-data-model.md) (14-agent panel).
**User decisions (2026-06-13):** (1) **extend `rh_scribe`** with `ctx_*`-namespaced tables, not a separate DB; (2) **lean spine + enriched telemetry** — agent/turn/model cost, extended token usage, rate averages (tokens/min, cost/min); defer the graph/PKM layer; (3) **migrate `scribe_rows` key** to `(bucket, source_file, row_id)` with a replacement-assessment (also fixes the live path-drift collision).

**Invariant:** md/jsonl stays CANON. `rh_scribe.scribe_rows` is the existing shadow; `ctx_*` is the new richer shadow, best-effort behind `config.contextDb`, never blocks md or the rh_scribe write. Rollback = DROP the `ctx_*` tables + flag off.

---

## Phase 1 — Schema + config (this PR)
- [x] 1.1 `sql/rh_context_schema.sql` — 11 `ctx_*` tables (spine: session, session_attribution, ingest_source; content: memory_artifact, memory_observation; telemetry: oversight_event, telemetry_failure, model_usage, telemetry_snapshot, subagent_run; audit: dualwrite_log) + additive per-turn telemetry columns on `transcript_messages`. Idempotent.
- [x] 1.2 Applied to live `rh_scribe`; **verified outer seam**: 11 tables created; generated rate columns compute (120k tokens/min from 120k tokens / 60s); uuidv7 PK; generated `body_tsv` matches `websearch_to_tsquery`; generated `total_tokens`; privacy CHECK rejects bad disposition. Probe rows cleaned up.
- [x] 1.3 `config.contextDb` flag (env `RH_CONTEXT_DB` > `oversight.json:contextDb` > default-off), reusing the existing `scribeDb*` connection (same DB).
- [x] 1.4 Config test for the contextDb flag resolution (`packages/oversight/tests/test-config.js`; in the 197-pass suite).

## Phase 2 — scribe_rows key migration (next PR — see assessment below)
- [x] 2.1 `canonicalSourceFile()` (forward-slash, case-preserved) in `scribe-db.js`, applied in `writeRow` (PR #80). NOTE: parity-audit's `normalizePath()` still lowercases — benign case discrepancy ([steward note]); unify in `@rh/shared` if it ever bites.
- [x] 2.2 Migration `sql/migrations/2026-06-13-scribe-rows-key.sql` (idempotent, transactional): normalize backslash spellings, drop `UNIQUE(bucket,row_id)`, add `UNIQUE(bucket, source_file, row_id)`. Inspection first: 65 rows, 0 NULL source_file, **0 would-be duplicates**. Backed up scribe_rows (pg_dump) before applying.
- [x] 2.3 `scribe-db.js` ON CONFLICT → `(bucket, source_file, row_id)`; redeployed to `~/.claude/scripts/lib/`; base `sql/rh_scribe_schema.sql` updated for fresh installs; PG upsert test fixed to pass `source_file`.
- [x] 2.4 Parity audit re-run → **no path_drift, no test_pollution** (the started test-pollution chip session purged the leaked temp rows; `UPDATE 0` backslash rows at migration confirms). Supersedes the path-normalization task.

## Phase 3 — the 3rd write (wiring)
- [x] 3.1 `packages/output/scripts/lib/context-db.js` — best-effort writers for memory_artifact / memory_observation / dualwrite_log, reusing scribe-db.js machinery (spawnSync psql, dollarQuote, canonicalSourceFile, PGCLIENTENCODING=UTF8, swallow+log). No-op when `contextDb` false. **Unwired** — no live writer calls it yet (gated behind 3.4 privacy gate). PR (this).
- [ ] 3.2 Wire into `rh-scribe-table-write.js` (after md + rh_scribe writes) → upsert `ctx_memory_artifact` (capture **full session UUID** at write time).
- [ ] 3.3 Fix the verified append-observation gap: `rh-learnings-write.js` `modeAppendObservation` writes one `ctx_memory_observation` row (incremental).
- [~] 3.4 Privacy gate (steward BLOCK 2) — **built, pending steward/user policy sign-off + wiring**. `upsertIngestSource` + pure `classifyDisposition` in `context-db.js`: per-source-file disposition, fail-closed. Rules (`BLOCKLIST_VERSION='2026-06-13.1'`): path under any `config.privateDirs` → `blocklisted-skipped`; PII hit (SSN/EIN/long-acct regex) → `review-required`; known scribe/learnings/transcript kind + non-private + PII-clean → `clean`; else `review-required`. Enforcement is physical: content writers (`upsertMemoryArtifact`/`insertMemoryObservation`) emit `INSERT…SELECT…WHERE EXISTS(source clean/redacted)` when a `source_id` is supplied, so a non-clean source yields zero rows (`{ok:true, gated:true}`). `blocklist_version` recorded per source. **Open decisions:** (a) the auto-clean rule above — confirm or tighten to "never auto-clean, manual only"; (b) `config.privateDirs` is currently `[]` — populate (e.g. `Personal/`) before wiring. Tests: classify (private path incl. backslash dir, PII kinds, clean, unknown), guard/builder shape, `_buildIngestSql` shape, RH_TEST_PG end-to-end (clean source admits, review-required withholds). Output suite 163/163 incl. PG; zero residue.
- [ ] 3.5 Telemetry capture → `ctx_model_usage` / `ctx_telemetry_snapshot` / `ctx_subagent_run` at session close (and per-turn columns on transcript_messages during ingest).
- [x] 3.6 `context_db_write_failed` oversight event on failure (emitted by all three writers). Tests `packages/output/tests/test-context-db.js`: flag-off no-op, validation, never-throws, pure SQL-shape (no DB), and RH_TEST_PG real-DB round-trip (upsert-in-place, dup-safe observation via natural key, audit append). Output suite 158/158 incl. PG. PR (this). Note: event only fires once live writers call the lib (3.2/3.3/3.5).

## Phase 4 — backfill + read-back + confidence
- [ ] 4.1 One-shot idempotent backfill from canonical files (reuse parity-audit `md_only` worklist). Observations backfilled from `## Observations`. Disclosed gap: no historical telemetry/trend source before capture-start.
- [ ] 4.2 Read-back surface (CLI/query helpers + optional telemetry dashboard tab) — the "read usefully back out" bar.
- [ ] 4.3 Performance check (EXPLAIN ANALYZE on the hot retrieval paths) — the "writes performant" bar.
- [ ] 4.4 Parity audit extended to `ctx_*`; ≥2 weeks clean before any canon reconsideration. md stays canon until then.

---

## Replacement assessment — `scribe_rows` UNIQUE key migration (Phase 2)
Per `rh-replacement-assessment.md` (modifying a working dedup path).
- **What:** change `scribe_rows` conflict key from `UNIQUE(bucket, row_id)` to `UNIQUE(bucket, source_file, row_id)`; normalize existing `source_file` values first.
- **Evidence:** Phase-4.1 parity audit (2026-06-13) found the same `row_id` from different project copies collapses under the current key, and `Workspace/cleanup.md` is recorded under both `/` and `\` spellings (`path_drift`). Cross-project copies clobber each other on upsert — a live data-correctness bug. Steward flagged it BLOCK 1 for ctx reconciliation.
- **Value lost:** none functional — the key only widens. Risk: a normalization + dedup pass runs once over live rows (latest-wins on any genuine collision; the dedup choice is logged).
- **Value gained:** correct per-project row identity; the two shadows (`scribe_rows` and `ctx_memory_artifact`) share the same natural key and reconcile; path-drift eliminated.
- **Recommendation:** migrate (Phase 2), gated behind its own PR with the normalization+dedup done before the constraint swap; re-run parity audit to confirm.

## What is VERIFIED via outer seam
| Item | Verification |
|---|---|
| ctx_ schema applies to live rh_scribe | 11 tables created; ALTERs on transcript_messages succeeded |
| generated columns | rate math (tokens/cost per min, avg turn), uuidv7, body_tsv FTS, total_tokens — all correct on probe rows (then deleted) |
| privacy CHECK | bad `privacy_disposition` rejected by constraint |
| contextDb flag | oversight suite 197/197 incl. flag-resolution test |
| scribe_rows key migration | constraint swapped on live DB (`scribe_rows_bucket_source_file_row_id_key`); same row_id + 2 source_files coexist; upsert dedups on new key; output suite 148/148 incl. RH_TEST_PG=1 |
| context-db.js writers (3.1/3.6) | output suite 158/158 incl. RH_TEST_PG=1: artifact upsert-in-place on natural key, observation resolved by natural key + dup-safe, dualwrite audit append; flag-off no-op; never-throws on broken psql; SQL-shape asserted; **zero test residue verified** in ctx_ tables after a clean PG run |
| privacy gate (3.4) | output suite 163/163 incl. RH_TEST_PG=1: `classifyDisposition` (private path/backslash dir, PII→review-required, clean, unknown kind), `EXISTS(clean)` guard built into both content writers, `_buildIngestSql` shape, and end-to-end PG proof that a clean source admits the write while a review-required source is withheld (`gated:true`, 0 rows). Zero residue. **Policy not yet sign-off'd; not wired.** |

## What is PARTIAL (not verified via outer seam)
| Item | Status | Linked ID |
|---|---|---|
| the 3rd write end-to-end | `context-db.js` exists + tested, but **unwired** — no live md writer calls it yet; gated behind the 3.4 privacy gate | Phase 3.2/3.3/3.4/3.5 |
| backfill / read-back / perf | not started | Phase 4 |
