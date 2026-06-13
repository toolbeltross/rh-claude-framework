# PLAN — Telemetry Dashboard Front End v2

> Created 2026-05-20. Owner: Ross + Claude. Status: draft, awaiting research-phase findings before Phase 2+.

## Motivation

The v1 Overview tab's headline cards (Total Sessions: 173, Total Messages, First Session, Daily Activity chart, Hourly Heatmap, Model Breakdown) are all sourced from `~/.claude/stats-cache.json`, which has not been written since 2026-04-07. Verified this session:

- `~/.claude/stats-cache.json` mtime `Apr 7 18:04`; contains `totalSessions: 173`, `totalMessages: 34301`, `firstSessionDate: 2026-03-01`, last `dailyActivity` entry `2026-04-07`.
- `server/parser.js:123` reads `totalSessions` from that file with no alternative source.
- `OverviewTab.jsx:13,28` renders `stats?.totalSessions` directly.
- Fresh sources sit unused by Overview: `~/.claude.json` (live, today), `~/.claude/projects/` (729 transcript JSONLs across 59 project dirs), `~/.claude/oversight-events.jsonl` (2,244 events), `~/.claude/telemetry-failures.jsonl` (1,742 events). Trends tab already proves the live-aggregation pattern via `trends-router.js` + `rh-supervisor-sweep`.

**The drift is real and visible**: the most-prominent surface is the most-stale data. Several genuinely valuable feeds (per-turn cost/velocity, live subagent table, failure patterns, oversight trends, plan/context usage) are buried in subtabs.

## Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Full redesign, all tabs | Drift is structural, not just one card |
| Tech stack | Decide in Phase 0 research | Compare React-status-quo vs shadcn-kit vs other against actual needs |
| Coexistence | Side-by-side, env-flag default | `RH_TELEMETRY_UI=v1\|v2`, default v1 until parity. v1 untouched throughout. |

## Integration constraints (do NOT neglect)

These two constraints must be carried through every phase, not bolted on at the end.

