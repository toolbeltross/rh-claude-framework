# Phase 0.5 — v2 Information Architecture Proposal

> Research output from subagent dispatch, 2026-05-20. Source registry at bottom of `v2-stack-decision.md`.

## Navigation pattern + default surface

**Pattern: sidebar (left rail) + sticky header strip.** v1 uses a horizontal tab bar that mixes meta-surfaces (Overview, Trends) with per-session tabs — this conflates "what kind of view" with "which session", and the bar overflows quickly when 3+ live sessions appear. v2 separates concerns:

- **Left rail (collapsible, 200px expanded / 48px collapsed):** the 7 top-level surfaces (Live, Sessions, Subagents, Oversight, Failures, Trends, History). Icon + label.
- **Sticky header strip (top, full width):** see "Header strip spec" below.
- **Command palette (`Ctrl/Cmd+K`):** quick-jump to surface, recent sessions, recent failures, recent agents. Shadcn `Command` primitive.
- **Per-session selection:** moves into the Live and Sessions surfaces as a secondary picker (segmented control or breadcrumb), not into the global nav.

**Default surface on cold load:**
1. If any live session is processing → **Live** (auto-selected first processing session).
2. Else if any live session exists (idle) → **Live** (idle view).
3. Else if recent failures within last 24h → **Failures**.
4. Else → **Sessions** (most recent file-based session list).

This replaces v1's "default to stale Overview" behavior — cold-load priority always points at fresh, actionable data.

## Header strip spec

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ [rh-telemetry v2]  PlanUsage gauges (Opus|Sonnet|Haiku quota)  │ LIVE 2 │ ⚠1 stalled │ ↻ │ ? │ ↗ │
│  ●Opus ●Sonnet ●Haiku  [env: v2 ▾]  [last update: 3s ago]                          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Contents (left to right):
- **Brand mark + version** (`rh-telemetry v2.x.x`)
- **PlanUsage gauges** — lifted verbatim from v1 (`PlanUsage.jsx`). Always visible.
- **Model legend** — three colored dots (Opus/Sonnet/Haiku), reuses `MODEL_COLORS` exactly. Click for tooltip with hex + class names.
- **Env flag indicator** — small badge `[env: v2]` clickable to swap if `?ui=v1` query allowed. Hidden when only one UI is built. Critical for parity testing during Phase 4.
- **Last-update timestamp** — relative time since last WS broadcast; turns amber if >10s, red if >60s (connection issue indicator).
- **Live count chip** — `N LIVE`, green pulsing if any processing, blue solid if all idle.
- **statusLine health dot** — lifted from v1 (amber/red on degraded).
- **Refresh button** — manual `/api/refresh` POST.
- **Help dropdown** — lifted from v1 (`HelpDropdown`).
- **Pop-out (PiP) button** — lifted from v1 (`usePictureInPicture`).

## Empty-state strategy

Every surface ships with a designed empty state (not a layout gap):
- **Centered icon + headline + one-sentence guidance + actionable CTA.**
- **Live (no session):** "No active Claude Code session. Run `claude` in a terminal — it will appear here within 3s." + link to `rh-telemetry setup` if hooks not configured.
- **Sessions (no history):** "No sessions on disk yet." + path hint `~/.claude/projects/`.
- **Subagents (none across all sessions):** "No subagent activity in the last 7 days." + day-range expander.
- **Oversight (no events):** "No oversight events recorded." + setup link.
- **Failures (none):** "No failures in the last 24h." + range expander. (Positive empty state — not framed as a problem.)
- **Trends (no data):** lift v1 empty handling.
- **History (no data):** "No historical activity." + ingestion-status note.

Convention: empty states still render the section header strip so the layout never collapses — matches v1 styleguide §4 ("empty-state panels still need a header").

---

## Surface 1 — Live

**Purpose:** One pane of glass for the currently-active Claude Code session — context runway, current prompt, subagent activity, and tool stream.

