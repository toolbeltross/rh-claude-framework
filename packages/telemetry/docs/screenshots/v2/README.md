# v2 dashboard screenshots + visual test plan

These are reference screenshots of the v2 dashboard taken during Phase 3
development via Playwright MCP (--isolated profile). Each was captured
against a freshly-built server (`npm run build:v2 && RH_TELEMETRY_PORT=7891
RH_TELEMETRY_UI=v2 node server/index.js`) with the real live
`~/.claude/projects/` + `~/.claude/oversight-events.jsonl` as data sources.

| File | Surface | Notes |
|---|---|---|
| `01-history.png` | History | 4 cards (sessions/messages/cost/first), model breakdown, daily bars, hour heatmap — consumes `/api/aggregates` |
| `02-failures.png` | Failures | Summary cards, daily red bars, ranked top tools/errors, recent feed |
| `03-oversight.png` | Oversight | Heartbeat vs actionable split, event-type rows, recent alerts feed |
| `04-trends.png` | Trends | Lifted near-verbatim from v1, Recharts BarChart, current vs prior delta |

## Visual test plan — Claude Desktop

What automated DOM verification CAN catch:
- Element presence and text content
- Number values match API response
- Sidebar surfaces wired correctly
- Console errors

What automated DOM verification CANNOT catch (this is what humans should
walk through in Claude Desktop):

### 1. Layout integrity at multiple viewport widths
- Resize browser from ~1024px → 1440px → 1920px
- Confirm: sidebar stays 192px (`w-48`); main column doesn't collapse the cards
- Confirm: no horizontal scrollbars on any surface at any width

### 2. Color contrast + dark-mode legibility
- All text against `gray-950 / gray-900 / gray-800` backgrounds is readable
- Green ($) values, red error badges, amber warning badges all distinguishable
- Model color trio (#8b5cf6 purple / #60a5fa blue / #22d3ee cyan) — confirm
  the dots in the header legend match the dots in the History model breakdown
  table

### 3. Interaction states
- Hover row in any table → background changes to `gray-900`
- Click sidebar item → highlight transitions, content panel swaps
- Trends day-range buttons (1d/7d/14d/30d) — confirm selected state shows
  purple border + purple text; unselected is gray
- Failures day-range buttons (24h/7d/30d) — same pattern but gray-only
  (not purple)

### 4. Empty states
- Switch Failures to 24h range when no failures in last 24h — confirm
  "No failures in last 24h" italic gray message renders (don't show a blank box)
- Same for Oversight at 1d range
- Trends with no events: BarChart hidden, "No events in window" message shown

### 5. Header "updated Ns ago" indicator
- Wait 60+ seconds with no WS activity → confirm timestamp turns AMBER
  (`text-amber-400`)
- Click refresh → timestamp resets to "just now" / "Ns ago"

### 6. Real-time WebSocket behavior (hard to script, easy to eyeball)
- Open Claude in another terminal (or wait for an existing session to update)
- Watch History page — totalSessions / totalMessages / totalCost should tick
  up in near real-time (the `aggregatesUpdated` WS frame fires whenever
  chokidar sees a transcript write)
- Watch Failures page — if a tool fails (e.g., `Read` on nonexistent file),
  it should appear at top of Recent Failures within 1-2s (WS `failureEvent`)

### 7. Surfaces NOT yet implemented (should show placeholders)
- Live, Sessions, Subagents → each shows the gray "Surface scaffold —
  implementation pending" message with phase-ref + data-source hint
- This is intentional. Confirm the layout chrome (sidebar, header) still
  renders correctly when no main-panel content is loaded.

## How to launch v2 manually

```bash
cd packages/telemetry
npm run build:v2
RH_TELEMETRY_PORT=7891 RH_TELEMETRY_UI=v2 node server/index.js
# then open http://localhost:7891/
```

Or via the CLI:
```bash
rh-telemetry start --ui v2     # defaults to port 7890 (will clash if already running)
```

## Refresh screenshots

When a surface changes, regenerate its screenshot to keep this gallery
current. From Claude Desktop with Playwright MCP available:
1. Spawn `RH_TELEMETRY_PORT=7891 RH_TELEMETRY_UI=v2 node server/index.js`
   in background
2. `browser_navigate http://localhost:7891/`
3. Click the surface in the sidebar via `browser_evaluate`
4. `browser_take_screenshot` with `filename=packages/telemetry/docs/screenshots/v2/0N-<name>.png`,
   `fullPage=true`
5. Kill the server
