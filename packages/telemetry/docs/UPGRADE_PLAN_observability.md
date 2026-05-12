# Upgrade Plan — Agents & Failures Tab Observability

**Created:** 2026-04-19
**Author:** live-diagnostic walkthrough
**Absolute path:** `C:\Users\user\OneDrive\Workspace\toolbeltross\toolbeltross-public\rh-telemetry\docs\UPGRADE_PLAN_observability.md`

## Motivation

The dashboard is the user's real-time oversight surface: *see what Claude is doing, catch failures and config issues, verify the oversight system (Layer 1 bash validator + Layer 3a supervisory prompt + CLAUDE.md rules) is actually correcting behavior.* Today it underdelivers on all three:

1. **Subagents return after compaction / parent-interrupt but look like they're still running.** Confirmed live: session `d6c30d15` has a `facilitator` stuck "active" for 2h 40m because `SubagentStop` never fired; two other subagents from the same parallel `Task()` batch are lost entirely (no active, no history). Nothing on the Agents tab flags staleness. Nothing on the Failures tab records the orphaning.

2. **The oversight system's own signals aren't on the dashboard.** Layer 3a supervisory prompt's `{"ok": false, "reason": "..."}` responses never hit the server — they go from hook stdin to Claude stdin and vanish. Same for `PreToolUse:Write`, `PreToolUse:Agent`, and `PostToolUse:Agent` user-level hooks. You can't see whether oversight ran, whether it fired, or whether Claude responded to it.

3. **Configuration and task signals land in the store but never render.** `ConfigChange` and `TaskCompleted` events populate `_configChanges` / `_completedTasks` on the live session; no UI reads either. PreCompact populates `_compactEvents` but the Agents/Failures tabs don't correlate against it.

4. **Agents tab has no parent-child view, no failure tally per agent, no transcript-parse status, no "this agent's Bash calls got blocked 4 times" surface.** Failures tab has no error clustering, no prompt-that-triggered-it linkage, no retry tracking, no cost-of-failure.

## Scope

**In scope**
- `server/store.js`, `server/hook-receiver.js`, `server/failure-store.js`, `server/config.js`
- `scripts/hook-forwarder.js` (new `stop-decision`, `oversight` modes)
- `src/components/AgentActivity.jsx`, `src/components/FailureHistory.jsx`
- New components: `SubagentTimeline.jsx`, `OversightPanel.jsx`, `ConfigChangeRow.jsx`
- Hook config changes in `scripts/setup-hooks.js` to capture Stop-hook decision output
- Test fixtures + unit/integration tests per existing harness conventions

**Out of scope (explicitly)**
- Reworking the failure JSONL schema (additive fields only; backwards-compatible)
- Redesigning the tab structure itself (Agents / Tools / Failures / Details)
- Publishing to npm (tracked separately in `PLAN-distribution-readiness.md`)
- Any change to `hook-forwarder.js` hook types that would break prior-release configs

## Principles

- **Additive only** — CLAUDE.md project rule. No existing functionality removed.
- **Backwards compat** — old failure JSONL rows without new fields must still render.
- **Real-time first** — every new signal broadcasts via WebSocket.
- **Test on seam** — each user-visible surface gets a browser tier test (per `work-verification.md`).
- **No new dependencies** — reuse existing Express / React / Recharts / chokidar stack.

---

## Phase A — Close the orphan-subagent blind spot (highest impact, smallest change)

Goal: a subagent that never emits `SubagentStop` surfaces on both tabs within ~2 min.

### A1 — Stale-active detection (client-side, zero server change) — 30 min
- [ ] In `AgentActivity.jsx`, compute `staleMs = now - agent.startedAt - (agent._lastToolAt || startedAt)` per `ActiveAgentRow`
- [ ] Thresholds: `> 120s since last tool event` = amber "idle?"; `> 600s` = red "likely orphaned"
- [ ] Render badge next to the existing elapsed timer; tooltip explains: "No SubagentStop received for Nm — agent may be orphaned by parent interrupt, compaction, or dropped hook"
- [ ] `agent._lastToolAt` must be stamped in `store.addToolEvent` (currently we stamp `_lastTool` but not `_lastToolAt`) — one-line add

**Verification**
- [ ] Open dashboard; manually confirm the stuck `facilitator a4dfff3e74af54934` renders red "likely orphaned"
- [ ] Browser test: seed `/api/_test/state` with an active agent 15 min old → assert red badge present

### A2 — Sweep orphans into history on a periodic timer — 45 min
- [ ] `server/store.js`: new `sweepOrphanedSubagents(maxIdleMs)` — for every live session, move any `_activeSubagents[*]` whose `_lastToolAt || startedAt` is older than `maxIdleMs` into `_subagentHistory` with `status: 'orphaned'`, `endedAt: null`, `durationMs: null`
- [ ] New config constant `SUBAGENT_ORPHAN_MS = 10 * 60 * 1000` in `server/config.js` (10 min default; overridable via env)
- [ ] Call the sweep from the existing `pruneStale` timer (same interval)
- [ ] Emit `subagentUpdate` so Agents tab repaints

**Verification**
- [ ] Unit test: seed a live session with an old active subagent → call sweep → assert moved to history with `status: 'orphaned'`
- [ ] Confirm WebSocket `subagentUpdate` event reaches the client in integration test

