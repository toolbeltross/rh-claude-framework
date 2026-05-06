# Turn Timeline Visualization — Next Steps

## Status (2026-04-27)

### Complete
- Hook latency instrumentation (`hook-timing.js`, all 5 hooks, `hook-perf.jsonl`, server endpoints, CLI)
- `duration_ms` forwarded from Claude Code → hook-forwarder → server → store (was missing, now fixed)
- Per-turn event accumulation in `store.js` (`_currentTurnEvents`, `_currentTurnStartTs`)
- First-draft UI: `TurnHeartbeat.jsx` (live strip) + `TurnsTab.jsx` (historical) — functional but needs viz rework

### Needs rework — visualization

Current Gantt-bar approach replaced with user-chosen design:

**Option B — Lollipop/stem chart (primary viz)**
- Each tool call = vertical stem from baseline, height = `duration_ms`
- Colored dot at top by tool type (Read=blue, Bash=green, Write/Edit=amber, Agent=purple)
- X-axis = seconds within turn (0s → elapsed/end), time scale ticks
- Rich mouseover tooltip: tool name, duration, timestamp, agent context if applicable

**Option D — Heatmap density strip (compact companion)**
- Single row of cells, color intensity = tool activity density per time bucket (e.g., 5s windows)
- Below or alongside the lollipop chart
- Mouseover: tool count + total duration for that bucket

### Also needed
- End-to-end verification: complete a turn, confirm Turns tab populates with events + timeline
- Swimlane layout option for the Turns tab click-to-expand detail view
- Live animation as WebSocket tool events arrive

## Key files to modify
- `src/components/TurnHeartbeat.jsx` — replace TimelineStrip with lollipop + heatmap
- `src/components/TurnsTab.jsx` — add richer detail view (swimlane option)
- `server/store.js` — per-turn event data (already done)

## Hook-forwarder location
`~/.claude/settings.json` hooks point to this project's `scripts/hook-forwarder.js`. The legacy duplicate clone was retired 2026-04-28 — single canonical copy.
