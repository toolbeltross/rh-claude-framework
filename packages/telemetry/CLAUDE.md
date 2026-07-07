# Claude Code Telemetry Dashboard

Real-time monitoring dashboard for Claude Code CLI sessions. Built for **real-time oversight of Claude's decisions** so you can intervene when things go wrong.

*Formerly known as `claude-telemetry` → `rh-claude-code-telemetry` → `rh-telemetry` (standalone, now archived). This package is the canonical live home; the npm package name remains `rh-telemetry`. If you searched for any of those names, you're in the right place.*

> **See also — the oversight system.** This dashboard is the *telemetry half* of a two-part setup; the *enforcement half* is the **oversight system** (its design doc lives in the user's workspace; dual-write is configured via the `OVERSIGHT_LOG_PATH` env var). The two reference each other by design: oversight hooks POST timing to `/api/hook-perf`, the daily config gate probes `rh-oversight health`, and the Trends tab wraps `rh-supervisor-sweep` via `GET /api/trends`. (This pointer is intentionally path-free — the concrete workspace paths live in the user's local notes, per this repo's zero-hardcoded-paths rule.)

## Quick Start

### Global install (recommended for users)
```bash
npm install -g rh-telemetry
rh-telemetry setup       # configures hooks + installs skills
rh-telemetry start       # starts server on :7890 (v1 UI default)
rh-telemetry start --ui v2   # serve the v2 UI instead (see "v2 frontend" below)
```

### Local dev (for contributors)
```bash
npm install
npm run dev          # Vite on :5173, API on :7890
npm run setup-hooks  # Required: enables live tool feed, validation, prompt capture, agents
```

### v2 frontend (opt-in; all 7 surfaces built, Phase 4 cutover pending)
v2 ships in the same tarball as v1, gated by an env flag. v1 is untouched and remains the default. All 7 surfaces (Live, Sessions, Subagents, Oversight, Failures, Trends, History) are implemented as of 2026-06-12; the Oversight surface gets real-time WS push (`oversightEvent` frame) with the 30s poll kept as fallback.
- `RH_TELEMETRY_UI=v2 npm start` (or `rh-telemetry start --ui v2`) → serves `dist-v2/`
- **Persistent default:** `~/.claude/rh-telemetry-config.json` with `{"ui":"v2"}` — read by `server/config.js:readUserConfig()` and consulted after `RH_TELEMETRY_UI` in `server/index.js`. Env var still wins if set; missing / unparseable file is treated as empty (never fatal). Survives SessionStart-hook auto-restart which does not pass the env var.
- `npm run build:v2` → build the v2 bundle
- `npm run client:v2` → Vite dev server for v2 source on `:5174` (proxies API to `:7890`)
- v2 source lives at `src-v2/`, separate Vite config at `vite.config.v2.js`, separate entry `index.v2.html`. v1 paths unchanged.
- Plan: [`PLAN-20260520-frontend-v2.md`](PLAN-20260520-frontend-v2.md). Research in [`docs/research/`](docs/research/).

## Architecture

- **Backend**: Express + WebSocket + chokidar file watchers on port 7890
- **Frontend**: React 19 + Vite + Tailwind CSS v4 + Recharts
- **Data**: Reads `~/.claude.json` and `~/.claude/stats-cache.json` (no database)
- **Real-time**: WebSocket broadcasts file changes and hook events to all connected clients
- **Hooks**: Claude Code hooks POST tool events, prompts, agent activity, and live session status
- **Validation**: PreToolUse hook catches wrong-tool usage (cat→Read, grep→Grep, echo>→Write) before execution (deterministic, no LLM cost)
- **Supervisory Agent**: Layer 3a Stop prompt hook (active) for narrow 3-rule review; Layer 3b Stop agent hook schema-supported but parked (cost decision); rules enforced via CLAUDE.md conventions
- **Failure Store**: Persistent JSONL log (`~/.claude/telemetry-failures.jsonl`) with in-memory cache, query API, and pattern analysis

## Data Flow

```
~/.claude.json ──┐
                 ├─→ chokidar (3s poll) → parser.js → store.js → broadcaster.js → WebSocket → React
stats-cache.json─┘

Claude Code hooks:
  PreToolUse:Bash ──→ tool-validator.js (deterministic) → BLOCK or ALLOW
  PostToolUse     ──→ hook-forwarder.js → POST /api/hooks → store.addToolEvent() → WebSocket → ToolActivity
  PostToolUseFailure──→ hook-forwarder.js → POST /api/hooks → store.addToolEvent() + failureStore.append()
                       → telemetry-failures.jsonl (persistent) → WebSocket → FailureHistory
  Stop            ──→ hook-forwarder.js → POST /api/turn-end → store.recordTurnEnd() → idle detection
                      + Layer 3a prompt hook (active) + Layer 3b agent hook (parked) + appendProgressEntry() (in hook-forwarder.js)
  UserPromptSubmit──→ hook-forwarder.js → POST /api/prompt → store.updatePrompt() → WebSocket → CurrentPrompt
  SubagentStart   ──→ hook-forwarder.js → POST /api/subagent → store.addSubagent() → WebSocket → SubagentTracker
  SubagentStop    ──→ hook-forwarder.js → POST /api/subagent → store.removeSubagent() → WebSocket → SubagentTracker
  SessionEnd      ──→ hook-forwarder.js → POST /api/session-end → store.markSessionEnded() (marks ended; entry lingers until stale prune)
  PermissionRequest─→ hook-forwarder.js → POST /api/permission-request → store.markAwaitingPermission() (cleared by next tool/prompt/turn-end)
  statusLine      ──→ hook-forwarder.js → POST /api/status → store.updateLiveSession() → WebSocket → live tabs
                      (settings.json statusLine.refreshInterval=2000 → re-fires every 2s mid-turn, not just per API response)
                      (rate_limits in payload, when CC sends it, overlays planInfo 5h/7d gauges — fresher than the 60s OAuth poll)

  Every hook-forwarder POST is stamped with `entrypoint` (CLAUDE_CODE_ENTRYPOINT) →
  store keeps it as `_entrypoint` so the UI can distinguish interactive sessions from
  headless runs (scheduled tasks, script-spawned `claude -p`).
  SessionStart    ──→ start-bg.js (auto-start telemetry server)
  PreCompact      ──→ hook-forwarder.js → POST /api/compact → store.recordCompact()
```

## Directory Structure

```
bin/
  rh-telemetry.js   — Unified CLI entry point (setup, start, dev, status, telemetry queries)

server/
  index.js          — Express server, routes, port 7890
  parser.js         — Parses .claude.json & stats-cache.json into dashboard state
  store.js          — In-memory EventEmitter store (sessions, stats, toolEvents, liveSessions, prompts)
  broadcaster.js    — WebSocket server on /ws, broadcasts store events
  watchers.js       — chokidar file watchers (3s polling for Windows/OneDrive)
  hook-receiver.js  — Express router for POST /api/hooks, /api/status, /api/prompt, /api/subagent, GET /api/failures/*
  failure-store.js  — Persistent JSONL failure store with in-memory cache, query engine, pattern analysis

src/
  App.jsx           — Main layout: header, tab bar (overview + live + file sessions), content, footer
  main.jsx          — React entry point
  index.css         — Tailwind theme (dark), custom scrollbar, pulse-dot animation

  hooks/
    useDashboardData.js   — Central state (useReducer + WebSocket): sessions, stats, toolEvents, sessionActivity
    useWebSocket.js       — WebSocket connection with auto-reconnect (3s delay)
    usePictureInPicture.js — Document PiP API with HMR style sync + popup fallback

  components/
    OverviewTab.jsx       — Summary cards + daily activity chart + hourly heatmap + recent sessions table
    SessionTab.jsx        — Session detail layout: context window + model breakdown, plan usage, tabbed subpanel (Agents/Tools/Failures/Details)
    ContextWindow.jsx     — Token fill gauge + breakdown (input/output/cache read/write) + cache hit ratio
    CurrentPrompt.jsx     — Shows current prompt being answered (active/completed state, env-aware fallback)
    SubagentTracker.jsx   — (legacy, no longer imported) Agent console kept on disk for reference
    ToolActivity.jsx      — Live tool event feed with timestamps, status dots, tool tooltips, validation blocks, failure filter toggle
    FailureHistory.jsx    — Persistent failure tracking panel with expandable details, pattern badges, cross-session view
    TurnTracker.jsx       — Per-turn cost, velocity, estimated turns remaining
    TurnCostChart.jsx     — Chart of cost per turn over time
    ModelBreakdown.jsx    — Donut chart: cost per model (explains subagent model selection)
    CurrentSession.jsx    — Model, duration, cost, lines changed (live or file-based)
    PerformanceMetrics.jsx — CLI frame timing: FPS, p50/p95/p99, avg/min/max
    DailyActivity.jsx     — Bar chart: messages/sessions/tools per day
    HourlyHeatmap.jsx     — Hour-of-day intensity heatmap
    MetricCard.jsx        — Reusable label+value card with tooltip support
scripts/
  setup-hooks.js              — Configures all Claude Code hooks in ~/.claude/settings.json
  install-skills.js           — Installs /rh-telemetry and /rh-telemetry-setup Claude Code skills (writes ~/.claude/skills/rh-telemetry/SKILL.md that invokes telemetry-cli.js via project absolute path; self-tests CLI invocation before exiting success)
  hook-forwarder.js           — Cross-platform hook forwarder (reads stdin JSON, POSTs to server)
  start-bg.js                 — Background server starter (auto-starts on session via hooks)
  tool-validator.js            — Layer 1 deterministic bash command checker (blocks cat→Read, grep→Grep, etc.)
  supervisory-agent-prompt.md — Reference prompt for the supervisory agent (user rules, evaluation criteria)
  telemetry-cli.js            — Standalone CLI for inline telemetry stats
  failure-digest.js           — Generates markdown failure summaries (standalone or via `rh-telemetry digest`)

docs/
  user-requirements.md        — Verbatim user messages + extracted requirements
```

Runtime-written artifacts (not in the repo; user-scoped):
```
~/.claude/
  telemetry-failures.jsonl          — Persistent failure store (JSONL)
  telemetry-supervisory-log.md      — Per-turn progress log + failure digests
```

**Optional dual-write:** set the env var `OVERSIGHT_LOG_PATH=<abs path>` to also append every Stop-hook progress entry to a second file (e.g. an external oversight-system log). Best-effort — failures on the secondary target are logged to `hook-debug.log` and never block the primary write. Restart Claude Code after setting for hooks to inherit the var.

## SessionTab Layout

```
Row 1:  ContextWindow (9col) + ModelBreakdownMini (3col) — always visible, most important
Row 1b: TurnHeartbeat (full width) — live tool activity strip for the current turn
Row 2:  Tabbed subpanel — five tabs:
  [Agents]   AgentActivity (full width) — unified table with header stats strip
  [Tools]    ToolActivity (full width, expanded scroll) — live tool event feed
  [Turns]    TurnsTab (full width) — per-turn breakdown with Lollipop/Swimlane/List timelines
  [Failures] FailureHistory (full width, expanded scroll) — persistent failure tracking
  [Details]  TurnTracker + TurnCostChart, PerformanceMetrics, CurrentPrompt, TaskCompletions
```

(PlanUsage gauges render in the global header strip, not inside SessionTab.)

Default tab: Agents (when active agents exist), otherwise Tools. Tab badges: active agent count (cyan), tool event count (gray), turn count (accent), failure count (red).

### Agents Tab (v2) Layout

```
Header strip:  [Agents ⓘ] | [2 active  5 done] | [$2.18  28%  142K] | [1 orphaned  3 fails] | [▾ timeline] | [v2.1.117]
Timeline:      SubagentTimeline (collapsible from header toggle, default collapsed)
Table:         Unified full-width table — columns: status | Agent | Cost | Ctx | Dur | Tools | Prompt/Result
  Active rows:    green left accent, pulsing dot, live cost/context from transcript, prompt text
  Completed rows: gray dot, sorted by cost desc, prompt + result text. Click to expand detail panel.
  Orphaned rows:  red left accent, sorted to bottom
Detail panel:  Side-by-side Prompt | Result (equal height CSS Grid), metadata row below
```

Model shown as 5px colored dot next to agent name (no separate column). Live telemetry for active agents parsed from agent transcript JSONL on each tool event.

## Model Color System

Consistent color language for model families, defined in `src/lib/model-colors.js`:
- **Opus** = purple (#8b5cf6, `text-accent`)
- **Sonnet** = blue (#60a5fa, `text-blue`)
- **Haiku** = cyan (#22d3ee, `text-cyan`)

Legend shown in the header. Used in: AgentActivity (model pills, cost table), ModelBreakdownMini (pie chart), CurrentSession (model stat), DailyActivity (token chart in token mode). Import from `model-colors.js` — do not duplicate hex values.

**Reserve these three colors for actual model attribution.** Non-categorical metrics (counts, totals, dates) use `text-gray-100`. See [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md) §2 for the full color-usage rules.

## Key Data Shapes

### Session object (from parser.js)
```javascript
{
  sessionId, projectPath, projectName,  // identifiers
  cost, duration, durationMs,           // summary
  primaryModel, primaryModelId,         // model info
  models: [{ id, name, inputTokens, outputTokens, cacheRead, cacheWrite, cost }],
  tokens: { input, output, cacheRead, cacheWrite, total },
  linesAdded, linesRemoved,             // code changes
  fps, performance,                     // CLI rendering metrics
  apiDuration, toolDuration             // timing
}
```

### Store state (from store.js → WebSocket → useDashboardData)
```javascript
{
  currentSession,     // Top session (highest cost)
  sessions: [],       // All project sessions sorted by cost desc
  stats,              // Aggregated stats from stats-cache.json
  toolEvents: [],     // Last 200 tool events (from hooks)
  liveSessions: {},   // Map: sessionId → live status data (from hooks)
  sessionActivity: {},// Map: sessionId → 'processing' | 'idle' (event-driven)
  timestamp           // Last update
}
```

### Live session properties (on liveSessions[id])
```javascript
{
  session_id, model, cost, context_window, workspace,
  _lastSeen,              // Timestamp of last event (pruned after 2 hours of inactivity)
  _toolCount, _lastTool,  // Tool event counters
  _turnCount, _turnHistory, _tokensPerTurn, _estimatedTurnsRemaining,
  _costDelta, _lastTurnCostDelta,
  _contextHistory, _contextWarning,
  _modelSwitches, _currentModel,
  _compactEvents, _lastCompactAt,
  _activeSubagents: { [agentId]: { type, description, model, startedAt, _toolCount, _lastTool,
                       prompt, agentTranscriptPath,
                       _liveCost, _liveContextPct, _liveContextTokens, _liveModel, _liveTurns } },
  _subagentHistory: [{ agentId, type, description, model, modelId, startedAt, endedAt, durationMs,
                       lastMessage, transcriptPath, toolCount, lastTool, tokens, cost, turns,
                       prompt, permissionMode }],
  _currentPrompt,         // Current prompt text (from UserPromptSubmit hook)
  _promptHistory: [{ text, ts }],  // Last 10 prompts
}
```

## Tab System

- **Overview tab**: Always visible. Shows aggregate stats, charts, and recent sessions table.
- **Trends tab** (P3-2): Cross-session oversight-event aggregations from `rh-supervisor-sweep`. Day-range selector (1/7/14/30), summary cards with prior-window deltas, daily-cadence BarChart, event-type table, top missing oversight elements, top subagent-failure patterns, top sessions by event count. Component: `src/components/TrendsTab.jsx`. Data: `GET /api/trends?days=N` (`server/trends-router.js`) which wraps the oversight package's `rh-supervisor-sweep.js` aggregation via `createRequire` cross-package import.
- **Live session tabs**: From Claude Code hooks. Green pulsing dot = processing (tool events flowing), blue solid dot = idle (turn ended). Pruned after 2 hours of no events.
- **File session tabs** (gray dot): From `.claude.json` parser. Auto-populated on load. Also openable by clicking rows in the Recent Sessions table.

The `'trends'` value is whitelisted in the App.jsx unknown-tab guard (line ~297) — without that whitelist, `setActiveTab('trends')` is auto-reset to `'overview'` on the next render.

## Idle Detection

Event-driven (not timer-based):
- `TOOL_EVENT` with a session ID → session marked `'processing'` (green pulsing dot)
- `TURN_END` → session marked `'idle'` (blue solid dot)
- `PROMPT_UPDATE` → session marked `'processing'` (user submitted new prompt)
- Fallback: cost-change tracking for sessions without event hooks (60s threshold)
- **Passive events** (`ConfigChange`, `TaskCompleted`) do not update `_lastSeen` and do not prevent session pruning. Only active events (tool use, statusLine, prompts, subagent start/stop, turn-end, compact) keep sessions alive.

## Supervisory Agent

**Layer 1 — Deterministic** (`scripts/tool-validator.js`, PreToolUse:Bash command hook):
- Blocks: `cat`→Read, `head`/`tail`→Read, `grep`/`rg`→Grep, `find`→Glob, `sed`→Edit, `awk`→Edit, `echo`/`printf` with `>`→Write
- Allows: git, npm, node, docker, and all legitimate bash commands
- Exit 2 = block, exit 0 = allow. Timeout: 5s.

**Layer 2 — Removed** (was PreToolUse:Bash prompt hook):
- Removed: 95% redundant with Layer 1. Layer 1 expanded to cover echo/printf redirect.
- Saved $1.68-3.72 per session + 2-5s latency per Bash command.

**Layer 3a — Re-enabled 2026-04-19** (narrow 3-rule Stop prompt hook):
- Was Removed 2026-03 (5-rule variant: $6.30-13.95/session + 3-15s latency) — conventions-only enforcement proved insufficient when a private-domain subagent-result misattribution reached the user unverified.
- Re-enabled with a narrower 3-rule scope targeting that failure class: (1) verify-before-declaring-done, (2) subagent-cross-check, (3) no-unverified-extrapolation. Roughly 30-40% of the 5-rule cost.
- Prompt body inlined in `scripts/setup-hooks.js`. Reference doc in `scripts/supervisory-agent-prompt.md`.
- Returns `{"ok": false, "reason": "..."}` to force Claude to address the violation.

**Layer 3b — Schema supported, not wired** (Stop agent hook):
- Discovered 2026-04-19: Claude Code settings.json validator accepts `type: "agent"` hooks today. Schema requires a `prompt` field (not `agent: "name"`). Default model: Haiku.
- NOT wired because firing both prompt + agent on every Stop doubles the per-turn cost, contradicting the cost-conscious Layer 3a decision.
- Can be added as a third hook entry when deeper multi-turn review is warranted (e.g., gated via `if` clause on specific turn classes). See `scripts/supervisory-agent-prompt.md` for rationale.

## UI Conventions

> Full visual contract lives in [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md). The section below summarizes the most-touched conventions for quick reference; the styleguide is authoritative when they disagree.

### Tooltips
All interactive elements use native `title` attributes — no custom tooltip components. Tooltips are on:
- Panel titles, MetricCard labels, token stats, performance metrics
- Tool names in ToolActivity (e.g. Read: "Reads file contents")
- Status dots (green=success, red=fail, amber=blocked by validation)
- Model Breakdown header, table headers in Recent Sessions
- Every badge, every table header, every status indicator

### Progressive Disclosure (three levels)
1. **Inline summary** — table row or card shows the scan-level view (status, type, one-line text)
2. **`title` hover** — full text without layout disruption (native browser tooltip)
3. **Click-to-expand** — detail panel appears below the clicked row/card with full content

Click-to-expand is for detail panels. Hover is for tooltips only. Never use hover-to-expand.

### Badges
Rounded-full pill style (`px-1.5 py-0 rounded-full border text-[10px]`). Always a colored trio: `bg-{color}/10 text-{color} border-{color}/40`. Used for inline status: fails, orphaned, idle, compacted, transcript lost, validation blocks, permission mode.

### Row-Level Status (tables)
Left-edge accent via `box-shadow: inset 3px 0 0 {color}`:
- **Green** = active / processing
- **Red** = orphaned / error
- No accent = completed / normal

### Section Headers
`text-xs font-semibold uppercase tracking-wider text-gray-400` + InfoIcon (ⓘ) click-to-open with rich explanation and color legends (Legend component).

### Long Text in Table Cells
Single-line, no wrapping: `whitespace-nowrap overflow-hidden`. Text extends to the cell edge and clips cleanly — no ellipsis. Full text on `title` hover, full content in click-to-expand detail panel. This keeps row heights consistent while the hover + expand provide full access.

### Side-by-Side Panels (equal height)
When showing two panels side by side (e.g. Prompt | Result in expanded agent detail), use CSS Grid with `grid-template-columns: 1fr 1fr`. Wrap each label+panel in a flex-column cell (`display: flex; flex-direction: column`) with the panel set to `flex: 1` so both panels stretch to the height of the tallest. Never set independent `max-height` on each panel — that breaks equal height. If scrolling is needed, set a shared `max-height` on the grid container or the flex cell.

### Empty States
Centered gray text: "No {thing} yet" (e.g. "No agent events yet", "No failures recorded").

## Hooks Format (Important)

Claude Code hooks in `~/.claude/settings.json` use **matcher + hooks array** format:

```json
{
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "..." }]
    }
  ]
}
```

**Not** flat command objects. See `scripts/setup-hooks.js` for the full configuration.

Hook types: `command` (run a script), `prompt` (single-turn LLM check), `agent` (multi-turn LLM agent).

## API Endpoints

```
POST /api/hooks      — Tool events (from PostToolUse/PostToolUseFailure hooks)
POST /api/status     — Live session data (from statusLine hook)
POST /api/turn-end   — Turn boundaries (from Stop hook)
POST /api/compact    — Compaction events (from PreCompact hook)
POST /api/subagent   — Agent start/stop (from SubagentStart/SubagentStop hooks)
POST /api/prompt     — Current prompt text (from UserPromptSubmit hook)
GET  /api/snapshot   — Full state snapshot (used by CLI)
GET  /api/aggregates — Live transcript aggregates (stats-cache.json replacement; v2 History)
GET  /api/sessions   — Per-session detail list from the aggregator (v2 Sessions surface)
GET  /api/subagents  — Cross-session subagent list + per-type leaderboard (v2 Subagents surface)
GET  /api/oversight/events?days=N — Oversight-events feed via server/oversight-bridge.js (v2 Oversight surface)
GET  /api/failures          — Query failure history (session, tool, time range)
GET  /api/failures/patterns — Failure frequency analysis (by tool, by error, by session)
GET  /api/failures/digest   — Failure summary for time period (default: 24h)
GET  /api/trends?days=N     — Cross-session/project trend aggregation (P3-2). Wraps rh-supervisor-sweep via createRequire. Default 7, capped at 90. Query overrides: events=<path>, supervisoryLog=<path> (for tests).
WS   /ws             — WebSocket for real-time updates (failureEvent, aggregatesUpdated, subagentsAggUpdated, oversightEvent, …)
```

## CLI — `rh-telemetry` (bin/rh-telemetry.js)

Unified entry point. Installed globally via `npm install -g rh-telemetry`.

```
rh-telemetry setup        — run setup-hooks.js + install-skills.js
rh-telemetry start        — start server (foreground)
rh-telemetry start --bg   — start server (background via start-bg.js)
rh-telemetry dev          — start server + vite dev (requires devDependencies)
rh-telemetry status       — hit /api/health to check if running
```

Telemetry query subcommands (passthrough to `scripts/telemetry-cli.js`):

```
rh-telemetry              — session summary (default)
rh-telemetry digest       — failure digest (last 24h, stdout)
rh-telemetry digest --append — append digest to ~/.claude/telemetry-supervisory-log.md
rh-telemetry sessions     — all sessions sorted by cost
rh-telemetry costs        — cost breakdown by model
rh-telemetry context      — context window details
rh-telemetry live         — ensure server running + show live session
rh-telemetry activity     — daily activity (last 14 days)
rh-telemetry session <n>  — details for project <n>
```

### CLI Output Example

```
=== projectname (live) ===
Context: 24% | 242K/1.0M | ~12 turns left    ← most important (live: real reported window)
Agents: 2 active (Explore, Plan) | 3 completed | $1.24 (28.9%)
  Explore        Haiku     $0.02    8.0K  1m30s
  Plan           Sonnet    $0.18   22.0K  3m10s
  general        Opus      $1.04  145.0K  12m05s
Tools: 47 (last: Read)
Turn: 8 | Velocity: 11K/turn
$4.28 | Opus | 15m                             ← least important
```

## Theme

Dark theme with monospace fonts. Token source of truth: `@theme` block in [`src/index.css`](src/index.css) (theme colors) + [`src/lib/model-colors.js`](src/lib/model-colors.js) (model trio) + [`src/lib/style-tokens.js`](src/lib/style-tokens.js) (tool/agent identity).

Full color-usage rules, type scale, badge/dot/row conventions, and number/date formatting → see [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md).

## Project Rules (IMPORTANT)

- **ADDITIVE ONLY**: Never remove existing functionality. Add to it. Improve it. Don't replace.
- **Both approaches**: If something works via hooks AND via file parsing, keep BOTH.
- **All environments**: User runs Claude in CLI, VS Code, Desktop, WSL, iOS, web, PowerShell, bash, coworker sessions.
- **Real-time first**: Everything should update live via WebSocket. File-based data is fallback only.
- **Legends & tooltips on everything**: Every dot, color, icon, label needs a tooltip.

## Testing

Four-tier test harness. Plain Node `assert` scripts — no test framework, no new deps. Plan and full rationale in `docs/test-harness-plan.md`.

| Tier | Scope | Speed | Entry | Pre-commit? |
|---|---|---|---|---|
| **Unit** | Pure functions, store state, classifier, cost-rates, failure-alerter, wrapper source | <2 s | `npm run test:unit` | ✅ yes |
| **Integration** | Real Express + WS + chokidar in spawned child with tmp HOME, fires real HTTP/WS | <25 s | `npm run test:integration` | ❌ no |
| **Browser** | Playwright drives built dashboard against seeded server, asserts DOM behavior | <30 s | `npm run test:browser` | ❌ no |
| **Visual parity** | Pixel diff dev-vs-prod build screenshots | ~30 s | `npm run test:visual` | ❌ no |

`npm test` runs unit + integration. `npm run test:all` runs unit + integration + browser. Browser tier requires `npm run build` first (and `npx playwright install chromium` once).

### Test conventions

- Tests live in `tests/{unit,integration,browser}/*.test.js`. Each file is run as its own child process by `tests/run.js`.
- Shared helpers in `tests/helpers/`: `test-harness.js` (`test()`, `summary()`, `afterAll()`), `tmp.js` (mandatory for any FS state), `ports.js` (ephemeral free port), `server.js` (spawn server with `HOME` override for full isolation), `ws-client.js` (WebSocket recorder + `waitFor`).
- **Isolation rule**: tests MUST use the helpers. Never write to `~/.claude/`, never bind to `:7890`. The integration harness spawns a server with `HOME=<tmpdir>`, which makes `server/config.js`'s `~/.claude/*` paths auto-redirect into the tmp area.
- Browser tests can push synthetic store state via the gated `/api/_test/state` endpoint (only mounted when `RH_TELEMETRY_TEST_MODE=1`).
- Test fixtures live in `tests/fixtures/`: settings JSON variants, sample transcript JSONL, sample hook payloads.

### Pre-commit hook

`.githooks/pre-commit` runs `npm run test:unit` on every commit. Installed by `rh-telemetry setup` (or run `rh-telemetry install-git-hooks` directly). Bypass with `git commit --no-verify` for emergencies. To disable entirely: `git config --unset core.hooksPath`.

### Adding a new test

1. Pick the right tier (unit if pure logic, integration if it needs a running server, browser if it needs DOM).
2. Create `tests/<tier>/<name>.test.js` following the pattern of an existing file in that tier.
3. Use `import { test, summary } from '../helpers/test-harness.js'`. End with `summary()` (NOT `await summary()` — it self-runs an IIFE).
4. For tests that need files: `await withTmp(async (tmpDir) => { ... }, 'label')`.
5. For integration tests that need a server: `await startTestServer({ tmpHome })` after seeding the tmp `~/.claude/settings.json`.
6. Run `npm run test:unit` (or `:integration`/`:browser`) to verify.

## Installation Modes

- **Global install**: `npm install -g rh-telemetry` → use `rh-telemetry` commands
- **Local dev**: `git clone` + `npm install` → use `npm run` scripts
- Generated `/rh-telemetry` and `/rh-telemetry-setup` SKILL.md files include the project's absolute path resolved at install time (by design — needed so the skill can find the project wherever it was installed). No copy, no symlink: SKILL.md invokes `<PROJECT_ROOT>/scripts/telemetry-cli.js` directly. This pattern survives directory renames as long as `node scripts/install-skills.js` is re-run from the new location — see `DECISIONS.md` 2026-05-06 entry for why.

## Known Issues / TODO

- Context window: **live** sessions (CLI `context`/`summary`) read the real reported window from the statusLine payload (`context_window.context_window_size` + `used_percentage`) as of PR #93 — a 1M Opus session shows `/1.0M`, not the default. **File-based** sessions (parser.js path) still default to 200K; 1M detected only via model display name containing "(1M context)". Deriving the file-based window from the model id is an open follow-up.
- Build warning: bundle >500KB (Recharts is large) — could code-split
- Supervisory agent Stop hook (Layer 3b): schema supported, not wired — parked pending cost/benefit review (see `scripts/supervisory-agent-prompt.md:50`)
- Not yet published to npm — `npm publish` when ready