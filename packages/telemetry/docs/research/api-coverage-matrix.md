# Phase 0.2 + 0.3 — API Coverage Matrix + Live Aggregation Feasibility

> Research output from subagent dispatch, 2026-05-20. Source registry at bottom.

## Section 1 — API Coverage Matrix

### 1.1 HTTP Endpoint Inventory

| Endpoint | Source file | Shape summary | v1 consumer (component) | Gap |
|---|---|---|---|---|
| `GET /api/snapshot` | `server/index.js:30` | `{currentSession, sessions[], stats, toolEvents[], liveSessions{}, ...}` | **CLI only** (`scripts/telemetry-cli.js`) — React gets snapshot via WS on connect | None |
| `GET /api/health` | `server/index.js:34` | `{status, uptime}` | NONE in React | CLI `rh-telemetry status` only |
| `POST /api/refresh` | `server/index.js:38` | `{status, ...result}` | `App.jsx:334` (manual refresh) | OK |
| `POST /api/_test/state` | `server/index.js:47` | Test fixture push | Browser tests only | OK |
| `POST /api/hooks` | `hook-receiver.js:9` | Tool events → `store.addToolEvent` + failure persistence | Producer-only (Claude hooks) | n/a |
| `POST /api/status` | `hook-receiver.js:44` | Live statusLine push | Producer-only | n/a |
| `POST /api/turn-end` | `hook-receiver.js:67` | Turn boundary | Producer-only | n/a |
| `POST /api/compact` | `hook-receiver.js:83` | PreCompact event | Producer-only | n/a |
| `POST /api/subagent` | `hook-receiver.js:99` | Agent start/stop | Producer-only | n/a |
| `POST /api/prompt` | `hook-receiver.js:123` | UserPromptSubmit | Producer-only | n/a |
| `POST /api/config-change` | `hook-receiver.js:140` | ConfigChange | Producer-only | n/a |
| `POST /api/task-completed` | `hook-receiver.js:156` | TaskCompleted | Producer-only | n/a |
| `GET /api/failures` | `hook-receiver.js:174` | Filtered failure JSONL | NONE — React reads `failureEvents[]` from WS (recent only) | **GAP: failure query API exists, no UI surface** |
| `GET /api/failures/patterns` | `hook-receiver.js:191` | `{byTool, byError, bySession, total}` | `useDashboardData.js:314` → OverviewTab "Total Failures" + AgentActivity header | OK |
| `GET /api/failures/digest` | `hook-receiver.js:201` | 24h failure summary | NONE — CLI only | **GAP: no UI surface for digest** |
| `GET /api/failures/alert-threshold` | `hook-receiver.js:212` | `{enabled, threshold, ...}` | NONE | **GAP: threshold inspectable/configurable from CLI only** |
| `GET /api/failures/top-cost` | `hook-receiver.js:234` | Top-N cost-weighted failures | NONE | **GAP: D4 cost-ranked failure intelligence never surfaced** |
| `GET /api/hook-health` | `hook-receiver.js:224` | `{errorLines, p95ParseLatencyMs, ...}` | `FailureHistory.jsx:55` | OK |
| `POST /api/hook-perf` | `hook-receiver.js:248` | Latency record ingest | Producer-only | n/a |
| `GET /api/hook-perf` | `hook-receiver.js:262` | Per-hook latency stats | NONE | **GAP: hook latency ingested + computed, never displayed** |
| `GET /api/hook-perf/slowest` | `hook-receiver.js:273` | Top-N slowest hook invocations | NONE | **GAP: never displayed** |
| `GET /api/hook-perf/regressions` | `hook-receiver.js:285` | Baseline vs current p95 | NONE | **GAP: regression alerting computed, never surfaced** |
| `POST /api/debug-hooks` | `hook-receiver.js:297` | Dev-only logging | Dev only | n/a |
| `GET /api/trends?days=N` | `trends-router.js:45` | `{days, current, prior, sources}` (sweep aggregates) | `TrendsTab.jsx:39` | OK |

### 1.2 WebSocket Event Inventory

