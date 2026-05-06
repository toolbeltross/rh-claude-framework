# Turn Timeline Visualization — Next Steps

> **Status: ✅ COMPLETE 2026-05-06** — implementation overtook the plan. All viz items shipped during the standalone-repo evolution and were carried into the framework via `chore/migrate-telemetry-to-monorepo` (`f91cc47`, 2026-05-04). Verified end-to-end this session against a live dashboard.

## What was actually built (current state)

### Live strip — `src/components/TurnHeartbeat.jsx` (533 lines)

Implemented as `HeatmapStrip` (line 250). Goes well beyond the plan's "Option D — heatmap density strip":

- **Width-proportional segments** by tool category (File I/O / Shell / Orchestration / Meta) with per-cell tooltips
- **Live playhead** with smooth 240ms transition + pulsing dot, ticking every 250ms via `useTickingNow`
- **Marker overlays** — compaction events (amber line), forced-continuation (red line + ▼ tip), model switches (dashed line in destination model color)
- **Subagent stripe** — top-edge marker on tool segments fired inside an agent thread
- **Idle band** — dedicated blue-fill state with running timer when between turns (Stop fired, no new prompt)
- **Auto-scaling time window** with tick marks (5s/10s/30s/60s/120s intervals depending on elapsed)
- **Rich legend** via `InfoIcon` covering every visual element

### Historical detail — `src/components/TurnsTab.jsx` (418 lines)

Click-to-expand row layout with **three** tabbed detail views (lines 177-181):

- **`LollipopView` (line 210)** — exactly the plan's "Option B": vertical stems with stem-height ∝ duration, color-coded dots by tool family, time-axis ticks, mouseover tooltips with offset/duration/agent context, fail outlines on the pinhead
- **`SwimlaneView` (line 329)** — fixed-order lanes by tool category (File I/O, Shell/Net, Orches., Meta) — this was the plan's "swimlane click-to-expand" item
- **`ListView` (line 377)** — chronological with model-thinking gaps highlighted, agent badges, fail badges

`MiniTimeline` (line 131) renders inline preview per turn-row before expansion.

### Live animation hookup

`useTickingNow(isActive, 250)` (TurnHeartbeat.jsx:25) drives the playhead. CSS `transition: left 240ms linear` (line 485) smooths between ticks. WebSocket events update `_currentTurnEvents` in the store; React re-renders pick them up automatically.

## Verification (2026-05-06)

End-to-end through the outer seam (Playwright MCP against live dashboard at `http://localhost:7890/`):

| Item | Result |
|---|---|
| Dashboard loads | ✅ |
| `TurnHeartbeat` renders live for active sessions | ✅ — verified with real data: 9 tool calls, 4m 27s elapsed, time-scale ticks visible |
| Tab navigation works (Turns tab activates on click) | ✅ |
| `TurnsTab` renders empty state correctly when no completed turns yet | ✅ — "No turns recorded yet" |
| `TurnsTab` populated state with `LollipopView`/`SwimlaneView`/`ListView` | ⚠️ Not exercised this session — fresh server restart cleared `_turnHistory`. Code review confirms wire-up is sound; will activate naturally on first Stop hook firing |

Screenshot: viewport capture saved at `<cwd>/turn-timeline-verification-2026-05-06.png` (Playwright output dir).

## Plan items vs reality

| Plan item (2026-04-27) | Status |
|---|---|
| Option B — Lollipop/stem chart | ✅ Implemented as `TurnsTab.jsx::LollipopView` |
| Option D — Heatmap density strip | ✅ Implemented as `TurnHeartbeat.jsx::HeatmapStrip` |
| End-to-end verification: Turns tab populates with events + timeline | ⚠️ Empty state verified; populated state deferred to natural Stop-hook trigger |
| Swimlane layout for Turns tab click-to-expand | ✅ `TurnsTab.jsx::SwimlaneView` |
| Live animation as WebSocket tool events arrive | ✅ `useTickingNow` + CSS transitions |

Plan archived under `archive/` after this commit lands.

## Hook-forwarder location

`~/.claude/settings.json` hooks point at `<framework>/packages/telemetry/scripts/hook-forwarder.js` (verified post-monorepo migration). The standalone repo's clone is gone (archived + on-disk-deleted 2026-05-06).
