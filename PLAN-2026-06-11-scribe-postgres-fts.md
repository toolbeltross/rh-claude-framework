# PLAN 2026-06-11 — Scribe → Postgres dual-write + transcript full-text search

**Goal:** scribes write to tables in the local PostgreSQL 18 instance *in parallel with* the markdown files (md stays canonical until the DB technique earns trust), plus a full-text search engine over Claude Code transcripts in the same database. Split from `oversight-system/PLAN-2026-06-11-full-system-remediation.md` because Phase 0 has a hard user-input gate (credentials).

**Prior-art check (facilitator recon 2026-06-11, 21 sources):** no prior scribe-DB or transcript-FTS plan exists. Relevant fragments adopted as constraints:
- `Workspace/recommendations.md:261` — "A local postgres would model deliberations… **Recommendation: stay on markdown until artifact count is bigger**" → honored: md canonical, DB shadow.
- `Workspace/recommendations.md:39–40` — prefer lightweight in-process search (sqlite-vec, **pgvector**, FAISS-as-library) over vector-DB sidecars → honored: Postgres-native FTS (tsvector/GIN) first; pgvector as optional later phase; no sidecar services.

**Environment (verified 2026-06-11):** service `postgresql-x64-18` Running/Automatic; `psql` 18.4 at `C:/Program Files/PostgreSQL/18/bin/`; connectivity NOT yet verified (no credentials available to the session).

**Recovery design:** the DB is a pure additive sidecar. Markdown writers are untouched in behavior; DB writes are best-effort behind an opt-in flag. Full rollback = `DROP DATABASE rh_scribe` + flag off. No md file is ever migrated or deleted by this plan.

---

## Phase 0 — Prerequisites (BLOCKED ON USER — credentials)

- [x] 0.1 **USER INPUT REQUIRED:** postgres superuser password (or approval to use an existing role). Then create role `rh_scribe` (login, no superuser) + database `rh_scribe` owned by it. Store credentials in `%APPDATA%/postgresql/pgpass.conf` (`localhost:5432:rh_scribe:rh_scribe:<pw>`) — NEVER in any repo, settings file that syncs, or scribe row (cf. the cleanup.md:304 leak being redacted in the companion plan).
- [x] 0.2 **Verify:** `psql -U rh_scribe -d rh_scribe -c "SELECT 1"` succeeds non-interactively.
- [x] 0.3 Add `scribeDb` (default **false**) and `scribeDbUrl` resolution to `@rh/shared/config` (env `RH_SCRIBE_DB` > oversight.json > default-off). Idempotent config addition; no behavior change while false.

## Phase 1 — Schema (est. 30 min)

- [x] 1.1 `sql/rh_scribe_schema.sql` — idempotent (`CREATE TABLE IF NOT EXISTS`):
  - `scribe_rows(id bigserial PK, bucket text CHECK (bucket IN ('recommendations','cleanup','learnings')), row_id text, session_id text, ts timestamptz, content text, status text, source_file text, raw_line text, created_at timestamptz DEFAULT now(), UNIQUE(bucket, row_id))`
  - `transcripts(session_id text PK, project_slug text, path text, first_ts timestamptz, last_ts timestamptz, message_count int, ingested_through bigint)` — `ingested_through` = byte offset for incremental re-ingest.
  - `transcript_messages(id bigserial PK, session_id text REFERENCES transcripts, turn int, role text, ts timestamptz, content text, content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(content, 1048575))) STORED)` + `CREATE INDEX … USING GIN (content_tsv)`.
- [x] 1.2 Apply via psql; **verify:** `\dt` lists 3 tables; insert/select/`@@ websearch_to_tsquery` smoke test passes.
- [x] 1.3 Document trigger caveat from learnings: schema is plain DDL (no Prisma) — `prisma db push` trigger-loss hazard doesn't apply here; note kept for future readers.

## Phase 2 — Scribe dual-write (est. 60 min)