### A3 — Orphaned subagents become a first-class failure — 30 min
- [ ] In the sweep, for each orphaned agent: `failureStore.append({ toolName: 'Agent', eventType: 'subagent_orphaned', error: 'No SubagentStop received within N min (may be compaction, parent interrupt, or dropped hook)', sessionId, toolInput: { agent_id, agent_type, description, startedAt, lastTool: agent._lastTool }, durationMs: null })`
- [ ] `FailureHistory.jsx`: add a new dot color (purple `bg-accent`) + label "orphaned agent"; legend entry
- [ ] `TOOL_COLORS`: `Agent` already mapped to `text-accent`, so the tool column already renders correctly
- [ ] Expandable detail shows the agent metadata so the user can see which subagent was lost

**Verification**
- [ ] Integration test: orphaned sweep emits a `failureEvent` over WebSocket
- [ ] Browser test: failure row with `eventType=subagent_orphaned` renders purple dot + "orphaned agent" label

### A4 — Compaction crossover marker — 30 min
- [ ] `server/store.js` `recordCompact`: iterate live session's `_activeSubagents`; stamp `_spannedCompactAt = [...existing, Date.now()]` on each
- [ ] `AgentActivity.jsx` `ActiveAgentRow`: if `_spannedCompactAt?.length > 0`, render an amber "↻ compacted Nx" chip next to the type label; tooltip lists timestamps
- [ ] Same chip on `CompletedAgentDetail` when the history entry has `_spannedCompactAt`

**Verification**
- [ ] Unit test: seed active subagents, call `recordCompact`, assert `_spannedCompactAt` stamped on each
- [ ] Browser test: agent with `_spannedCompactAt` renders the amber chip

---

## Phase B — Oversight system visibility (close the "is Claude correcting?" gap)

Goal: every oversight signal the user has configured appears on the dashboard.

### B1 — Capture Stop-hook decisions (Layer 3a responses) — **DEFERRED / PIVOTED**

**Original plan**: wrap the Stop prompt hook, capture `{ok, reason}` JSON to disk, surface on dashboard.

**Why deferred**: investigated 2026-04-19 — Claude Code does NOT expose Stop-hook prompt output to any externally observable surface (file, env var, stderr, event). The `{ok, reason}` response is consumed by Claude Code internally and surfaced to Claude as a system reminder in the next assistant turn. There is no hook-adjacent channel to tee that decision into our telemetry without intercepting Claude Code's own handling, which would require forking/replacing the prompt hook mechanism.

**Pivot: forced-continuation detection (B1′) — LANDED 2026-04-19** — detect Stop-hook rejections *indirectly* via existing telemetry signals: if a `Stop` event is followed by more tool events WITHOUT an intervening `UserPromptSubmit`, some Stop hook returned `{ok: false}` and forced Claude to continue. This gives us **count + timing** (what we need for observability) but NOT the reason text (which is Claude-Code-internal). Neutral naming — the signal is source-hook-agnostic, so detection works for any user's Stop prompt/agent hook, not just this project's inlined Layer 3a.

**B1′ tasks — LANDED 2026-04-19**:
- [x] `store.js`: track `_lastUserPromptAt` + `_lastStopAt` + `_lastLifecycleEvent` per live session (stamped in `updatePrompt` and `recordTurnEnd`); detect pattern "Stop was most recent lifecycle event → tool event arrives" in `addToolEvent`; stamp `_forcedContinuations: [{ stopAt, stopSeq, atTurn, firstTool, ts }]`. Dedupe per-Stop via monotonic `_stopSeq` counter (not timestamp — same-ms Stops otherwise collapse).
- [x] Broadcast `forcedContinuation` event in `broadcaster.js`; wire `FORCED_CONTINUATION` reducer case in `useDashboardData.js`.
- [x] UI: `forced-continuation-badge` on `CurrentPrompt.jsx` (amber "N reopened" at 1, red "N loop?" at ≥2); `forced-continuation-banner` at top of `SessionTab.jsx` when `_consecutiveForcedContinuations ≥ 2` with "Possible Stop-hook loop" copy directing user to interrupt or intervene. Tooltip explicitly says "telemetry can't see which Stop hook returned {ok:false}".
- [x] New user prompt resets `_consecutiveForcedContinuations` to 0 but preserves `_forcedContinuations` history.
- [x] Unit (6 new), integration (3 new), browser (2 new) — all passing.
- [x] Live-verified against freshly restarted server at :7890: 1/3 consecutive + user-prompt reset all behave as designed.

**B1′-opt — LLM-self-break loop logic — LANDED 2026-04-19** — the Layer 3a prompt body now carries a LOOP-BREAK CHECK preamble evaluated before the 3 rules. Two triggers:
- **Max 3 consecutive rejections**: if the supervising LLM sees 3+ consecutive assistant turns with no intervening user message, it self-approves with `{"ok": true, "reason": "loop-break: 3+ consecutive rejections detected..."}` and ends the turn so the user can direct/provide guidance.
- **Same-reason repetition**: if the LLM's own prior rejection reason appears nearly identical in the immediately preceding consecutive assistant turn (same rule + same violation text), it self-approves with `{"ok": true, "reason": "loop-break: identical rejection reason repeated..."}`.