```
┌─ LIVE ─────────────────────────────────────────────────────────────────┐
│ Session: [▾ proj-foo (a1b2c3d4)]  ●processing  3m 42s elapsed         │
├────────────────────────────────────────────────────────────────────────┤
│ ┌──────── ContextWindow ─────┐ ┌── ModelBreakdownMini ──┐ ┌─ Turn ──┐ │
│ │ 67% ████████░░░  134K/200K │ │  ○Opus 78%             │ │  $1.24  │ │
│ │ ~9 turns left              │ │  ○Sonnet 22%           │ │  17K/T  │ │
│ │ in 12K  out 4K  cache 118K │ │                        │ │  9 done │ │
│ └────────────────────────────┘ └────────────────────────┘ └─────────┘ │
├────────────────────────────────────────────────────────────────────────┤
│ Current prompt:  "implement v2 stack decision"           [submitted 2m]│
├────────────────────────────────────────────────────────────────────────┤
│ ┌─ TurnHeartbeat ──────────────────────────────────────────────────┐  │
│ │ ●●●●●●● ◇ ●●●●● ⚑ ●●●●●●●●● ◯ ●●●●●  (live tool ticks)         │  │
│ └──────────────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────────────┤
│ Active subagents (2):                                                  │
│  ● Explore  Haiku   $0.02   8K   1m30s  "find shadcn refs"           │
│  ● Plan     Sonnet  $0.18  22K   3m10s  "design v2 IA"                │
├────────────────────────────────────────────────────────────────────────┤
│ [Tools | Failures | Details] tabs — recent tool stream (last 50)       │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:** WS `liveSessions[activeSession]` from `server/store.js`, populated by `POST /api/status`, `/api/hooks`, `/api/prompt`, `/api/subagent`, `/api/turn-end`.

**Lift verbatim:** `ContextWindow.jsx`, `ModelBreakdownMini.jsx`, `TurnHeartbeat.jsx`, `CurrentPrompt.jsx`, `TurnTracker.jsx`, `ToolActivity.jsx`, `SubagentTracker.jsx` (active-agents table portion).

**What's new:** session picker promoted into the surface (not the global nav); session-meta strip with elapsed time always visible.

**Conditional:** if 0.2 finds WS events broadcast but never rendered (e.g. compaction events, model switches), add an "Events" inline strip below TurnHeartbeat. If 0.6 finds scribe outputs are usable, add a collapsible "Scribe" right-drawer.

---

## Surface 2 — Sessions

**Purpose:** Browse, filter, and open any historical session across all projects.

```
┌─ SESSIONS ─────────────────────────────────────────────────────────────┐
│ [Search ⌕]  [Project ▾]  [Model ▾]  [Date range ▾]  [Sort: Cost ▾]    │
├────────────────────────────────────────────────────────────────────────┤
│ Project    │ Session  │ Model   │ Cost   │ Tokens │ Duration │ Status │
│ rh-frame…  │ a1b2c3d4 │ ●Opus   │ $4.28  │  450K  │ 15m 02s  │ ●live  │
│ rh-frame…  │ 9f8e7d6c │ ●Sonnet │ $2.10  │  220K  │  8m 14s  │ idle   │
│ playground │ 3a2b1c0d │ ●Haiku  │ $0.40  │   90K  │  3m 11s  │ —      │
│ ...                                                                    │
├────────────────────────────────────────────────────────────────────────┤
│ [< 1 2 3 ... 24 >]   showing 1-50 of 1,180 sessions                    │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:** `data.sessions` (from `parser.js` reading `~/.claude.json` + per-project transcripts), plus the new `GET /api/aggregates` if Phase 2 Path B lands.

**Lift verbatim:** `SessionList.jsx`, the Recent Sessions table from `OverviewTab.jsx`.

**What's new:** filters (project, model, date), search, pagination — currently absent. Click-through opens the Live surface scoped to that session.

**Conditional:** depends on 0.3 — if 729-transcript full-walk is feasible at <500ms, paginate client-side from `/api/aggregates`. If not, server-side pagination via `?page=N`. Note: 0.3 measured ~2s full walk on cold boot; client-side pagination is fine post-boot since the aggregator is always-warm.

---

## Surface 3 — Subagents

**Purpose:** Cross-session subagent leaderboard — who's spawned what, cost per agent type, failure rates.

