# DELIBERATION — Unified data model for Claude-generated context (2026-06-13)

**Question:** design a data model for everything Claude generates — session transcripts, recommendations, cleanup, learnings, Claude/code-review docs, rh-telemetry stats (turn time/cost/failures/tools/tokens/context/model), oversight docs/events — to be stored in a DB as a **third parallel write** (md = canon, `rh_scribe` = existing shadow, new = richer shadow), refined forward until the DB earns read-back trust + performant writes.

**Method:** 14-agent panel via the Workflow orchestrator (run `wf_661cdb1a-ac8`, 1.28M tokens). Phases: Recon (5) → Panel (7) → Synthesis + adversarial Steward review (2). Raw result: `tasks/w2iu8g49w.output` (252 KB). This doc is the curated record; it is a synthesis of subagent output, not a read of source files to EOF.

**Panel:** DB Architect · Anthropic Memory Guidance · OpenBrain (OSS second-brain: Mem0/Letta/basic-memory/khoj) · Obsidian/PKM · our Supervisor (oversight-trends) · our Steward (additive-only/md-canon/privacy) · the Scribes (row mechanics). Recon grounded them in the **actual** current schema and data sources.

---

## Grounding highlights (verified facts the panel built on)

- **Current storage:** md is canon everywhere; `rh_scribe` Postgres is a best-effort shadow (`scribe_rows` + `transcripts` + `transcript_messages` + `log_entries`), gated by `config.scribeDb`, never blocks md.
- **Identifier mismatch:** scribe rows store `session_id` truncated to **8 chars**; transcripts / oversight-events / telemetry-failures store the **full UUID**. Correlating them today means prefix-matching — collision-prone.
- **Verified bug:** `rh-learnings-write.js` `modeAppendObservation` returns *without* calling `scribeDb.writeRow` → every appended observation is invisible to Postgres; DB learnings content is frozen at create time.
- **Volumes (today):** recommendations.md 167 lines · cleanup.md 191 · 61 learnings topic files · oversight-events.jsonl 5,942 · telemetry-failures.jsonl 293 · supervisory-log.md 8,126 lines.
- **No code-review artifact exists** yet — findings aren't a stored entity.
- **Zero `[[wikilinks]]`** across all 61 learning files — the link graph is empty today.
- Telemetry per-session/day aggregates are **recomputed live, never persisted** → any trend wider than the live window is currently uncomputable historically.

---

## Synthesized model — 16 tables (full proposal)

**Spine & provenance**
1. `session` — one row per session; the canonical join hub. Resolves the 8-char↔UUID mismatch **once** (full UUID is the FK everywhere; short id is a generated lookup handle for legacy rows only).
2. `session_attribution` — backfill-only map from 8-char id → full UUID, with collision flagging (never silently picks one).
3. `ingest_source_registry` — every content row traces to a canonical md/jsonl source + byte range + **privacy disposition**; DROP-cascade makes the DB a reversible shadow.

**Content (hot/curated)**
4. `memory_artifact` — the polymorphic curated retrieval node (recommendations, cleanup, learnings, decisions, incidents, rollups, MOCs, session_state, code_review). Stores `body_distilled` (curated) **plus** `raw_line` (verbatim md, for parity). Carries inline `t_valid/t_invalid/superseded_by`, nullable `embedding vector(1536)`, `body_tsv` (FTS). Natural key `(bucket, source_file, row_id)`.
5. `memory_observation` — child rows for learning observations (fixes the append-observation gap; makes recurrence queryable).

**Graph / PKM**
6. `link` — general typed directed edges (any artifact → any artifact); backlinks derived, not stored. Plain edges + recursive CTE (benchmarked faster than Apache AGE at this scale).
7. `tag` + 8. `artifact_tag` — hierarchical tags (ltree).

**Cold / behavioral**
9. `transcript_message` — raw turns + per-turn telemetry (reuses existing design verbatim; adds per-turn cost/tokens at ingest).
10. `oversight_event` — 5,942 typed events promoted from FTS to a first-class fact table (severity/rule parsed at ingest).
11. `telemetry_failure` — one row/failure; retries as a self-edge (no double-counting cost).
12. `telemetry_snapshot` — **persisted** per-session/day aggregates (the gap today).
13. `subagent_run` — per-agent reliability (cost/fails/orphan-rate per type).
14. `trend_snapshot` — materialized daily/weekly rollups that survive partition retention.