**Honest limitation**: this is **LLM-interpreted, not deterministic**. The check relies on the reviewing Haiku correctly counting consecutive assistant turns and comparing reason text. Directionally reliable but could miss edge cases where the transcript is compressed or boundaries are ambiguous. B1′'s deterministic `_consecutiveForcedContinuations` counter + red banner remain the observability fallback — if the LLM misses a loop, the dashboard still flags it at ≥2 consecutive and Ross can interrupt manually.

**Option B — fully deterministic wrapper (FUTURE, not yet scheduled, ~3–4 h)**: replace the `prompt` hook with a `command` hook that invokes the LLM ourselves (via `claude` CLI or Anthropic SDK), captures `{ok, reason}` directly, persists state to `~/.claude/supervisor-state.json`. Gives full reason-text visibility + deterministic same-reason matching but adds an LLM-invocation dependency. Park until MVP proves insufficient.

### B2 — Oversight panel — **DEFERRED with B1**
Without reason text from B1, the panel would only show counts, which the existing badge from B1′ covers. Revisit if Claude Code exposes decision output in a future release.

### B3 — Config change & task completion rows — **LANDED 2026-04-19**
- [x] `ConfigChange` events: added to Events & Failures tab with **cyan** dot + eventType `config_change`
- [x] Detail shows `config_path` + change summary
- [x] `TaskCompleted` events: new `TaskCompletions.jsx` panel on Details tab with per-status color dots
- [x] Both flows broadcast via WebSocket (new `configChange` + `taskCompleted` frame types in broadcaster + useDashboardData)
- [x] Failures tab header renamed `Events & Failures` to reflect scope
- [x] `failureRates` calculation excludes non-execution event types so config/suggest rows don't inflate Bash's "% failing" stat

**Verification** — landed
- [x] Unit: 4 new store tests covering config_change failure row + session list + event emission + no-session path
- [x] Integration: 3 new tests in `config-task-events.test.js` covering real HTTP POST → WebSocket frame → JSONL persistence
- [x] Browser: 3 new tests in `config-task-events.test.js` covering Events & Failures + Details tab DOM rendering

### B4 — Validation-suggest events (Layer 1 suggest, not block) — **LANDED 2026-04-19**
- [x] `tool-validator-v2.js` emits `validation_suggest` via `notifyServer` — confirmed flowing to failure store via `/api/hooks` since `success: false`
- [x] FailureHistory renders **green** dot + "tool suggestion" label for `validation_suggest` events
- [x] Legend updated

**Verification** — landed
- [x] Integration: `POST /api/hooks with event_type=validation_suggest persists as a non-failure row` confirms JSONL row exists
- [x] Browser: `validation_suggest → Events & Failures tab shows green "tool suggestion" label` confirms DOM

---

## Phase C — Agent tab depth (what's actually happening inside a subagent)

Goal: without opening the transcript, I can tell how an agent is doing.

### C1 — Per-agent failure tally — LANDED 2026-04-19
- [x] `store.addToolEvent`: when `toolEvent.agentId` is set and `toolEvent.success === false` and it isn't a validation event, increment `agent._failureCount` and stash `agent._lastError`.
- [x] `AgentActivity.jsx` `ActiveAgentRow`: red `N fails` badge (`data-testid="agent-failure-count"`) next to the tool count; tooltip surfaces the last error text.
- [x] `CompletedAgentDetail`: same red badge (`data-testid="completed-agent-failure-count"`); new `Fails` column in `CostAttributionTable`.
- [x] `sweepOrphanedSubagents` carries `failureCount` / `lastError` into the orphaned history entry so the counter survives orphan conversion.

### C2 — Transcript-parse status — LANDED 2026-04-19
- [x] `hook-forwarder.js` subagent-stop: initialize `_transcriptMetrics = { status: 'ok' }`; tag `'missing-path'` if no `agent_transcript_path`, `'missing'` on ENOENT, `'parse_failed'` when parseTranscript returns null or throws non-ENOENT.
- [x] `store.removeSubagent`: record `transcriptStatus` on history entry (fallback: `metrics.tokens ? 'ok' : 'missing'`); `sweepOrphanedSubagents` stamps `'missing'` on orphaned entries.
- [x] `CompletedAgentDetail`: amber `transcript lost` chip (`data-testid="completed-agent-transcript-lost"`) when `transcriptStatus === 'missing' || 'parse_failed'`.
- [x] Cost attribution table: transcript-lost agents marked with `*`; footer note (`data-testid="cost-table-transcript-lost-footer"`) flags that cost totals understate actual spend.

### C3 — Validation-block tally per agent — LANDED 2026-04-19
- [x] `store.addToolEvent`: `eventType === 'validation_block'` with `agentId` increments `agent._validationBlockCount` (does NOT pollute `_failureCount`).
- [x] `AgentActivity.jsx`: amber `N blocked` badge on active row (`data-testid="agent-validation-block-count"`) + on completed detail (`data-testid="completed-agent-validation-block-count"`).
- [x] `scripts/tool-validator-v2.js`: pass through `agent_id` from PreToolUse stdin so validation events are correctly attributed when Bash fires inside a subagent.