```
┌─ SUBAGENTS ────────────────────────────────────────────────────────────┐
│ Range: [7d ▾]   Group by: [Agent type ▾]                               │
├────────────────────────────────────────────────────────────────────────┤
│ Type         │ Runs │ ∑Cost │ ∑Tokens │ Avg Dur │ Fails │ Top model   │
│ general      │  142 │ $48.12│   3.2M  │  4m 02s │   3   │ ●Opus       │
│ Explore      │   88 │  $6.31│   1.1M  │  1m 14s │   1   │ ●Haiku      │
│ Plan         │   54 │ $12.40│   2.0M  │  3m 22s │   0   │ ●Sonnet     │
│ scribe-*     │   31 │  $0.92│    0.3M │    44s  │   0   │ ●Haiku      │
├────────────────────────────────────────────────────────────────────────┤
│ Recent agent runs (last 50, click to expand prompt+result)             │
│  ● rh-research-agent  Opus  $1.04  12m05s  proj=foo  ●completed       │
│  ● Explore            Haiku $0.02   1m30s  proj=bar  ●orphaned         │
│  ...                                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:** Per-session `_subagentHistory` from `liveSessions`, plus a new aggregation walking transcript JSONL for `subagent_*` events. If 0.3 feasibility check is positive (confirmed: ~2s full walk), fold into `aggregates-store.js`.

**Lift verbatim:** `AgentActivity.jsx`, `SubagentTracker.jsx` (history table portion), `SubagentTimeline.jsx` (per-session expanded view).

**What's new:** cross-session aggregation — currently the only subagent view is per-live-session. Failure rate column, average duration column.

**Conditional:** 0.6 confirmed oversight package emits `subagent_orphan_alert` (49 events) and `subagent_protocol_violation` (1 event) — add a "Cross-check violations" column sourced from `oversight-events.jsonl`.

---

## Surface 4 — Oversight (NEW)

**Purpose:** Surface every oversight signal the system already produces — Layer 3a rejections, guard outcomes, hook timings, scribe artifacts — promoted from "buried in Trends" to its own top-level home.

```
┌─ OVERSIGHT ────────────────────────────────────────────────────────────┐
│ Range: [7d ▾]                                                          │
├──────────────── Summary cards ─────────────────────────────────────────┤
│ ┌─ Layer 3a ─┐ ┌─ Guards ─┐ ┌─ Hook perf ─┐ ┌─ Scribe ─┐              │
│ │ 14 reject  │ │ 38 block │ │ p95 142ms   │ │ 7 outputs │              │
│ │ ↓ -3 wk    │ │ ↑ +5 wk  │ │ 2 slow      │ │ 1 stale  │              │
│ └────────────┘ └──────────┘ └─────────────┘ └──────────┘               │
├──────────────── Event-type table ──────────────────────────────────────┤
│ Type                       │ Count │ Δ prior │ Last seen │ Top session │
│ instructions_loaded        │ 1726  │   -52   │  1m ago   │ rh-frame…   │
│ oversight_auto_inject      │  309  │   +12   │  8m ago   │ playground  │
│ daily_regen_stale_alert    │  182  │   +18   │  2h ago   │ —           │
│ subagent_orphan_alert      │   49  │    -2   │ 30m ago   │ rh-frame…   │
│ subagent_protocol_violation│    1  │     0   │  4d ago   │ rh-frame…   │
│ journal_staleness_alert    │    1  │     0   │  3d ago   │ —           │
├──────────────── Hook performance ──────────────────────────────────────┤
│ Hook            │ Runs │ p50 │ p95  │ Fails │ Last fail              │
│ PreToolUse:Bash │ 412  │ 18ms│ 142ms│   0   │ —                      │
│ Stop            │  87  │ 3.2s│ 8.1s │   2   │ "agent timeout" 1h ago │
├──────────────── Scribe drawer (collapsible right side) ────────────────┤
│ recommendations.md (proj=rh-frame, 2m ago)  ▸ click to view            │
│ cleanup.md (proj=rh-frame, 1h ago)          ▸                          │
│ learnings/2026-05-20.md                     ▸                          │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `~/.claude/oversight-events.jsonl` via new endpoint `GET /api/oversight/events?days=N`
- `server/hook-perf-store.js` via existing internal store, expose as `GET /api/oversight/hook-perf`
- `GET /api/trends` (existing) for delta calculations
- Scribe files: per-workspace `recommendations.md`, `cleanup.md`, `learnings/*.md`. Read via new `GET /api/oversight/scribe?workspace=...` (0.6 confirmed paths)

