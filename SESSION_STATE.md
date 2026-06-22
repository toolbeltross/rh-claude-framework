# SESSION_STATE — rh-claude-framework

> **Current facts only.** This is the workspace-standard tracking doc (replaces the old append-only
> `PROGRESS.md`, now frozen at [`archive/PROGRESS-history-thru-2026-05-16.md`](archive/PROGRESS-history-thru-2026-05-16.md)).
> Per the workspace convention *"Session state files: current facts only, archive history when > 100 lines."*
> The session-by-session record is **git history** (each session = PRs); this file holds only the live picture.
> `/rh-quit` refreshes the "Last verified" stamp + the In-flight table at session end — see [How tracking works](#how-tracking-works-here). It tracks the latest **substantive** PR, not its own doc-only stamp commits (pinning a literal HEAD hash here is self-defeating — a stamp commit becomes the new HEAD and instantly invalidates the stamp).

**Last verified:** 2026-06-22
**Through:** `main`, latest substantive PR **#115** (telemetry forwarder agent-session gate + daily-regen PID run-lock/cooldown — kills phantom subagent tabs and the concurrent-run storm); also merged **#116** repo cleanup (archive migrated artifacts, untrack the 10 MB `hook-debug.log.1`, gitignore the rotation); prior window: public-release installability (**#113**), scribe-disposition/daily-guidance (**#109**), telemetry dashboard data fixes (**#104**), session-tab titles (**#108**/**#111**)
**Tree:** clean · no open PRs

## Current state

All numbered plan work (P0–P5) is merged; the 5-package monorepo (shared / oversight / output / skills / cli / telemetry) is stable and installs clean. Two plans are active: the Postgres scribe/FTS sidecar ([`PLAN-2026-06-11`](PLAN-2026-06-11-scribe-postgres-fts.md), remaining phase deferred by design — see below) and the unified **context-db** model ([`PLAN-2026-06-13`](PLAN-2026-06-13-context-db.md)), advancing fast: Phases 1–3.1 merged (PRs #81–#83), then 3.2/3.3 writer wiring + gate-policy tightening (PRs #85, #87–#88), 3.5 telemetry capture in transcript-ingest (PRs #90–#91), and a privacy-classifier bare-name match (PR #92). The two 4.1-audit bugs — `source_file` path-normalization and `RH_TEST_PG` test-row leakage — were fixed in PR #80. The telemetry dashboard CLI got a multi-session correctness fix (PR #93 — see Recently verified).

**Tests:** oversight **197** · cli **62 passing / 0 failing** (both carry from 2026-06-16) · output **205** (+4 daily-regen run-lock/cooldown tests from #115) — green. (`telemetry/` suite: unit **20/20 files** + integration **17** green, incl. #115's piggyback-gate predicate + forwarder outer-seam tests; identity gate exit 0 on merged `main`.)

## In-flight / outstanding

| Item | Status | Unblocks |
|---|---|---|
| [`PLAN-2026-06-11`](PLAN-2026-06-11-scribe-postgres-fts.md) **4.1b** — one-time backfill of pre-dual-write md rows into `scribe_rows` | **Not built** — gating prerequisite | Phase 4.2 |
| [`PLAN-2026-06-11`](PLAN-2026-06-11-scribe-postgres-fts.md) **4.2** — DB-primary promotion decision | Blocked: parity ~5–8% (forward-only dual-write) | After 4.1b + ≥2 weeks clean parity |
| [`PLAN-2026-06-13`](PLAN-2026-06-13-context-db.md) context-db **Phase 3.6+** | In progress — Phases 1–3.5 merged (PRs #81–#92: writers, gate policy, telemetry capture, privacy classifier) | continuing |

**Phase 4.1 (parity audit) shipped** — `rh-scribe-parity-audit.js` + 22 tests; first reading 2026-06-13 showed only 5–8% of md rows are mirrored (`db_only` 0, so DB is a clean subset). The promotion gate was reframed: it needs a **backfill** first, not just elapsed time.

Nothing else is open. The old PROGRESS "open queue" is fully closed: P5-1 deliverable shipped (`docs/PATTERNS.md` + `docs/SUMMARY.md`); the doc-sync-probe path-resolution follow-up was resolved 2026-06-13 (`rh-oversight-self-test.js` now uses `config.oversightDir`).

## Recently verified (outer seam)

- **PR #115 — phantom subagent tabs + daily-regen concurrent-run storm** ✅ two coupled fixes from a live-dashboard diagnosis. (a) The forwarder's `toolPiggyback` status-post is gated on `agent_id`/`agent_type`, so a subagent/`--agent` tool event no longer mints a phantom top-level session tab (the discriminator is `agent_type`, not `agent_id` — `--agent` runs carry type-only; verified 126/153 agent events were type-only in the live snapshot). (b) `rh-daily-regen.js` gains a PID-liveness run-lock + 60-min rerun cooldown so concurrent SessionStart triggers can't each run the 15-step pipeline (the 2026-06-19 storm dispatched ~30 `rh-daily-guidance` agents, each surfacing as a phantom tab). Outer-seam: forwarder driven as a child against an ephemeral capture server (suppresses for an agent payload, posts for interactive); daily-regen via the tmp-HOME spawn harness (skips on a live-pid lock, runs when free). **Live-log verification (2026-06-22):** installed daily-regen full-runs went **62 → 30 → 1/day** across the 06-19→06-22 rollovers — storm gone; cooldown + day-marker gate reruns, run-lock is the unused backstop.
- **PR #116 — repo cleanup** ✅ untracked the 10 MB `hook-debug.log.1` runtime log (committed by accident in a migration snapshot; gitignore broadened `hook-debug.log` → `hook-debug.log*`, file kept on disk — `git check-ignore` confirms ignored); archived 5 unreferenced migrated screenshots + the CLOSED `PLAN-distribution-readiness.md` → `packages/telemetry/docs/archive/` with a provenance README; fact-fixed a stale `rh-daily-regen.js` comment (the offset-`SELECT` batching it called "tracked/future" already shipped in #106). No behavior change; renames recorded at 100% similarity; daily-regen suite 21/21.
- **PR #113 — public-release installability** ✅ five fresh-clone blockers fixed: added root `LICENSE` (MIT); root `prepare` → `build:dashboard` builds both v1+v2 bundles on `npm install` (gitignored `dist/`+`dist-v2/` now exist after a clean clone, so `GET /` serves the dashboard instead of 404); `prepublishOnly` builds v1+v2 (tarball shipped an unbuilt `dist-v2/`); both READMEs reconciled so the clone path is primary and `npm install -g rh-telemetry` is demoted to "planned once published" (package unpublished); test counts corrected to measured **197/62/201** (README said 343/177-54-112, CLAUDE.md said 181 output). Outer-seam: cloned HEAD → `npm install` (prepare built both bundles) → `node server/index.js` → `GET /` **HTTP 200** for both v1 and v2 (was 404). Launch-time v1/v2 selection unchanged. Caveat documented: `npm install --omit=dev` fails the prepare build (vite is a devDep).
- **PR #104 — telemetry dashboard data fixes** ✅ four data bugs found by live-monitoring: Overview Total Tokens=0 → sum `stats.modelUsage` (43.0M); active-agent live telemetry blank → `deriveAgentTranscriptPath` dropped the `<sessionId>` dir (4,059 not-found misses); agent-cost "% of session" >100% → bounded "% of total spend"; live-session model/ctx clobbered to (none)/0% by empty status posts → `updateLiveSession` merge-not-clobber (preserves model/ctx/`_sessionTitle`/`_compactEvents`). Outer-seam: rendered UI + live `/api/status` probe + telemetry unit 19/19.
- **PRs #108 + #111 — telemetry session-tab heuristic titles** ✅ live tabs show a short title from each session's first prompt (server `session-title.js`, no-LLM, falls back to `project (id-slice)` for structured/automated prompts); cwd/session-id/ctx/cost/tokens moved to hover. **#111** fixed #108's test fixtures hardcoding `C:/Users/rossb/…` (tripped the cli `test-no-identity-refs` gate). Outer-seam: rendered tab ("…first prompt" title) + identity gate exit 0 on merged `main`.
- **PR #109 — scribe-backlog disposition UI + automated daily guidance** ✅ (peer session) merged after rebase onto current `main`; author verified live pipeline run + `/scribe` UI round-trip; output suite **201** green. Cross-session coordinated via scoped explicit-path staging — no commit contamination.
- **PRs #105 + #106 — daily-regen `rh-transcript-ingest` timeout fix** ✅ the step was killed at 60 043 ms (exit code null) by the 60 s per-step timeout. Root cause: on Windows the incremental pass spawned one `psql.exe` per transcript file (~147 ms cold-start) even for up-to-date files, so the read-only floor scaled linearly with file count (~56 s at 380 files). **#105** raised the step's `timeoutOverrideMs` to 6 min (safety-net band-aid + evidence comment); **#106** is the durable fix — a single bulk `json_agg` offset query replaces the N per-file `SELECT`s, so the floor no longer scales with file count. Outer-seam: full 13-step pipeline re-run against a **clean deploy of merged `origin/main`** logged `[OK] rh-transcript-ingest` (not FAIL); deployed `rh-transcript-ingest --stats` reads 860 transcripts / 15 836 messages, sub-second.
- **PR #102 — `/rh-quit` require-merge gate** ✅ session-authored open PRs must now be merged (default) or explicitly user-declined before the skill prints "safe to close"; "listed as an open item" is no longer sufficient. Closes the gap where the model self-defaulted an open PR to "awaiting merge" and the user had to intervene. Skill-only change; deployed copy at `~/.claude/skills/rh-quit/SKILL.md` synced byte-identical to source.
- **PR #98 — telemetry session-tab labels (v1 + v2)** ✅ both UIs render the spec format `project (id-slice)` via one shared `src/lib/session-label.js` (prefers stable `project_dir` over volatile `current_dir`); v1 file-session tabs + v2 dev-root (`:5174/` now serves v2) also fixed. Outer-seam: 34/34 telemetry test files; v1 dev + v1 prod (`:7890`) + v2 dev + v2 prod (`:7891`) rendered correct labels, 0 console errors.
- **PR #97 — placement/scribe propagation into framework source** ✅ ports the 2026-06-14 deployed-copy edits (already live in `~/.claude` + `<workspace>/.claude/rules`) back into the deploy source so `rh-oversight init` no longer clobbers them: NEW `rh-doc-placement.md`; additive `sectionRulesDomainIndex()` in `rh-generate-state-md.js`; scribe canonical-`$WORKSPACE` resolution (recommendations + cleanup) + Step 4b breadcrumb (multiscope); doc-placement back-refs in conventions/cwd-awareness/oversight-doc-sync (+ placement sync-points row + stale "9 rule files" count fix); plus 3 previously-untracked rules added verbatim (throwaway-artifacts, rule-consultation, severity-tiers). Outer-seam: isolated tmp-HOME install copies **19 rule files**, all four new rules land in `<workspace>/.claude/rules/` byte-identical to deployed; suites 197/62/181.
- **PR #80 — scribe path-canonicalization + test-leak isolation** ✅ output suite green (unit + `RH_TEST_PG=1`); live-DB `test_pollution` purged to **0** (5 leaked rows deleted across two cleanups), and the real learning mis-named `test-config-destruction` renamed → `tests-clobber-real-config` and re-mirrored. Tests now spawn children with `RH_SCRIBE_DB=0` so the best-effort shadow can't leak.
- **cli `zero-hardcoded-paths` hygiene regression — resolved** ✅ the machine-specific refs in shipped `packages/` were replaced with placeholders (`C:/ws/…`) via PRs #87/#88; cli suite back to **62 passing / 0 failing**. The earlier `fix/identity-refs-…` PR (#86) was closed as superseded.
- **PR #93 — telemetry CLI multi-session correctness** ✅ `scripts/telemetry-cli.js` now scopes the live session to the caller (`CLAUDE_CODE_SESSION_ID` → CWD → most-recent) instead of global `max(_lastSeen)`, and reads the real `context_window.{context_window_size, used_percentage, total_input_tokens, current_usage.*}` fields (was reading non-existent `total_tokens`, silently defaulting 1M Opus to 200K). New unit test (9 cases); full telemetry suite 34/34 files; outer-seam CLI run confirmed correct session at 1.0M window.

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
node packages/oversight/tests/run.js   # 197 expected
node packages/cli/tests/run.js         # 62 expected — all green
node packages/output/tests/run.js      # 201 expected
node packages/cli/bin/rh-oversight.js init --dry-run
git status && git log origin/main..HEAD --oneline   # tree clean, nothing unpushed
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/   # must be empty
```