### Phase C1/C2/C3 verification
| Item | Verification |
|------|--------------|
| Per-agent failure counter + last error | **Unit** (3 tests in `tests/unit/store.test.js`): agent failure increments `_failureCount` + stashes `_lastError`; validation_block does NOT inflate `_failureCount`; counters carry into history on removeSubagent. **Integration** (1 test in `tests/integration/agent-tallies.test.js`): real HTTP POST → snapshot reflects `_failureCount=1, _lastError='ENOENT'`. **Browser** (1 Playwright test in `tests/browser/agent-tallies.test.js`): 2 failures → red "2 fails" badge renders on active row. |
| Transcript status propagation | **Unit** (4 tests): `ok`, `missing`, `parse_failed`, and orphaned→`missing` paths all reach the history entry. **Integration** (2 tests): real POST with no metrics → `transcriptStatus='missing'`; POST with `status='parse_failed'` → carries through. **Browser** (2 Playwright tests): amber `transcript lost` chip renders + cost-table footer flags understated totals. |
| Validation-block attribution | **Unit** (2 tests): `validation_block` increments `_validationBlockCount`; carries into history. **Integration** (1 test): real POST with `agent_id` → agent-scoped counter. **Browser** (1 Playwright test): amber "1 blocked" badge renders. |
| Tool-validator-v2 pass-through of agent_id | **Code review**: `agentId` extracted from stdin, forwarded to `notifyServer` on both block + suggest paths. No integration test — would require spawning validator subprocess with crafted stdin (covered indirectly by the C3 integration test POSTing `/api/hooks` directly with `agent_id`). |
| Live server behavior | **Manual** (curl → freshly restarted `:7890`): status+subagent-start+fail+block + stop flow → snapshot shows `_failureCount: 1, _validationBlockCount: 1` on active agent; after stop, history entry shows `transcriptStatus: 'missing', failureCount: 1, validationBlockCount: 1`. Raw snapshots captured in session transcript. |

Tier totals after C1/C2/C3: **65/65 unit** (9 new), **14/14 integration** files passing (4 new — suite-level 11/11), **12/12 new browser tests** (4 new). Pre-existing `statusline-banner.test.js` baseline still failing — out of scope.

### C4 — Subagent timeline (gantt-lite) — LANDED 2026-04-19
- [x] `src/components/SubagentTimeline.jsx`: native SVG (no Recharts dep). Horizontal lanes sorted by startedAt; bars from startedAt → endedAt (or now for active); amber vertical lines for compactions; blue vertical lines for UserPromptSubmit; gray ticks under the chart for Stop events.
- [x] Wired into `AgentActivity.jsx` above the Active + Completed panels, collapsed by default. Ticks every 1s while expanded so active lanes grow live.
- [x] Active agents get a pulsing endpoint; orphaned agents render with a dashed red border at 50% opacity; type label embeds inside wide bars.
- [x] Hover titles on every element (lane, compact line, prompt line, Stop tick) carry the full context (timestamp, trigger, prompt text snippet, turn number).

**Verification — LANDED**
- [x] Browser (2 tests in `tests/browser/subagent-timeline.test.js`): collapsed-by-default + expands to show active lane; compaction event → `[data-testid="timeline-compact-line"]` renders.

Tier totals after C4: **65/65 unit**, **14/14 integration** files, **14/14 new browser tests** (2 new). Pre-existing `statusline-banner.test.js` baseline still failing — out of scope.

---

## Phase D — Failure tab intelligence

Goal: patterns, not just raw logs.

### D1 — Error-class categorization — LANDED 2026-04-19
- [x] `failure-store.js` `classifyError(error, eventType)`: text-match buckets `not_found` | `permission` | `size_limit` | `timeout` | `network` | plus eventType-driven classes `validation` | `suggestion` | `config` | `orphan`; fallback `other`.
- [x] `append()` stamps `errorClass` on every new record; `load()` backfills historical records missing the field.
- [x] `getPatterns()` returns a `byClass` breakdown and a `totalRetries` count.
- [x] `FailureHistory.jsx`: breakdown chips (`data-testid="error-class-breakdown"`) show class + count; each failure row gets an inline `[class]` label.

### D2 — Retry detection — LANDED 2026-04-19
- [x] `hashToolInvocation(toolName, toolInput)`: sha1 hash used for retry matching.
- [x] On append, scan trailing 60s of cache for same session + same hash + execution-type eventType → stamp `retryOf` and `retrySequence` (0 for originals, N+1 for retries).
- [x] Exemption: `config_change`, `validation_suggest`, `subagent_orphaned` do NOT participate in retry chains.
- [x] `FailureHistory.jsx`: red "retry #N" badge on each retry row (`data-testid="failure-retry-badge"`); expanded detail shows `retryOf` link.

### D3 — Prompt linkage — LANDED 2026-04-19
- [x] `store._promptContextFor(sessionId)` helper builds `{ promptId, promptSnippet }` from the live session.
- [x] Threaded through all `failureStore.append()` call sites: hook-receiver `/api/hooks` (user failures), `recordConfigChange`, `sweepOrphanedSubagents`.
- [x] `promptId` is a stable `sessionId::_lastUserPromptAt` pair; `promptSnippet` is truncated to 200 chars.
- [x] `FailureHistory.jsx`: expanded row shows "Triggered during prompt: …" (`data-testid="failure-prompt-link"`).