| WS event type | Broadcast on | React reducer case | Consumer component | Gap |
|---|---|---|---|---|
| `snapshot` | Connect | `SNAPSHOT` | App-wide | OK |
| `update` | `store.on('update')` | `UPDATE` | App-wide | OK |
| `liveSession` | `store.on('liveSession')` | `LIVE_SESSION` | SessionTab, MicroDashboard | OK |
| `toolEvent` | `store.on('toolEvent')` | `TOOL_EVENT` | ToolActivity, TurnHeartbeat | OK |
| `turnEnd` | `store.on('turnEnd')` | `TURN_END` | TurnTracker, TurnsTab | OK |
| `compactEvent` | `store.on('compactEvent')` | `COMPACT_EVENT` | SessionTab badges | OK |
| `subagentUpdate` | `store.on('subagentUpdate')` | `SUBAGENT_UPDATE` | AgentActivity, SubagentTimeline | OK |
| `promptUpdate` | `store.on('promptUpdate')` | `PROMPT_UPDATE` | CurrentPrompt | OK |
| `failureEvent` | `store.on('failureEvent')` | `FAILURE_EVENT` | FailureHistory | OK |
| `failureAlert` | `store.on('failureAlert')` | `FAILURE_ALERT` | FailureHistory banner | OK |
| `planInfo` | `store.on('planInfo')` | `PLAN_INFO` | PlanUsage | OK |
| `statusLineState` | `store.on('statusLineState')` | `STATUS_LINE_STATE` | StatusLineBanner | OK |
| `configChange` | `store.on('configChange')` | `CONFIG_CHANGE` | (state only — no UI) | **GAP: event flows to state, no panel renders it** |
| `taskCompleted` | `store.on('taskCompleted')` | `TASK_COMPLETED` | TaskCompletions panel | OK |
| `forcedContinuation` | `store.on('forcedContinuation')` | `FORCED_CONTINUATION` | SessionTab red banner | OK |
| `hookPerfEvent` | `store.on('hookPerfEvent')` | **NO CASE** in reducer | **NONE** | **GAP: broadcast but never consumed** |

### 1.3 Fields rendered in v1 that depend on `stats-cache.json` (the dark zone if cache removed)

All flow through `parser.js:parseStatsCache` → `store.stats` → WS `snapshot`/`update`. Cache last modified 2026-04-07.

| UI surface | Field consumed | Source |
|---|---|---|
| Overview "Total Sessions" card | `stats.totalSessions` | `OverviewTab.jsx:13` |
| Overview "Total Messages" card | `stats.totalMessages` | `OverviewTab.jsx:14` |
| Overview "First Session" card | `stats.firstSessionDate` | `OverviewTab.jsx:16` |
| Header session count badge | `stats.totalSessions` | `App.jsx:671` |
| Daily Activity bar chart | `stats.dailyActivity[]` (date, messageCount, sessionCount, toolCallCount) | `DailyActivity.jsx:104,112` |
| Daily Activity (token mode) | `stats.dailyModelTokens[]` (date, tokensByModel) | `DailyActivity.jsx:38,55` |
| Hourly Heatmap | `stats.hourCounts` (24-entry map) | `HourlyHeatmap.jsx:4,13` |
| Model breakdown reference data | `stats.modelUsage` | Parser exposes; not currently rendered |

**Fields NOT dependent on cache** (would survive): `sessions[]` (from `.claude.json`), `currentSession`, `liveSessions`, all WS event streams, all `/api/failures/*` and `/api/hook-perf/*` (own JSONL stores), trends (oversight-events.jsonl).

### 1.4 Fields available in API but not displayed anywhere

- `/api/failures` (full query) — historical failure browse/filter
- `/api/failures/digest` — 24h summary panel
- `/api/failures/alert-threshold` — threshold inspection/config UI
- `/api/failures/top-cost` — cost-weighted top failures (D4)
- `/api/hook-perf` — per-hook latency stats panel
- `/api/hook-perf/slowest` — top slow hook invocations
- `/api/hook-perf/regressions` — p95 regression alerting
- WS `hookPerfEvent` — broadcast but reducer has no case
- WS `configChange` — flows through reducer but no rendering component
- `stats.totalSpeculationTimeSavedMs` — present in cache, never read by parser
- `stats.longestSession` — parsed but never rendered

## Section 2 — Live-Aggregation Feasibility

### 2.1 Per-transcript schema (verified empirically on sample `2aca446f-05ac-4b7b-9725-3382142fd8be.jsonl`)

JSONL with mixed record types.

**Sample verification token (literal last line, abbreviated tail):**
> `...sourceToolAssistantUUID":"4df9741f-f99f-47f4-bc8a-abeb5ab6ac83","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\rossb","sessionId":"2aca446f-05ac-4b7b-9725-3382142fd8be","version":"2.1.129","gitBranch":"HEAD"}` — lines 1–96 of 96 read.

**Per-line schema (10 distinct `type` values observed):** `user`, `assistant`, `system`, `attachment`, `agent-setting`, `queue-operation`, `last-prompt`, `progress`, `ai-title`, `file-history-snapshot`.

**Aggregatable fields per assistant/user line:**
- `timestamp` (ISO8601) — for firstTs/lastTs
- `sessionId`
- `message.model` (e.g., `claude-sonnet-4-6`)
- `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`
- `type` (role counts)
- `cwd`, `gitBranch`, `version`, `entrypoint`
- `parentUuid`, `uuid`, `promptId` (for turn reconstruction)