**Lift verbatim:** `TrendsTab.jsx` patterns (delta calculation, day-range selector, BarChart). The event-type table is a near-copy of TrendsTab's `eventTypeRows` rendering.

**What's new:** entire surface — no UI today for guards, hook perf, or scribe outputs.

**Conditional (0.6 confirmed):** 6 distinct `event_type` values found → keep Oversight as its own surface (between 5–15 threshold). `instructions_loaded` dominates at 76% — render as "Heartbeat" badge separately so it doesn't drown actionable events.

---

## Surface 5 — Failures

**Purpose:** Time-bucketed view of tool failures with pattern detection — promoted from a subtab to top-level so users can see "what broke today" without drilling into a session.

```
┌─ FAILURES ─────────────────────────────────────────────────────────────┐
│ Range: [24h ▾]   Filter: [All tools ▾]   Pattern: [All ▾]              │
├─────────────────── Daily failure bars ─────────────────────────────────┤
│ ▆▇▅▃▂▁▁ █▆▅▄▃▂▁ ▇▆▅▄▃▂▁  (last 7d)                                    │
├─────────────────── Top patterns ───────────────────────────────────────┤
│ Pattern                       │ Count │ Last seen │ Top tool           │
│ "ENOENT: no such file"        │  42   │  3m ago   │ Read               │
│ "permission denied"           │  18   │  1h ago   │ Bash               │
│ "InputValidationError"        │  11   │  12m ago  │ Edit               │
├─────────────────── Recent failures (last 50) ──────────────────────────┤
│ Time   │ Session  │ Tool │ Error                       │ Pattern       │
│ 14:32  │ a1b2…    │ Read │ ENOENT: no such file /tmp/… │ enoent ⚐      │
│ 14:18  │ a1b2…    │ Bash │ permission denied           │ permission ⚐  │
│ ...                                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:** `GET /api/failures`, `GET /api/failures/patterns`, `GET /api/failures/digest`. WS `failureEvent` for live updates.

**Lift verbatim:** `FailureHistory.jsx` (entire component); daily-bars header is the only addition.

**What's new:** top-level promotion, daily bars header, pattern grouping made the default view (currently patterns are a separate API call rarely seen). Surfaces the unused `/api/failures/top-cost` D4 endpoint via a "Cost-weighted" toggle.

**Conditional:** if failure rate is low (<10/day average), keep Failures as a tab inside Sessions instead of top-level.

---

## Surface 6 — Trends

**Purpose:** Cross-session/project oversight-event aggregations over a sliding window (the existing v1 Trends tab, lifted whole).

```
┌─ TRENDS ───────────────────────────────────────────────────────────────┐
│ Range: [1 | 7 | 14 | 30] days                                          │
├────────────────────────────────────────────────────────────────────────┤
│ ┌─ Summary cards (current vs prior window) ──┐                         │
│ │ Events: 142 (+12)   Sessions: 38 (-3)      │                         │
│ │ Subagents: 21 (+4)  Layer3a: 14 (-3)       │                         │
│ └────────────────────────────────────────────┘                         │
├────────────────────────────────────────────────────────────────────────┤
│ Daily cadence BarChart  (existing TrendsTab Recharts component)        │
├────────────────────────────────────────────────────────────────────────┤
│ Event-type table | Top missing oversight | Top subagent failure pats   │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:** `GET /api/trends?days=N` (existing).

**Lift verbatim:** `TrendsTab.jsx` in full.

**What's new:** nothing — exists. May feel redundant with Oversight; resolve by scoping Oversight to "what's happening now" and Trends to "windowed historical aggregation".

**Conditional:** if Oversight's daily-events view duplicates Trends' BarChart, merge: keep Trends as the deep-aggregate view, link from Oversight summary cards to relevant Trends sections via `?event_type=` query.

---

## Surface 7 — History

**Purpose:** Replacement for v1 Overview — totals, daily activity chart, hourly heatmap. The "lifetime stats" view.