### D4 — Failure cost-weighted ranking — LANDED 2026-04-19
- [x] `failureStore.append()` accepts optional `estimatedCost`; hook-receiver passes through `event.estimated_cost`.
- [x] `getTopCostFailures(n, since)` returns top-N by cost desc, excluding records without cost.
- [x] `/api/failures/top-cost?n=3` endpoint.
- [x] `FailureHistory.jsx`: top-3 panel (`data-testid="top-cost-failures"`) + cost-vs-time sort toggle.
- [x] **Limitation**: estimatedCost must be supplied by the caller — telemetry doesn't auto-derive cost per failure. Claude Code's current hook payloads don't include per-tool-call cost, so this field is opt-in for callers who have the signal (external wrappers, SDK integrations).

### D5 — Hook-forwarder self-health panel — LANDED 2026-04-19
- [x] New `server/hook-health.js`: reads tail of `hook-debug.log` (PROJECT_ROOT/hook-debug.log), matches against ERROR_PATTERNS regex set, parses `transcript parse: Xms` lines to compute P95 latency.
- [x] Returns: `{ exists, healthy, reason, logPath, fileSizeBytes, recentErrors, errorCount, transcriptP95Ms, transcriptSamples }`.
- [x] `GET /api/hook-health` endpoint.
- [x] `FailureHistory.jsx` chip (`data-testid="hook-health-chip"`) — green "hooks ok" or red "hooks N err"; auto-polls every 60s.

### Phase D verification
| Item | Verification |
|------|--------------|
| D1 classifyError + backfill on load | **Unit** (9 tests in `tests/unit/failure-store.test.js`): ENOENT→not_found, EACCES→permission, 256KB→size_limit, timeout→timeout, orphan/validation/suggestion/config via eventType, 'other' fallback; append stamps errorClass; load backfills historical records. |
| D2 retry detection via hashToolInvocation | **Unit** (5 tests): same hash on identical input, different hash on different input, 2nd→retrySequence=1, 3rd→retrySequence=2, different session doesn't chain, config_change exempt. |
| D3 prompt linkage | **Unit** (2 tests): promptId + snippet carry through, snippet truncated at 200. **Integration** (1 test in `tests/integration/failure-intel.test.js`): real POST sequence (status + prompt + hook failure) → JSONL row has `promptId` starting with session id and snippet matching the prompt text. |
| D4 cost-weighted ranking + endpoint | **Unit** (2 tests): sorted desc, filters records without estimatedCost. **Integration** (1 test): `/api/failures/top-cost?n=2` returns records in descending cost order. |
| D5 hook-health | **Unit** (4 tests in `tests/unit/hook-health.test.js`): missing log, healthy log, log with ERROR lines, P95 latency parsing. **Integration** (1 test): `/api/hook-health` returns the expected shape when log is absent. |
| UI surfaces | **Browser** (3 tests in `tests/browser/failure-intel.test.js`): error-class breakdown chips render on Events & Failures tab; 2 identical failures → retry badge renders; hook-health chip renders. |
| Live server behavior | **Manual** (curl → freshly restarted :7890): 3 identical failures with prompt active → errorClass=not_found + retrySequence=0,1,2 + promptId + promptSnippet + estimatedCost all recorded. `/api/failures/top-cost?n=3` returns descending by cost. `/api/hook-health` on real log → healthy:false, errorCount=5, transcriptP95Ms=2, transcriptSamples=715. Raw outputs captured in session transcript. |

Tier totals after Phase D: **78/78 unit** (13 new), **17/17 integration** files (3 new), **17/17 new browser tests** (3 new). Pre-existing `statusline-banner.test.js` baseline still failing — out of scope.
- [ ] Integration test: seed a log with known error pattern → endpoint returns correctly
- [ ] Browser test: chip renders `hooks failing` when errors present

---

## Phase E — Cross-cutting polish

### E1 — Parent/child relationship in subagent data — LANDED 2026-04-19

