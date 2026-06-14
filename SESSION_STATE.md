# SESSION_STATE — rh-claude-framework

> **Current facts only.** This is the workspace-standard tracking doc (replaces the old append-only
> `PROGRESS.md`, now frozen at [`archive/PROGRESS-history-thru-2026-05-16.md`](archive/PROGRESS-history-thru-2026-05-16.md)).
> Per the workspace convention *"Session state files: current facts only, archive history when > 100 lines."*
> The session-by-session record is **git history** (each session = PRs); this file holds only the live picture.
> `/rh-quit` refreshes the "Last verified" stamp + the In-flight table at session end — see [How tracking works](#how-tracking-works-here). It tracks the latest **substantive** PR, not its own doc-only stamp commits (pinning a literal HEAD hash here is self-defeating — a stamp commit becomes the new HEAD and instantly invalidates the stamp).

**Last verified:** 2026-06-13
**Through:** `main`, latest substantive PR **#77** (tracking-standard restructure)
**Tree:** clean · no open PRs

## Current state

All numbered plan work (P0–P5) is merged. The 5-package monorepo (shared / oversight / output / skills / cli / telemetry) is stable and installs clean. The only active plan is the Postgres scribe/FTS sidecar, whose remaining phase is deferred by design (see below).

**Tests (verified 2026-06-13):** oversight **196** · cli **60** · output **124** — all green. (`telemetry/` has its own suite.)

## In-flight / outstanding

| Item | Status | Unblocks |
|---|---|---|
| [`PLAN-2026-06-11`](PLAN-2026-06-11-scribe-postgres-fts.md) **4.1b** — one-time backfill of pre-dual-write md rows into `scribe_rows` | **Not built** — now the gating prerequisite | Phase 4.2 |
| [`PLAN-2026-06-11`](PLAN-2026-06-11-scribe-postgres-fts.md) **4.2** — DB-primary promotion decision | Blocked: parity is **5–8%** (forward-only dual-write), not a time issue | After 4.1b + ≥2 weeks clean parity |
| Two bugs from the 4.1 audit | Tracked as background tasks | source_file path-normalization (`/` vs `\`); `RH_TEST_PG=1` test rows leaking into the real DB |

**Phase 4.1 (parity audit) shipped** — `rh-scribe-parity-audit.js` + 22 tests; first reading 2026-06-13 showed only 5–8% of md rows are mirrored (`db_only` 0, so DB is a clean subset). The promotion gate was reframed: it needs a **backfill** first, not just elapsed time.

Nothing else is open. The old PROGRESS "open queue" is fully closed: P5-1 deliverable shipped (`docs/PATTERNS.md` + `docs/SUMMARY.md`); the doc-sync-probe path-resolution follow-up was resolved 2026-06-13 (`rh-oversight-self-test.js` now uses `config.oversightDir`).

## Recently verified (outer seam)

- **PLAN-2026-06-11 §3.5 — daily-regen transcript ingest** ✅ firing: `daily-regen.log` shows `[OK] rh-transcript-ingest`; Postgres holds **670 transcripts / 10,608 messages** (newest 2026-06-12); `scribe_rows` dual-writing (14 rec / 33 learn / 13 cleanup). Marked ✅ in the plan's VERIFIED table.
- **`/rh-quit` SESSION_STATE refresh** ✅ exercised end-to-end this session (PR #77): the session-end run advanced this file's HEAD/PR line and stamp — closing the outer-seam gap that couldn't be tested pre-merge.

## How tracking works here

- **This file** = current facts. Keep it lean (< 100 lines); when a section grows historical, move it to `archive/`.
- **`git history`** = the authoritative session-by-session log. Don't re-narrate it here.
- **`PLAN-*.md`** (root) = in-flight work with checkbox tracking + a VERIFIED / PARTIAL outer-seam split (per `rh-work-verification.md`). Completed plans move to `archive/`.
- **`docs/`** = durable reference (`PATTERNS.md`, `SUMMARY.md`). **`README.md` / `CLAUDE.md`** = onboarding + repo conventions.
- **`cleanup.md` / `recommendations.md`** at the repo root are **gitignored session-local scribe artifacts** (the Stop-hook prefilter writes them when this repo is the active CWD). They are *not* project tracking and never get committed.
- **`/rh-quit`** drains scribes **and** refreshes this file's "Last verified" stamp + In-flight table against `git log` and the open `PLAN-*.md` files. That session-end refresh is the mechanism that keeps this doc from going stale (the gap that let PROGRESS.md rot for 28 days).

## Pickup commands

```bash
cd C:/Users/rossb/OneDrive/Workspace/toolbeltross/toolbeltross-public/rh-claude-framework
node packages/oversight/tests/run.js   # 196 expected
node packages/cli/tests/run.js         # 60 expected
node packages/output/tests/run.js      # 124 expected
node packages/cli/bin/rh-oversight.js init --dry-run
git status && git log origin/main..HEAD --oneline   # tree clean, nothing unpushed
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/   # must be empty
```