### Oversight system integration
The telemetry package already bridges to the oversight package via `server/trends-router.js` (uses `createRequire` to import `@rh/oversight`'s `rh-supervisor-sweep.js`). v2 must **expand**, not reduce, oversight visibility:

- **Oversight events feed**: `~/.claude/oversight-events.jsonl` (2,244 events) — Layer 3a rejections, hook timings, guard outcomes. Largely uninstrumented in v1 UI.
- **Failure store**: `~/.claude/telemetry-failures.jsonl` (1,742 events) — already surfaced in FailureHistory subtab; v2 must promote to top-level surface.
- **Scribe outputs**: per-workspace `recommendations.md` / `cleanup.md` / `learnings/` files — currently invisible in the dashboard.
- **Supervisor sweep**: cross-session trend aggregation — currently siloed in Trends tab.
- **Hook health**: `server/hook-health.js` + `server/hook-perf-store.js` — perf data exists but underused.
- **Guard outcomes**: `rh-consolidation-guard.js`, `rh-agent-oversight-guard.js`, `rh-agent-result-guard.js`, `rh-read-audit.js` — fire events but no v1 panel shows blocked vs allowed counts over time.

**Rule:** every Phase 0 deliverable (especially 0.2 API coverage matrix and 0.5 IA proposal) must enumerate oversight signals separately and propose where each one surfaces in v2.

### npm plug-in delivery
Stated long-term goal: `npm install -g rh-telemetry` (already partly true — see CLAUDE.md). v2 must not break this:

- **Build artifacts**: both `dist/` (v1) and `dist-v2/` must be bundled in the published package, or v2 must ship as a separate optional package (`rh-telemetry-ui-v2` peer).
- **`files` in package.json**: ensure new build output is included.
- **`bin/rh-telemetry.js`**: `setup` / `start` / `dev` subcommands must understand v2 (e.g. `rh-telemetry dev --ui v2`).
- **Hook installer (`scripts/setup-hooks.js`)**: no v2 impact expected, but must be re-verified per `rh-oversight-doc-sync.md`.
- **Skill installer (`scripts/install-skills.js`)**: `/rh-telemetry` skill should reference the active UI flavor; no hardcoded v1 paths.
- **Size budget**: shipping two dist/ trees doubles npm tarball size. If v2 stack differs (e.g. shadcn adds Radix), measure tarball delta in Phase 0.4 and decide: bundle both, or v2-as-separate-package.

**Rule:** Phase 1.1 (package layout decision) must explicitly choose between (a) v2 inside `packages/telemetry/`, (b) v2 as `packages/telemetry-v2-ui/` separately publishable, (c) v2 inside `packages/telemetry/` but excluded from default npm pack until promoted.

## Architecture answer (already verified)

Server (`server/index.js`) is fully decoupled from the UI:
- **API surface**: `GET /api/snapshot`, `GET /api/trends`, `GET /api/failures*`, `GET /api/health`, `POST /api/refresh`, `WS /ws`.
- **Frontend mount** (`server/index.js:66-73`): `dist/` is served as static only if it exists — single line of coupling.
- **v2 plan**: new package `packages/telemetry-v2-ui/` (or `packages/telemetry/ui-v2/` subdir — decide in Phase 1), own Vite + own build output. Server gains a tiny `RH_TELEMETRY_UI` switch deciding which `dist*/` to mount.

---

## Phase 0 — Research (no code yet) — **COMPLETE 2026-05-20**

Goal: replace inference with verified facts before committing to v2 shape.

**All 5 research outputs landed in `docs/research/`. Key findings summary at bottom of Phase 0.**

- [x] **0.1 — Why did `stats-cache.json` stop updating?** → `docs/research/stats-cache-why.md`
  - [x] Grep Claude Code source (writer found in native binary `~/.local/share/claude/versions/2.1.145`)
  - [x] Check Claude Code CHANGELOG (v2.1.118 merged /cost+/stats into /usage)
  - [x] Run `claude /stats` and `/usage` in `-p` mode (mtime unchanged in both — strong neg evidence)
  - [x] Confirmed no settings.json toggle, no env-var kill-switch
  - [x] Verification tokens recorded
  - [x] **Output**: `docs/research/stats-cache-why.md` (75 lines, 3 resolutions ranked)
  - **FINDING (CONFIRMED 2026-05-20 14:23 via second outer-seam test):** writer fires when `/usage` panel fully mounts. First attempt (14:13) was inconclusive (panel dismissed mid-mount, no write). Second attempt with "Stats dialog dismissed" outcome (the actual panel reaching mount) triggered the write: mtime advanced, size doubled (9,629→18,821 bytes), totalSessions 173→306, lastComputedDate Apr 7→May 19. Hypothesis from initial subagent investigation is confirmed.
  - **IMPACT ON v2:** Path A IS recoverable (open /usage refreshes cache), but Path B (live aggregation) is still recommended — the dependency on a user-action-driven Anthropic-owned cache file is the exact failure mode that froze us at 173 sessions. Path B eliminates that class of failure.

- [x] **0.2 — API capability audit** → `docs/research/api-coverage-matrix.md` §1
  - [x] 24 endpoints enumerated, consumers traced
  - [x] 16 WS event types audited; **1 orphan (`hookPerfEvent` no reducer case), 1 stateful but no UI (`configChange`)**
  - [x] 8 cache-dependent fields catalogued (would go dark if cache removed)
  - [x] **6 API endpoints rendered nowhere in UI:** `/api/failures` (full query), `/api/failures/digest`, `/api/failures/alert-threshold`, `/api/failures/top-cost`, `/api/hook-perf`, `/api/hook-perf/slowest`, `/api/hook-perf/regressions`

- [x] **0.3 — Live-aggregation feasibility** → `docs/research/api-coverage-matrix.md` §2
  - [x] Transcript schema sampled (10 record types; tokens but no cost field — must compute via `cost-rates.js`)
  - [x] **Measured: 729 transcripts (13,687 lines, 416 MB), full walk ~2s, memory ~300 KB, incremental update <1ms**
  - [x] **Recommendation: in-memory aggregator on boot + chokidar incremental updates** — easily affordable, no architectural friction

- [x] **0.4 — Tech-stack decision** → `docs/research/v2-stack-decision.md`
  - [x] 4 candidates compared (status quo, shadcn-aligned, SolidJS, SvelteKit)
  - [x] **Recommendation: Option B — Shadcn-aligned** (React 19 + Vite + Tailwind v4 + shadcn/ui + Radix + Recharts). 100% verbatim component lift from v1; aligns with `<user-setup>/shadcn-kit` direction; no runtime dep added.
  - [x] Subagent disclosed it could not locate `shadcn-kit/`/`html-kit/` in this clone (workspace tree only); recommendation rests on `Workspace/CLAUDE.md` declared direction

- [x] **0.5 — IA proposal** → `docs/research/v2-ia.md`
  - [x] 7 surfaces designed: Live, Sessions, Subagents, **Oversight (new)**, Failures, Trends, History
  - [x] Each surface has ASCII layout, data sources, lift list, what's-new, conditional dependencies
  - [x] Header strip spec, navigation pattern (sidebar + sticky header + Cmd-K palette), default-surface logic, empty-state strategy all defined
  - [x] Cross-cutting dependency table resolves every conditional (e.g., 0.6 confirmed 6 event types → Oversight keeps own surface)

- [x] **0.6 — Oversight + npm-plug-in integration audit** → `docs/research/oversight-and-npm-integration.md`
  - [x] 6 bridge files audited; all data flows mapped to v1 components (or marked as gap)
  - [x] **`oversight-events.jsonl`: 6 event types catalogued.** `instructions_loaded` dominates at 76% noise (1,726/2,266); 309 `oversight_auto_inject`; 49 `subagent_orphan_alert`; rest rare. None surfaced in real-time anywhere in v1.
  - [x] Bridge pattern recommendation: keep `createRequire` for read-only modules; add `server/oversight-bridge.js` façade + new chokidar-driven `OVERSIGHT_EVENT` WS frame for real-time push
  - [x] **Scribe surfaces found: 5 `recommendations.md`/`cleanup.md` files + 85 `learnings/*.md` topic files.** Recommendation: read-only viewer in Oversight tab
  - [x] **npm pack measured: 312.2 KB packed / 1.1 MB unpacked, 41 files.** Estimated v2 delta: +400-800 KB → still well under common npm limits
  - [x] CLI audit: `start` and `dev` need `--ui v1|v2`; `setup`/`status`/CLI query commands are UI-agnostic; `install-skills.js` has no UI assumptions
  - [x] **Packaging recommendation: Option (a) — bundle both UIs in same tarball, gated by `RH_TELEMETRY_UI` env var + `--ui` flag.** Single install command preserved.

**Phase 0 verification (outer seam):** all 5 outputs exist (75/155/155/71/322 lines), each cites verified sources with tokens, all conditionals resolved. No code merged.

**Time spent:** 4 subagents in parallel, ~14 min wall-clock (1.97 s of that was the actual transcript walk).

### Phase 0 KEY FINDINGS for Phase 1+ planning

1. **Stats-cache cause is strong-hypothesis-not-confirmed:** writer requires interactive `/usage` panel. **Action item for user (5 min):** open `claude` interactively, type `/usage`, check if `~/.claude/stats-cache.json` mtime advances. This confirms the hypothesis and as a side-effect refreshes v1's Overview tab.
2. **Live aggregation is cheap and the right answer for v2** regardless of Path A outcome — eliminates dependency on a third-party-owned cache file.
3. **Oversight has rich live signal that v1 ignores** — promoting Oversight to its own surface (Surface 4) is the single highest-value structural change.
4. **Subagent-cross-check missing in v1**: 49 orphan events + 1 protocol violation in `oversight-events.jsonl` never surface; should live in Subagents (Surface 3) + Failures (Surface 5).
5. **Stack pick: shadcn-aligned React** keeps 100% v1 component lift while unlocking proper primitives for the new surfaces.
6. **npm shipping: option (a)** — bundle both UIs, gate by env-flag. Preserves `npm install -g rh-telemetry` as the single install command.

---

## Phase 1 — Architecture skeleton (v2 package, env flag, no v1 changes) — **COMPLETE 2026-05-20**

- [x] **1.1 — Create v2 package** — chose **subdir** layout (not separate workspace). v2 source at `src-v2/`, entry `index.v2.html`, build config `vite.config.v2.js`, output `dist-v2/`. v1 dirs untouched. New devDeps NOT added — hello-world reuses React 19 + Vite 6 + Tailwind v4 already installed for v1.
- [x] **1.2 — Server env-flag mount** — `server/index.js:67-82` reads `RH_TELEMETRY_UI`; picks `dist/` (default) or `dist-v2/`; uses `index.html` or `index.v2.html` as fallback route. Logs `[server] UI=v{1,2}, serving <path>`. Warns + skips static mount if chosen dir missing.
  - **Outer-seam tests (all verified in session):**
    - `RH_TELEMETRY_PORT=7891 node server/index.js` → serves v1 `dist/index.html`, log says `UI=v1`
    - `RH_TELEMETRY_PORT=7891 RH_TELEMETRY_UI=v2 node server/index.js` → serves v2 `dist-v2/index.v2.html`, log says `UI=v2`
    - `RH_TELEMETRY_PORT=7891 node bin/rh-telemetry.js start --ui v2` → same as above (CLI passes through correctly)
    - `/api/health` returns `{"status":"ok"}` in all cases
- [x] **1.3 — Document the flag** — CLAUDE.md "Quick Start" + new "v2 frontend (in-flight, opt-in)" section; README.md Alternative Clone & Dev + new "v2 frontend" section; bin/rh-telemetry.js help text gains `--ui v2` for `start` and `dev`.
- [x] **1.4 — npm-pack smoke test** — `npm pack --dry-run` confirms dist-v2/ ships.
  - **Before Phase 1:** 41 files, 312.2 KB packed / 1.1 MB unpacked
  - **After Phase 1:** 47 files, 370.0 KB packed / 1.3 MB unpacked
  - **Delta:** +6 files (dist-v2/index.v2.html 0.5 KB, assets/css 28.8 KB, assets/js 196 KB, favicon.svg 0.3 KB, toolbelt-logo.png 6.9 KB, .gitkeep 13 B) = +57.8 KB packed / +200 KB unpacked. Well under the 700-800 KB Phase 0.6 estimate (because v2 is still hello-world with no Recharts/shadcn deps yet).

**Phase 1 verification (outer seam):** ALL PASS — v1 still loads by default; v2 loads with flag; CLI passes flag through; npm tarball includes both UIs; existing :7890 server untouched throughout testing (spawned tests on :7891).

**Time spent:** ~1 hour.

### Phase 1 NOTES for Phase 2+

- Hello-world v2 imports `MODEL_COLORS` from `src/lib/model-colors.js` (v1's source) to prove the cross-tree import works — this is the pattern Phase 3 will use for component lift.
- `bin/rh-telemetry.js` `start --ui v2` works via env var injection through the `run()` helper.
- `client:v2` Vite dev server runs on `:5174` (v1 on `:5173`) — Phase 3 dev can hit either independently.
- User's live :7890 telemetry server was NOT restarted — its in-memory copy of `server/index.js` is pre-edit. Restart needed to pick up the new env-flag logic on that instance. Not a Phase 1 blocker.
- v2 tarball delta (+57.8 KB) is much smaller than Phase 0.6's 700-800 KB estimate because hello-world has no shadcn/Radix/Recharts deps yet. Re-measure at end of Phase 3 against the size budget.

---

## Phase 2 — API additions (only if Phase 0.3 says we need them)

Conditional on Phase 0.3 outcome. Two paths:

- **Path A** (stats-cache is recoverable per 0.1): status **uncertain** — first outer-seam test (user ran `/usage`) showed mtime did not advance, but the test was inconclusive (dismissed-dialog ambiguity; Access-time advance not conclusively attributable to panel mount). Either way, Path A is not load-bearing for v2 — Anthropic owns the cache and depending on it creates a recurring failure mode.
- **Path B** (stats-cache replaced with live aggregation) — recommended regardless of Path A status — **COMPLETE 2026-05-20**:
  - [x] **2.1** — `server/aggregates-store.js` (337 lines) — in-memory aggregator with `loadAll()` boot walk + `reloadSession()` incremental updates. Walks one level deep (`<projDir>/*.jsonl`) — subagent transcripts under `<sessionId>/subagents/agent-*.jsonl` correctly excluded from session counts. Output shape MATCHES `parser.js:parseStatsCache` for drop-in v1 compatibility.
  - [x] **2.2** — `GET /api/aggregates` endpoint wired in `server/index.js`.
  - [x] **2.3** — WS event `aggregatesUpdated` broadcast on every aggregate change (boot + each incremental reload). Wired in `broadcaster.js`.
  - [x] **2.4** — Unit tests: 8/8 pass (`tests/unit/aggregates-store.test.js`). Covers: missing dir, empty dir, single session, multi-day/multi-model, corrupt lines, longestSession, reloadSession, update event.
  - [x] **2.5** — Integration tests: 2/2 pass (`tests/integration/aggregates-endpoint.test.js`). Spawns real server with HOME=tmp, seeds transcripts under tmp/.claude/projects/, asserts on GET /api/aggregates response.
  - [x] **Chokidar watcher** on `~/.claude/projects/**/*.jsonl` wired into `server/index.js` startup. Handles add/change/unlink → `reloadSession` or `removeSession`.
  - [x] **Outer-seam verification (real data):**
    - Boot log: `[aggregates] loaded 140 sessions from 140 transcripts in 2105ms` (matches research 0.3's ~2s estimate)
    - `GET /api/aggregates`: totalSessions=140, totalMessages=45,832, totalCost=$19,413.38, dailyActivity covers 29 days, modelUsage has Sonnet/Opus 4-7/Opus 4-6/`<synthetic>`
    - **Aggregator (140) vs stats-cache (306) discrepancy is EXPECTED**: cache retains aggregates from pruned transcripts. Cache firstSessionDate = 2026-03-01; aggregator firstSessionDate = 2026-04-16 — the gap is pruned transcripts the cache "remembers". Both are correct, answer different questions.

**Phase 2 time spent:** ~1.5 hours.

### Phase 2 NOTES for Phase 3+

- v2's History surface should label numbers carefully: "live sessions on disk (140)" vs "lifetime sessions per cache (306)". Don't conflate.
- For "lifetime" recovery in v2: optional follow-up could write the aggregator output to its OWN persistent file (`~/.claude/rh-telemetry-aggregates.jsonl`) and survive transcript pruning. Out of Phase 2 scope.
- The `<synthetic>` model bucket comes from synthetic system messages — v1's cost-rates defaults unknown models to sonnet pricing, may want to filter `<synthetic>` from displayed model lists.
- Watcher uses polling per existing Windows/OneDrive conventions. For 140 main + 595 subagent files, polling is fine.

---

## Phase 3 — v2 UI build (full redesign, all surfaces) — **COMPLETE 2026-06-12 (all 7 surfaces live)**

**What's done (2026-05-20):**

- [x] **3.4 — Failures** (`src-v2/components/FailuresSurface.jsx` + `hooks/useFailures.js`): summary cards (total / in-window / top tool / top error count), 7-day daily bars header (red), top tools + top errors side-by-side ranked lists, **`/api/failures/top-cost` D4 endpoint surfaced** (was API-only in v1), recent failures table with `errorClass` colour mapping. Day range 24h/7d/30d. Subscribes WS `failureEvent` for live appends. Outer-seam verified: total=1.0K lifetime, in-window-7d=183, top tool=Agent (336).
- [x] **3.5 — Oversight (NEW top-level)** (`src-v2/components/OversightSurface.jsx` + `hooks/useOversight.js` + `server/oversight-bridge.js` + `GET /api/oversight/events`): 6 event types catalogued from Phase 0.6, **heartbeat (`instructions_loaded`, 692) separated from actionable signal (160)** so the dominant noise doesn't drown the meaningful events. Actionable section: WARNING (auto-inject 76, OVERSIGHT_STATE.md stale 72) + ALERT (subagent_orphan 12). Recent events feed shows real subagent_orphan_alert occurrences with session IDs. Polls every 30s (WS push deferred per Phase 0.6 follow-up).
- [x] **3.7 — History** (the cache replacement): `src-v2/components/HistorySurface.jsx`. Consumes `GET /api/aggregates` + WS `aggregatesUpdated` via `src-v2/hooks/useAggregates.js`. 4 summary cards (sessions/messages/cost/first-session), model breakdown table, 29-bar daily activity, 24-cell hour heatmap, longest-session block. Filters out `<synthetic>` model bucket.
- [x] **3.8 — Header strip** (`src-v2/components/Header.jsx`): env badge `[v2]`, 3-dot model legend pulled from v1's `MODEL_COLORS`, relative-time "updated Ns ago" (turns amber after 60s), refresh button.
- [x] **3.9 — Visual contract**: v2 imports v1's `src/lib/model-colors.js` directly (cross-tree import works as designed in Phase 1). Same dark theme, same gray-950 / gray-900 / gray-800 surface hierarchy.
- [x] **Shell** (not in original list — needed): `src-v2/App.jsx` + `src-v2/components/Sidebar.jsx` with all 7 surfaces. Sidebar + sticky header layout per `docs/research/v2-ia.md`. Default surface = History (consumes the live aggregator).
- [x] **Placeholder surfaces** for the other 6: explanatory cards stating phase-ref + data source so the layout reads as a coherent IA even before they're built.

**Outer-seam verification (browser, real data, current run):**
- Playwright MCP, fresh build, fresh server with `RH_TELEMETRY_UI=v2`
- Visual screenshots saved under `packages/telemetry/docs/screenshots/v2/`:
  - `01-history.png` — sessions 141, messages 46.1K, cost $19,494, 3 model rows, 29 daily bars, 24 hour cells, longest-session block
  - `02-failures.png` — total 1.0K, in-window 183, top tool Agent, 7-day red bars, ranked top tools/errors, recent failures table
  - `03-oversight.png` — total 852, actionable 160 (amber), heartbeat 692 (gray), 3 actionable event types color-coded WARNING/ALERT, recent events feed with session-id pills
- **Zero console errors** in any surface
- Header `updated 1m ago` turns amber correctly when WS quiet >60s
- User's live :7890 server untouched throughout

### What's now done (added 2026-05-20 second pass)

- [x] **3.6 — Trends**: `src-v2/components/TrendsSurface.jsx` — adapted near-verbatim from v1's `TrendsTab.jsx`. Same Recharts BarChart, same 3 summary cards with current-vs-prior delta, same event-type table, same patterns lists, same hot-sessions table. Uses existing `/api/trends?days=N` endpoint. Visual: `04-trends.png`.
- [x] **Theme tokens expanded** (`src-v2/index.css`): mirror v1's `@theme` block so component lifts use the same `text-accent`/`text-amber`/`text-green`/`text-red`/`text-blue`/`text-cyan` token names. Re-screenshotted History after the change — unchanged.
- [x] **Visual test plan** (`docs/screenshots/v2/README.md`): explicit checklist of what automated DOM verification CANNOT catch (layout-width responsiveness, color contrast, interaction states, empty states, header staleness indicator, WS live behavior). Designed for Claude Desktop human walkthrough.

### Completed 2026-06-12 (third pass — closes the Phase 3 backlog)

- [x] **3.1 — Live** (`src-v2/components/LiveSurface.jsx`): lifts v1's `useDashboardData`, `ContextWindow`, `ModelBreakdownMini`, `TurnHeartbeat`, `CurrentPrompt`, `AgentActivity`, `ToolActivity` verbatim via cross-tree import (the Phase 1 pattern). Adds a v2 session picker (activity dot + workspace label) + meta strip. Designed empty state per v2-ia.md. Cleanup row `77cb9091dc`.
- [x] **3.2 — Sessions** (`src-v2/components/SessionsSurface.jsx` + `hooks/useSessions.js` + `GET /api/sessions`): aggregator gained `getSessions()` per-session serialization (sessionId, projectDir/path, msgs, tools, cost, duration, primaryModel, per-model tokens). UI: search, project + model-family filters, 4 sorts, 50/page client-side pagination. Refetches on WS `aggregatesUpdated`. Cleanup row `2d4fcda7fb`.
- [x] **3.3 — Subagents** (`src-v2/components/SubagentsSurface.jsx` + `hooks/useSubagents.js` + `GET /api/subagents`): aggregator now walks `<projDir>/<sessionId>/subagents/agent-*.jsonl` two levels deep. **Agent type/status/prompt joined from the parent transcript's `toolUseResult` records** (the only place dispatch metadata lives — agent transcripts carry only model/usage). Leaderboard by type (runs, ∑cost, ∑tokens, avg dur, fails, top model) + recent-runs table with click-to-expand prompt detail. New WS frame `subagentsAggUpdated`. Cleanup row `bd60f0ea61`.
- [x] **Oversight WS push** (deferred from 3.5): `startOversightWatcher()` in `server/oversight-bridge.js` — chokidar polling watch on `oversight-events.jsonl`, byte-offset tail reader that only consumes complete lines (no half-parsed events), `oversightEvent` WS frame via new `broadcastFrame()` export. `useOversight` triggers a debounced refetch on the frame; the 30s poll is KEPT as fallback (ADDITIVE ONLY). Cleanup row `11b47974e9`.
- [x] **Watcher routing bug fixed** (found during 3.3): the `**/*.jsonl` chokidar watcher in `server/index.js` was feeding subagent transcript writes into `reloadSession()`, silently inserting `agent-*` pseudo-sessions into session aggregates after boot. Now routed through `decomposeSubagentPath()` → `reloadSubagent()`. Unit test pins both walks (`subagent transcripts do NOT inflate session aggregates`).

**Tests:** `tests/unit/subagents-aggregation.test.js` (5 tests) + `tests/integration/v2-surfaces-endpoints.test.js` (2 tests, incl. WS oversightEvent push against a spawned server with tmp HOME).

**Phase 3 time spent:** ~1 hour (first pass) + this session.

---

## Phase 4 — Parity check + flip default

- [ ] **4.1** — Side-by-side comparison: open v1 (`RH_TELEMETRY_UI=v1`) and v2 (`RH_TELEMETRY_UI=v2`) in two tabs, walk through every v1 surface and confirm v2 equivalent exists or is intentionally dropped
- [ ] **4.2** — Document any intentionally-dropped v1 features in `docs/v2-vs-v1.md` with rationale (this is a removal — `rh-replacement-assessment.md` rule applies)
- [ ] **4.3** — Run all existing tests: `npm run test:all` — confirm no v1 regressions
- [ ] **4.4** — Flip default: change the unset behavior in `server/index.js` from v1 to v2
- [ ] **4.5** — v1 remains available via `RH_TELEMETRY_UI=v1` for at least one release cycle
- [ ] **4.6** — **npm plug-in delivery verification**: `npm pack`, install the resulting tarball into a clean tmp dir, run `rh-telemetry start` and `rh-telemetry start --ui v1`, hit `/` in browser, confirm both UIs load. Record tarball size.
- [ ] **4.7** — **Oversight integration smoke test**: trigger a known oversight event (e.g. force a Layer 3a rejection), confirm v2 surfaces it on the Oversight tab within the WebSocket update window.

**Phase 4 verification (outer seam):** fresh checkout, `npm install && npm run build && npm start`, dashboard loads v2 by default. Existing CI passes. `npm pack` tarball installs into a clean tmp HOME and serves both UIs per the flag.

**Estimated time:** 2-4 hours.

---

## What is VERIFIED via outer seam (this session, before plan)

| Item | Verification |
|---|---|
| `stats-cache.json` mtime + content | `ls -la` + `cat`-piped to Python JSON parse, both run in session |
| `parser.js` reads `totalSessions` from cache | Direct read of file + grep confirmed single source |
| `OverviewTab.jsx` renders it as the headline card | Direct read of component lines 13, 28 |
| API surface is decoupled from UI | Direct read of `server/index.js` lines 66-73 |
| Git state clean, no orphaned worktrees/branches | `git status`, `git worktree list`, `git branch --no-merged`, `git rev-list ...` |
| 729 transcript JSONLs across 59 project dirs | `find` + `wc -l` run in session |
| Oversight + failure JSONLs live (today's mtime) | `ls -la` run in session |

## What is PARTIAL (NOT verified)

After Phase 0:

| Item | Status | Linked phase item |
|---|---|---|
| Stats-cache root cause | **CONFIRMED 2026-05-20 14:23** via second outer-seam test. Writer fires on full `/usage` panel mount. Cache now refreshed (173→306 sessions). Path A is technically available but Path B still recommended for v2 to avoid the recurrence failure mode. | 0.1 |
| `shadcn-kit/` / `html-kit/` actual contents | Subagent could not locate in this clone — Workspace tree not present. Verify recipes when Phase 3 starts | 0.4 |
| Outer-seam verification for any Phase 1-4 code | Pending — no code yet | 1+ |

## Recovery notes

- Each phase is independently committable. v1 is untouched until Phase 4.4.
- If Phase 0.1 finds `stats-cache.json` is recoverable, Phase 2 collapses to a one-line fix and the plan accelerates.
- If Phase 0.4 picks shadcn but the migration cost is later judged too high, fall back to status-quo React + Tailwind without invalidating Phases 0.1-0.3 or 0.5.
- Phase 1's env flag means we can ship a half-built v2 without affecting anyone — no risk to v1 users at any point until Phase 4.4.

## Out of scope

- Telemetry hook protocol changes (server input contract is stable; only the UI consumption changes)
- v1 component cleanup (v1 stays untouched; deletions, if any, happen in a follow-up plan after v2 default flip)
- Mobile/touch optimization
- Authentication / multi-user (telemetry stays local-only per existing model)