**Lifecycle / audit**
15. `fact_version` — bi-temporal invalidation ledger (DELETE → invalidate, never hard-delete).
16. `dualwrite_log` — per-attempt audit of the 3rd write (detect silent divergence without a full parity sweep).

**Triple-write plan:** md first (canon, withLock) → `rh_scribe` best-effort → `rh_context` best-effort behind a new `config.contextDb` flag; failures → `context_db_write_failed` event + `dualwrite_log` row; reuses the battle-tested `scribe-db.js` machinery (spawnSync psql, dollarQuote, PGCLIENTENCODING=UTF8). **Captures the full session UUID at write time** (eliminates prefix-matching going forward). Distills, does not mirror verbatim. Rollback = DROP + flag off.

**Backfill plan:** reuse the Phase-4.1 parity audit's `md_only` set as the worklist; one-shot idempotent ingest of canonical files; observations backfilled from `## Observations` lists; **disclosed gap** — no historical source exists for telemetry/trend snapshots (history starts at capture-start).

---

## Steward adversarial review — verdict: **ship-with-fixes**

md-canon respected ✅ (md written first under lock; both DB writes gated/swallowed/logged; `rh_scribe` untouched). **Additive-only: ✗ as written.** Two **BLOCK** items:

- **BLOCK 1 — broken reconciliation key.** `memory_artifact` keys on `(bucket, source_file, row_id)` but live `scribe_rows` dedups on `(bucket, row_id)` only. They are *not* row-for-row reconcilable as claimed. Fixing it means **migrating `scribe_rows`' conflict key** — a change to a working path → requires a written **replacement-assessment**. *Or* drop the parity claim and treat `rh_context` as independently keyed.
- **BLOCK 2 — privacy is unenforceable.** `privacy_disposition` is free-text/nullable (forces nothing), and the inherited blocklist is **slug-only** — it does **not** protect prose that *quotes* Personal/Financial/Divorce content (esp. supervisory-log.md, 8,126 lines). Fix: `privacy_disposition NOT NULL CHECK (...)`, content-level scan for prose sources, default-deny (`review-required` until cleared).

**Over-engineering (warn):** the graph/PKM layer (`link`/`tag`/`artifact_tag`/`fact_version`) provisions a property graph for a corpus with **zero** wikilinks and one recoverable edge type. Recommends **deferring** it behind an EXPLAIN-justified phase 2 — consistent with the proposal's own "under-build first" principle.

**Other warns/notes:** `link` uses text ids (no FK) → breaks the cascade-reversibility claim; `fact_version` duplicates `memory_artifact`'s inline temporal columns (two truth sources); two existing path-canonicalizers differ on case → latent drift (unify in `@rh/shared`); distinguish measured-zero vs not-captured cost (NULL); encapsulate the oversight double-wrap normalization in a shared helper.

---

## Recommended **Phase-1 spine** (steward's cut)

Ship: `session` · `ingest_source_registry` · `memory_artifact` · `memory_observation` · `transcript_message` · `oversight_event` · `telemetry_failure` · `telemetry_snapshot` · `subagent_run` · `dualwrite_log` (+ `session_attribution` for backfill).
**Defer to phase 2** (behind EXPLAIN evidence): `link` · `tag` · `artifact_tag` · `trend_snapshot` · `fact_version` (use inline temporal columns on `memory_artifact` for now).

---

## Open decisions for the user (panel defaults shown)

1. **Separate DB vs extend `rh_scribe`** — *panel default: extend the existing `rh_scribe` DB* (the core retrieval joins are cross-table; a 2nd DB forces FDW/app-side joins). **This contradicts the literal "build a second database" ask — user's call.**
2. **Scope** — *panel/steward default: ship the lean spine now, defer the graph layer.*
3. **`scribe_rows` key migration (BLOCK 1)** — *default: do the coordinated `(bucket, source_file, row_id)` migration with a replacement-assessment* (also fixes the live cross-project collision), **or** keep `rh_context` independently keyed and drop the parity claim.
4. **Privacy (BLOCK 2)** — not optional: `NOT NULL` disposition + content-scan + default-deny will be built in regardless.
5. **pgvector / code_review** — *default: ship nullable `embedding` column + reserve `bucket='code_review'`, populate neither until needed.*