**Notable absence:** no `cost` field in transcripts (sample showed `cost: 0`). Cost must be derived from `tokens × model rate` (v1's `cost-rates.js` already does this).

### 2.2 Measured walk cost

- **File count:** 729 transcripts (+ 1 subagent extra = 730 returned by `find`)
- **Total lines across all JSONLs:** 13,687
- **Disk size:** 416 MB
- **`find ... -exec wc -l` walltime:** 0.836s real, 0.246s user (3 runs ≈ same)
- **Per-file parse cost (Node, sample 20):** 5.1 MB / 1,566 lines / 54 ms ⇒ ~2.7 ms/file avg
- **Full-walk parse extrapolation:** 730 × 2.7 ms ≈ **1.97 s** (single-threaded Node, including JSON.parse on every line)

### 2.3 Aggregator footprint estimate

Per-session aggregate object (sessionId, projectPath, firstTs, lastTs, models[], tokens{4 counters}, cost, role counts, turnCount) ≈ ~400 bytes.

- **In-memory store for 729 sessions:** ~300 KB — trivial.
- **Daily/hourly rollup** (28-day window × 24 hours × ~10 models) ≈ another 50 KB.
- **CPU on cold startup:** ~2s (one-time, blocking — acceptable for server boot).
- **CPU on incremental update** (single new line appended via `chokidar` watch): sub-millisecond JSON.parse + counter increments.

### 2.4 Recommendation: Option (a) — full in-memory aggregator built on server startup + chokidar incremental updates

**Rationale:**
1. **Cost is negligible:** 2 s startup, 300 KB RAM, sub-ms per incremental event. No scenario where (b) on-demand file cache wins — parse is cheap enough to fit in the boot path and benefits from being always-warm for the WS-push model.
2. **Architectural fit:** v1 already uses `chokidar` (3s polling on Windows/OneDrive per CLAUDE.md) for `~/.claude.json` and `stats-cache.json`. Extending to watch `~/.claude/projects/**/*.jsonl` with the same polling cadence is a one-package addition. Append-only JSONL plays well with `tail`-style incremental parsing (seek to last byte-offset, parse new lines).
3. **Replaces the stale cache cleanly:** `stats.totalSessions`, `totalMessages`, `dailyActivity`, `hourCounts`, `dailyModelTokens`, `firstSessionDate`, `modelUsage` are all recomputable from the JSONL corpus. The Overview headline cards stop being stuck at "173 sessions".
4. **Bonus:** existing `parseAllSessions` from `.claude.json` becomes redundant for some fields — JSONLs are authoritative for token/cost/timestamp counts. Per ADDITIVE ONLY rule, keep both; make JSONL the primary source.
5. **Live coupling already exists:** the `chokidar` watcher would also detect new transcript lines for the *current* session, enabling true real-time turn/cost updates without depending solely on the hook stream — useful redundancy.

**Implementation sketch:** new `server/transcript-aggregator.js` with `loadAll()` (boot), `tail(path)` (incremental), exposes the same `{totalSessions, totalMessages, dailyActivity, hourCounts, dailyModelTokens, firstSessionDate, modelUsage}` shape consumed by `parseStatsCache`. Wire into `store.stats` so existing components require **zero** code changes. Optionally retire `parseStatsCache` once parity is verified (per `rh-replacement-assessment.md` carve-out: stats-cache is a stale fact, not a deliberate decision worth preserving).

**Pitfall to address:** OneDrive sync was disabled in 2026-05 — verify still off. The `~/.claude/projects/` path is at `C:/Users/rossb/.claude/`, NOT under OneDrive, so should be safe — confirmed by path.

## Source registry

| File | Lines read | Verification |
|---|---|---|
| `packages/telemetry/server/index.js` | Full 91/91 | OK |
| `packages/telemetry/server/hook-receiver.js` | Full 301/301 | OK |
| `packages/telemetry/server/broadcaster.js` | Full 175/175 | OK |
| `packages/telemetry/server/trends-router.js` | Full 77/77 | OK |
| `packages/telemetry/server/parser.js` | Full 175/175 | OK |
| `packages/telemetry/src/components/OverviewTab.jsx` | Head 50 + tail 80 (full coverage, small file) | OK |
| Sample transcript `~/.claude/projects/C--Users-rossb/2aca446f-...jsonl` | Full 96/96 | Token recorded above |
| `src/hooks/useDashboardData.js` + 28 components | Partial / inferred via grep | Disclosed — see subagent return |

**Cross-references:** 24 endpoints found, 24 audited. 16 WS event types found, 16 audited (1 orphan: `hookPerfEvent` has no reducer case).
**Subagent telemetry:** ~50% context window used, 0 compactions.