Forwarder-through + UI surface: `scripts/hook-forwarder.js` subagent-start now passes through `parent_agent_id` from the SubagentStart payload (null if Claude Code doesn't supply it). `store.addSubagent` stamps `parentAgentId` on the active agent; `removeSubagent` + `sweepOrphanedSubagents` carry it into history. `AgentActivity.jsx` ActiveAgentRow renders `↳ parent <8-char>` chip (`data-testid="agent-parent-ref"`) when parent is present. Best-effort: Claude Code's current SubagentStart schema doesn't include `parent_agent_id` — the field is captured if/when Claude Code starts emitting it, otherwise the display degrades cleanly to a flat list.

**Verification — LANDED**
- [x] Unit (3 tests in `tests/unit/store.test.js`): parent_agent_id stamps on active agent; null when not provided; carries into history entry.
- [x] Browser (1 test in `tests/browser/subagent-parent.test.js`): child with parent_agent_id renders parent reference chip on Agents tab.

### E1 — original spec (preserved for reference)
- [ ] `hook-forwarder.js` subagent-start: if `parsed.parent_agent_id` present (it is in newer Claude Code versions), pass through
- [ ] `store.js`: stash `parentAgentId`
- [ ] `AgentActivity.jsx`: indent nested agents under their parent in the Active list

### E2 — SessionStart / PreCompact trigger origin — DEFERRED 2026-04-19

PreCompact already forwards `trigger: 'auto' | 'manual'` — that's the only reliable origin signal Claude Code emits today. SessionStart has no payload field identifying why the session started (fresh vs resumed vs hook-restart). Without a Claude Code change, E2 would be a no-op. Parked until a concrete need or a new payload field surfaces. The hook-health panel (D5) already catches the most practically valuable signal — "the forwarder is broken" — which is what this would have surfaced indirectly.

### E2 — original spec (preserved for reference)
- [ ] Compact events already carry `trigger` (auto/manual); surface as "auto" vs "manual" in the Agents-tab compact chip tooltip

### E3 — "Agent was running during compaction" separate row — included in A4
- covered by A4 chip; no extra work

---

## Dependencies + ordering

```
A1 ─┬─► A2 ─► A3
    └─► A4
                         (A complete = orphans solved, can demo)
B1 ─► B2
B3, B4 parallel to B1/B2
                         (B complete = oversight visible)
C1, C2, C3 parallel
C4 depends on A4 (shares compaction overlay)
                         (C complete = agent interior visible)
D1 ─► D2 ─► D3
D4 parallel
D5 parallel
                         (D complete = pattern intelligence)
E1, E2 quick polish
```

Phase A is the MVP. Stop there if time-boxed; it resolves the specific failure pattern from today's session. B is the next-most-valuable since oversight responses are completely dark today.

## Estimated effort

| Phase | Wall-clock | Notes |
|-------|------------|-------|
| A | 2.5 h | Small, self-contained, safe |
| B | 2.5 h | New endpoint + wrapper hook — test carefully |
| C | 3.5 h | Timeline is the long pole |
| D | 2.5 h | All additive to existing failure store |
| E | 1 h | Polish |
| **Total** | **~12 h** | Plus ~2 h test harness additions |

## Risks & fallbacks

| Risk | Mitigation |
|------|-----------|
| B1 wrapper hook design might conflict with existing Stop prompt hook | Prototype in worktree first; fallback: parse supervisory-log.md tail instead of intercepting hook output |
| Orphan sweep false-positives (agent legitimately running long) | Configurable threshold; default 10 min is conservative; tooltip says "may be" not "is" |
| New `_spannedCompactAt` field breaks old clients | Field is purely additive; frontend code uses `?.` optional chaining everywhere |
| Timeline (C4) lands poorly on narrow screens | Collapsible; falls back to a text-only "compaction timeline" summary |
| `failure-store.jsonl` grows fast with new event types | Already rotation-aware (`MAX_FAILURE_CACHE`); new types tagged with `eventType` so they can be filtered out of the digest |

## What is VERIFIED via outer seam

| Item | Verification |
|------|--------------|
| A1 `_lastToolAt` stamped on tool events inside subagents | **Integration**: `POST /api/hooks with agent_id stamps _lastToolAt on the active subagent` — fires real HTTP POST, reads `/api/snapshot`. Unit-covered too. |
| A2 `sweepOrphanedSubagents` moves stale agents to history | **Integration**: `sweepOrphanedSubagents (via _test endpoint) moves stale agent to history + writes failure row` — spawns real server, POSTs subagent-start through real endpoint, triggers sweep via `/api/_test/state`, reads `/api/snapshot`. Unit tests (5) cover edge cases. |
| A3 orphan sweep writes failure-store row | **Integration**: same test reads `~/.claude/telemetry-failures.jsonl` from the tmp HOME, confirms `eventType: 'subagent_orphaned'` row persisted. Unit-covered too. |
| A4 `recordCompact` stamps `_spannedCompactAt` on active subagents + carries into history | **Integration**: `POST /api/compact stamps _spannedCompactAt on all active subagents` + `orphan sweep + compact: orphaned agent in history carries spannedCompactAt through`. Unit tests (3) cover edge cases. |
| A1 stale badge + A4 compact chip render in the Agents tab | **Browser**: `active agent renders after subagent-start POST` + `orphan sweep → Agents tab shows "orphaned" chip on completed detail` — Playwright against built dashboard, expands collapsible, asserts DOM. |
| A3 "orphaned agent" purple row renders on Failures tab | **Browser**: `orphan sweep → Failures tab shows purple "orphaned agent" row` — Playwright clicks Failures sub-tab, asserts label text. |
| Existing store behavior unchanged | 25/25 pre-existing store tests green |
| Hook-receiver integration unchanged | 7/7 pre-existing integration tests green |
| Production build clean | `npm run build` succeeds, 672 modules, no new warnings |

Tier totals after Phase A: **37/37 unit** (12 new), **21/21 integration** (5 new), **3/3 new browser** (orphan file).

### Phase B (2026-04-19)

| Item | Verification |
|------|--------------|
| B3 ConfigChange → Events & Failures tab (cyan), persisted to failure JSONL | **Integration**: `POST /api/config-change → configChange WebSocket frame + failureEvent row` — real HTTP POST, real WebSocket client, JSONL file read. Unit (4 new) + **Browser**: `config_change → Events & Failures tab shows cyan "config change" label`. |
| B3 TaskCompleted → Details tab (`TaskCompletions.jsx`) | **Integration**: `POST /api/task-completed → taskCompleted WebSocket frame with session task list`. **Browser**: `task_completed → Details tab shows task in TaskCompletions panel`. |
| B4 validation_suggest → Events & Failures tab (green) | **Integration**: `POST /api/hooks with event_type=validation_suggest persists as a non-failure row`. **Browser**: `validation_suggest → Events & Failures tab shows green "tool suggestion" label`. |
| `failureRates` excludes non-execution event types (no false Bash % inflation) | Code review — trivial set-membership check; unit coverage exists for `addToolEvent` shape. |

Tier totals after Phase B: **41/41 unit** (4 new), **24/24 integration** (3 new), **6/6 new browser** (3 new). Pre-existing `statusline-banner.test.js` failure baseline unchanged.

### Phase B1′ (2026-04-19)

| Item | Verification |
|------|--------------|
| `_lastLifecycleEvent` + `_stopSeq` ordering on `updatePrompt` / `recordTurnEnd` | **Unit** (6 tests in `tests/unit/store.test.js`): tool-event-after-Stop records entry; multiple tools after one Stop dedupe; new prompt resets consecutive counter; 3 consecutive Stop-tool cycles stack; no-fire when tools precede any Stop; no-fire when UserPromptSubmit never recorded. |
| `forcedContinuation` WebSocket frame shape + dedupe | **Integration** (3 tests in `tests/integration/forced-continuation.test.js`): real HTTP POST `/api/turn-end` + `/api/hooks` → WebSocket frame with correct `sessionId` / `consecutive` / `total` / `entry.firstTool`; dedupe-per-Stop asserted via snapshot; new prompt resets counter. |
| Amber badge on CurrentPrompt + red banner on SessionTab | **Browser** (2 tests in `tests/browser/forced-continuation.test.js`, Playwright against built `dist/`): `data-testid="forced-continuation-badge"` renders after one cycle; `data-testid="forced-continuation-banner"` with "Stop-hook loop" copy renders at ≥2 consecutive. |
| Behavior on live server | **Manual** (curl → `:7890` after restart): single cycle → `_forcedContinuations.length=1, _consecutiveForcedContinuations=1`; three cycles → `length=3, consecutive=3, stopSeq=[1,2,3]`; subsequent user prompt → `length=3 preserved, consecutive=0`. Raw snapshots captured in session transcript. |

Tier totals after B1′: **47/47 unit** (6 new), **13/13 integration** (3 new — suite-level 10/10 files), **8/8 new browser** (2 new). Pre-existing `statusline-banner.test.js` baseline still failing — unchanged and out-of-scope.

### Phase B1′-opt (2026-04-19)

| Item | Verification |
|------|--------------|
| Layer 3a prompt body carries LOOP-BREAK CHECK preamble before the 3 rules | **Unit** (7 tests in `tests/unit/setup-hooks.test.js`): `buildHookConfig({}).hooks.Stop[*].hooks[prompt].prompt` contains `LOOP-BREAK CHECK`, `3+ consecutive`, `identical rejection`, all 3 original rules preserved, loop-break appears BEFORE rule 1, foreign Stop hooks preserved on idempotent re-run. |
| Deployed prompt is the one in the live settings.json | **Manual** (`node` read of `~/.claude/settings.json`): Stop prompt hook text confirmed to contain `LOOP-BREAK CHECK`, `3+ consecutive`, `identical rejection`. |
| `buildHookConfig` safely importable in tests (no accidental settings.json write) | **Unit** (implicit): `tests/unit/setup-hooks.test.js` imports the module directly; if the CLI guard were broken, every unit run would overwrite the user's settings. Addresses a real bug caught during this pass where an earlier guard's `endsWith('')` was always-true. |

Tier totals after B1′-opt: **54/54 unit** (7 new), integration/browser unchanged (prompt-body change is not integration- or DOM-observable).

## What is PARTIAL (not verified via outer seam)

| Item | Status | Linked LE / item ID |
|------|--------|---------------------|
| Live production dashboard reflects the new behavior on the user's stuck `facilitator a4dfff3e74af54934` | Code-reviewed + unit + integration + browser-seam green, but the currently-running telemetry server process still has the PRIOR code in memory. Restarting it will lose the in-memory orphan under test | LE-A-live-restart |
| Periodic sweep timing (5 min interval from `pruneStale`) end-to-end on a real session | Not rerun against the real user server (requires restart) — test suite verifies each tick fires the sweep logic, not the real-server interval clock | LE-A-interval |

To verify the PARTIAL items: restart the telemetry server (`rh-telemetry start --bg` or kill+restart), reload the dashboard. On a fresh session that later accumulates an orphaned subagent, it should appear on both tabs within 5 min. Note the currently-stuck `facilitator a4dfff3e74af54934` will be lost on restart (in-memory state only) — won't be observable post-restart unless a new orphan forms.

## Recovery notes

- Every phase is independently reversible — each lands behind a field-addition pattern, not a schema migration.
- If the live dashboard behaves oddly after a phase lands: roll back via `git revert <phase-commit>`, restart telemetry server with `rh-telemetry start --bg`, hook debug log will show whether any forwarder path is now broken.
- The failure JSONL store never has rows deleted; rolling back code doesn't corrupt history.
- New hooks (Phase B) are added, not replacing existing ones — a broken new hook only disables the new signal, not existing telemetry.

## Open questions

### Answered
- ✅ *Does Claude Code expose the Stop-hook prompt's `{ok, reason}` output?* **No** — investigated 2026-04-19. Decision is consumed internally and relayed to the assistant as a system reminder only. See B1 pivot above.
- ✅ *Should `config_change` live on Failures tab or a new sub-tab?* **Failures tab**, renamed `Events & Failures` — landed in B3.

### Still open (answer before B1′ / E1)
- Does `SubagentStart` carry a `parent_agent_id` field in the current Claude Code version? Controls E1 (parent/child indentation on Agents tab).
- Does the `TodoWrite`-backed TaskCompleted hook fire on every individual task state change, or only on batch completions? Changes how we dedupe entries in `TaskCompletions.jsx`.

---

## Phase F — README / GitHub intro refresh with annotated screenshots

**Why this matters:** The README today describes the dashboard in prose. A prospective user (or future-you rediscovering the repo) cannot *see* what failure class each panel catches. The whole point of this tool is surfacing observable phenomena that Claude Code otherwise hides from the programmer — so the intro has to *show* those phenomena, with callouts tying the visible signal back to the underlying failure it represents.

### F — README restructure — PARTIAL 2026-04-19

F3 (restructure intro) and F2 (write callouts) landed: README now opens with a "What this catches that Claude Code hides" section leading with 7 phenomenon-led vignettes (orphaned subagents, Stop-hook loops, mixed-class events, context pressure, cost breakdown, failure patterns, hook-forwarder self-health). Each vignette follows the spec template: "What you're looking at" → "What's actually happening" → "Why it matters." A seed-and-capture guide lives at `docs/screenshots/README.md`.

F1 (capture canonical screenshots) — **NOT LANDED** in this session. The README references `docs/screenshots/*.png` but the files don't exist yet. Screenshots are visual-quality content best produced from a real Claude Code session with representative data (and reviewed by a human for clarity), rather than generated programmatically from synthetic test fixtures. The `docs/screenshots/README.md` index explains the filename → panel mapping and the seed-via-test-endpoint workflow if automation is preferred later.

**Verification (outer seam)**
- [ ] Render the updated README on the actual GitHub project page — requires push to remote first. Text is in place; image refs are `<img alt>` with descriptive alt text so the README is still useful on a viewer without images rendered.
- [ ] Capture screenshots into `docs/screenshots/` — user-in-the-loop task.

### F1 — Capture canonical screenshots
- [ ] Agents tab with at least one **orphaned** (red "likely orphaned") and one **idle?** (amber) subagent — phenomenon: `SubagentStop` never fired after parent interrupt or compaction; without this panel the programmer assumes the agent is still working
- [ ] Events & Failures tab showing mixed rows: Bash validation block (amber), PostToolUse failure (red), config change (cyan), validation_suggest (green) — phenomenon: Layer-1 deterministic validator catching `cat`/`grep`/`echo>` redirects in real time; programmer sees *why* a command was blocked, not just that it was
- [ ] Context Window panel at >70% with cache hit ratio visible — phenomenon: compaction pressure / cache churn that silently inflates cost and degrades quality before Claude admits it
- [ ] ModelBreakdown donut with subagent model mix — phenomenon: Opus parent delegating to Haiku/Sonnet subagents; explains cost attribution the Claude UI never discloses
- [ ] TurnCostChart with a visible spike — phenomenon: per-turn cost drift (reruns, retry loops, large reads) that would otherwise only surface in the monthly bill
- [ ] FailureHistory patterns view — phenomenon: recurring failure clusters across sessions (same tool, same error shape) the user can't spot one-session-at-a-time

### F2 — Write the callouts (one per screenshot)
- [ ] Each screenshot gets a 2-3 sentence caption in the README following this template: **What you're looking at** (the visible signal) → **What's actually happening under the hood** (the phenomenon the programmer can't see in the Claude CLI) → **Why it matters** (the decision this lets them make: intervene, restart, cap cost, adjust prompt)
- [ ] Lead with the failure/phenomenon, not the feature — "Subagent silently orphaned after compaction" is a better heading than "Agent Activity panel"

### F3 — Restructure the README intro
- [ ] New "What this catches that Claude Code hides" section at the top, above the existing Quick Start, with the annotated screenshots inline
- [ ] Keep the existing Quick Start / Architecture / Data Flow sections unchanged below (additive rule)
- [ ] Add a one-line link from each Phase-A/B/F feature description in CLAUDE.md to the matching README screenshot anchor, so maintainers can trace the phenomenon → implementation path

**Verification (outer seam)**
- [ ] Render the updated README on the actual GitHub project page (not local preview) — images resolve, anchors work, callouts legible on both light and dark GitHub themes
- [ ] A reader who has never used the tool can, from the README alone, name three failure classes it surfaces and point to the panel that catches each

**Deferred until after F:** public npm publish. The README is the front door; the screenshots have to land first.