- [x] 2.1 New `packages/output/scripts/lib/scribe-db.js` (CJS): `writeRow({bucket,row})` — connects via `pg` (add dependency), upserts on `(bucket,row_id)`, 2s connect timeout, **all failures swallowed into telemetry-failures.jsonl** (never block/fail the md write), no-op when `scribeDb` false.
- [x] 2.2 Wire into `rh-scribe-table-write.js` and `rh-learnings-write.js` AFTER their md writes succeed (md write result is the function's return value either way).
- [x] 2.3 Tests: unit (flag off → no connection attempted; mock pg for upsert shape); integration behind env guard `RH_TEST_PG=1` so CI without postgres skips cleanly.
- [x] 2.4 Flip `scribeDb: true` in `~/.claude/oversight.json`. **Verify (outer seam):** trigger a real scribe write (e.g. `rh-scribe-table-write.js` CLI append to a scratch row), confirm row appears in BOTH md and `SELECT * FROM scribe_rows`.
- [x] 2.5 **PAUSE POINT:** branch → PR → merge.

## Phase 3 — Transcript ingester + search CLI (est. 90 min)

- [x] 3.1 `packages/output/scripts/rh-transcript-ingest.js`: scan `~/.claude/projects/*/*.jsonl`, parse user/assistant text messages (skip tool blobs), incremental via `transcripts.ingested_through` offsets; `--full` flag for re-ingest. Batched inserts; per-file try/catch so one corrupt JSONL doesn't kill the run.
- [x] 3.2 Privacy note (documented in script header + README): the DB is local-only, same trust domain as the transcript files themselves; transcripts of Personal/-adjacent sessions are included unless the project slug is listed in `~/.claude/private-blocklist.json` — honor that blocklist with a skip + count.
- [x] 3.3 `packages/output/scripts/rh-transcript-search.js` CLI: `rh-transcript-search "query terms" [--project slug] [--days N] [--limit N]` → `websearch_to_tsquery` + `ts_rank` + `ts_headline` snippets, output as a compact table with session_id/project/date.
- [x] 3.4 **Verify (outer seam):** ingest the real transcript corpus; search for a string known to exist (e.g. "tilde expansion" from session 953913bd) and confirm the hit; search for a nonsense string and confirm zero hits; re-run ingester and confirm idempotent (no duplicate messages).
- [x] 3.5 Hook ingestion into `rh-daily-regen.js` as an optional step (flag-gated, same `scribeDb` flag). **PAUSE POINT:** branch → PR → merge.

## Phase 4 — Confidence evaluation & promotion gate (NOT in this run)

- [ ] 4.1 Parity audit script: md row counts vs `scribe_rows` counts per bucket; report drift.
- [ ] 4.2 After ≥2 weeks of clean parity: user decision whether DB becomes primary and md becomes the export. Until then md is canonical — per the recommendations.md:261 constraint.
- [ ] 4.3 Optional: pgvector extension + embeddings for semantic search (deliberately NOT in scope until FTS proves insufficient — recommendations.md:40 constraint).

## What is VERIFIED via outer seam
| Item | Verification |
|---|---|
| rh_scribe role+db | user-run setup script; SELECT 1 via pgpass non-interactive |
| schema + FTS | applied via psql; insert→websearch_to_tsquery hit→cascade delete round trip |
| dual-write | real deployed rh-scribe-table-write CLI append → row in BOTH cleanup.md and scribe_rows (PR #59) |
| UTF-8 integrity | U+2192 verified stored multibyte after stdin+PGCLIENTENCODING fix (cmd-line args mangled it — caught here) |
| ingest | 122 transcripts / 1,677 messages, 36s, 0 errors; re-run = 0 ingested (idempotent) |
| search | "tilde expansion" → ranked hits w/ snippets incl. session 953913bd; nonsense query → 0 hits |
| tests | output suite 121/121 incl. RH_TEST_PG=1 real-DB cases |

## What is PARTIAL (not verified via outer seam)
| Item | Status | Linked ID |
|---|---|---|
| 3.5 daily-regen ingest step | wired + deployed; first live firing happens at next daily-regen run — check validation/regen log tomorrow | — |
| Phase 4 parity audit + promotion gate | by design: starts after ≥2 weeks of dual-write data | — |
| subagent transcripts | main-session JSONLs only; projects/<slug>/<session>/subagents/*.jsonl not ingested (scope decision, revisit if search misses matter) | — |