```
┌─ HISTORY ──────────────────────────────────────────────────────────────┐
│ ┌─ Summary ─────────┐  ┌─ Daily Activity ──────────────────────────┐   │
│ │ Total sessions:   │  │  ▆▇▅▃▂▁▁ ▆█▇▅▄▃▂ ▆▇▅▄▃▂▁ (msgs/sess/tools)│   │
│ │   1,180 (live)    │  │                                            │   │
│ │ Total messages:   │  └────────────────────────────────────────────┘   │
│ │   34,301          │  ┌─ Hourly Heatmap ──────────────────────────┐   │
│ │ Total cost:       │  │  ░▒▓██▓▒░  ░▒▓██▓▒░  ░▒▓██▓▒░             │   │
│ │   $412.18         │  │  (hour-of-day intensity)                   │   │
│ │ First session:    │  └────────────────────────────────────────────┘   │
│ │   2026-03-01      │  ┌─ Model Breakdown (lifetime) ──────────────┐   │
│ └───────────────────┘  │  ●Opus 62%  ●Sonnet 28%  ●Haiku 10%       │   │
│                        └────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- **Path A (0.1 says stats-cache recoverable):** existing `stats-cache.json` via `parser.js`
- **Path B (0.1 says live aggregation needed):** new `GET /api/aggregates` from `aggregates-store.js` (Phase 2)
- **Note:** 0.1 recommended *both* — Path A as 5-minute unblock, Path B as v2's durable answer

**Lift verbatim:** `DailyActivity.jsx`, `HourlyHeatmap.jsx`, `ModelBreakdown.jsx`, `MetricCard.jsx`. The summary cards section from `OverviewTab.jsx`.

**What's new:** sourcing freshness — under Path B, "Total Sessions" shows live count, not 173-frozen. Under Path A, same source as v1.

**Conditional:** depends entirely on 0.1 outcome. Under Path B, cards become live-counting via WS `aggregatesUpdated`.

---

## Cross-cutting conditional dependencies on parallel Phase 0 work (RESOLVED)

| If 0.x finds... | Status | v2 IA implication |
|---|---|---|
| 0.1: stats-cache writer was removed in a Claude Code update | **Not the case** — writer still in binary, requires interactive `/usage` panel | History surface uses Path B (live aggregation) as durable answer; Path A as temporary unblock |
| 0.1: stats-cache can be re-enabled via setting | **Not via setting** — only by opening `/usage` panel | History surface needs Path B regardless to avoid recurring stale-cache failure mode |
| 0.2: many WS events broadcast but never rendered | **Confirmed** — `hookPerfEvent` orphan + `configChange` no UI | Add event categories to Live surface (compaction strip, model-switch row) |
| 0.3: 729 transcripts walk too slow (>1s) | **~2s measured** — acceptable for boot, fine for warm cache | Sessions surface paginates client-side from warm aggregator |
| 0.6: oversight-events.jsonl has <5 event types | **Has 6 — in 5–15 range** | Keep Oversight as own surface |
| 0.6: scribe outputs are usable + stable schema | **Confirmed — 5 scribe locations + 85 learnings files** | Add scribe drawer to Oversight surface |
| 0.6: tarball >10MB | **Currently 312 KB; v2 estimated 700-800 KB** | Bundle both UIs in same tarball under env-flag mount (option a) |

## Files read (this subagent)

| File | Range | Status |
|---|---|---|
| `packages/telemetry/CLAUDE.md` | Full 1–426 | OK |
| `packages/telemetry/PLAN-20260520-frontend-v2.md` | Full 1–236 | OK |
| `packages/telemetry/package.json` | Full 1–71 | OK |
| `packages/telemetry/docs/STYLEGUIDE.md` | 1–100 | Partial |
| `packages/telemetry/src/App.jsx` | 1–470 | Partial |
| `packages/telemetry/src/components/OverviewTab.jsx`, `SubagentTimeline.jsx`, `TrendsTab.jsx` | Heads, ~50–80 each | Partial — sufficient for structural mapping |
| `packages/telemetry/src/lib/model-colors.js` | Full 47/47 | Token line 47: `};` |
| Workspace `CLAUDE.md` | 1–100 | Partial |

**v1 components:** 27 enumerated by directory listing; 17 explicitly mapped to v2 surfaces; remaining 10 are utility/sub-components used inside the 17.

**Subagent telemetry:** ~25% of 1M context window, 0 compactions.
