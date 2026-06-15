import { EventEmitter } from 'events';
import {
  MAX_TOOL_EVENTS, MAX_TURN_HISTORY, MAX_SUBAGENT_HISTORY,
  MAX_PROMPT_HISTORY, MAX_CONTEXT_HISTORY, DEFAULT_CONTEXT_WINDOW_SIZE,
  STALE_SESSION_MS, FORCE_REFRESH_MS, SUBAGENT_ORPHAN_MS, resolveContextWindowSize,
  STATUS_LINE_STALL_MS, STATUS_LINE_STALL_MIN_TOOLS,
} from './config.js';
import { FailureStore } from './failure-store.js';
import { FailureAlerter } from './failure-alerting.js';
import { HookPerfStore } from './hook-perf-store.js';
import { estimateCost } from './cost-rates.js';

class Store extends EventEmitter {
  constructor() {
    super();
    this.failureStore = new FailureStore();
    this.failureStore.onAppend = (record) => this.emit('failureEvent', record);
    this.hookPerfStore = new HookPerfStore();
    this.hookPerfStore.onAppend = (record) => this.emit('hookPerfEvent', record);
    this.failureAlerter = new FailureAlerter();
    this.data = {
      currentSession: null,
      sessions: [],
      stats: null,
      toolEvents: [],
      liveSessions: {},
      planInfo: { planType: null, displayMode: 'cost', usage: null, usageSource: null, usageTimestamp: null, lastUpdated: null },
      statusLineState: {
        class: 'unknown',
        command: '',
        scriptPath: null,
        lastCheckedAt: null,
        lastStatusPostAt: null,
        stalled: false,
        reason: null,
      },
      timestamp: Date.now(),
    };
    // Per-process counter for stall detection (not part of snapshot)
    this._toolEventsSinceLastStatusPost = 0;
  }

  /**
   * D3 — Build a prompt-linkage bundle for a given session so failure-store
   * records can carry a reference back to the user prompt that was active
   * when the failure occurred. `promptId` uses the prompt timestamp as a
   * stable per-prompt identifier within the session.
   */
  _promptContextFor(sessionId) {
    const sess = this.data.liveSessions[sessionId];
    if (!sess) return { promptId: null, promptSnippet: null };
    return {
      promptId: sess._lastUserPromptAt ? `${sessionId}::${sess._lastUserPromptAt}` : null,
      promptSnippet: sess._currentPrompt || null,
    };
  }

  /** Update from file parse results.
   *  Guards against transient read failures: if .claude.json is mid-write
   *  when chokidar fires, parseAll returns empty/null data. We only replace
   *  existing state when the new data is non-empty, preventing dashboard resets.
   */
  update(parsed) {
    const changed = {};

    if (parsed.currentSession) {
      this.data.currentSession = parsed.currentSession;
      changed.currentSession = parsed.currentSession;
    }

    if (parsed.stats) {
      this.data.stats = parsed.stats;
      changed.stats = parsed.stats;
    }

    // Only replace sessions when new data is non-empty. An empty array from
    // parseAllSessions means the file was unreadable or mid-write — not that
    // all sessions vanished. Preserves existing sessions during transient failures.
    if (parsed.sessions && parsed.sessions.length > 0) {
      this.data.sessions = parsed.sessions;
      changed.sessions = parsed.sessions;
    }

    this.data.timestamp = Date.now();
    changed.timestamp = this.data.timestamp;

    // Only emit if something actually changed (avoid no-op broadcasts)
    if (Object.keys(changed).length > 1) { // > 1 because timestamp is always present
      this.emit('update', changed);
    }
  }

  /**
   * StatusLine stall check. Called on each tool event. Increments the
   * per-process counter and, if enough tool events have piled up since the
   * last real statusLine-sourced post AND enough time has elapsed, marks the
   * statusLine as stalled. First-run guard: skipped entirely until at least
   * one statusLine post has been received (otherwise a fresh boot would
   * always fire on the first tool event).
   */
  _checkStatusLineStall() {
    const slState = this.data.statusLineState;
    // Can't detect stall until we've seen at least one real statusLine post
    if (!slState.lastStatusPostAt) return;

    this._toolEventsSinceLastStatusPost += 1;

    if (this._toolEventsSinceLastStatusPost < STATUS_LINE_STALL_MIN_TOOLS) return;

    const elapsed = Date.now() - slState.lastStatusPostAt;
    const shouldBeStalled = elapsed > STATUS_LINE_STALL_MS;

    if (shouldBeStalled && !slState.stalled) {
      this.updateStatusLineState({ stalled: true });
      console.log(`[statusline] STALLED — ${this._toolEventsSinceLastStatusPost} tool events since last statusLine post, ${Math.round(elapsed / 1000)}s elapsed`);
    }
  }

  /** Add a tool event from hooks */
  addToolEvent(event) {
    this._checkStatusLineStall();
    const toolEvent = {
      id: Date.now() + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      tool: event.tool_name || event.tool || 'unknown',
      input: event.tool_input || event.input || '',
      session: event.session_id || '',
      agentId: event.agent_id || null,
      agentType: event.agent_type || null,
      type: event.event_type || 'tool_call',
      success: event.success !== false,
      error: event.error || null,
      durationMs: event.duration_ms || null,
      cwd: event.cwd || null,
    };
    // If the session_id is missing at top level but exists in tool_input (Windows env var issue)
    if (!toolEvent.session && typeof toolEvent.input === 'object' && toolEvent.input?.session_id) {
      toolEvent.session = toolEvent.input.session_id;
    }

    this.data.toolEvents.unshift(toolEvent);
    if (this.data.toolEvents.length > MAX_TOOL_EVENTS) {
      this.data.toolEvents = this.data.toolEvents.slice(0, MAX_TOOL_EVENTS);
    }

    this.emit('toolEvent', toolEvent);

    // Forced-continuation detection: if Stop was the most recent prompt-lifecycle
    // event (more recent than the last UserPromptSubmit) and a tool event arrives,
    // some Stop hook (Layer 3a, user-configured agent hook, or third-party)
    // returned {ok:false} and forced Claude to continue. We can't read hook output
    // directly, so detect indirectly via the `_lastLifecycleEvent` marker set by
    // updatePrompt/recordTurnEnd. Dedupe per Stop via _lastCountedStopAt so a
    // multi-tool continuation counts once.
    if (toolEvent.session) {
      const sess = this.data.liveSessions[toolEvent.session];
      if (sess && sess._lastLifecycleEvent === 'stop'
          && sess._lastUserPromptAt
          && sess._stopSeq
          && sess._stopSeq !== sess._lastCountedStopSeq) {
        const entry = {
          stopAt: sess._lastStopAt,
          stopSeq: sess._stopSeq,
          ts: Date.now(),
          atTurn: sess._turnCount || 0,
          firstTool: toolEvent.tool,
        };
        const list = sess._forcedContinuations || [];
        list.push(entry);
        if (list.length > 50) list.shift();
        sess._forcedContinuations = list;
        sess._lastCountedStopSeq = sess._stopSeq;
        sess._consecutiveForcedContinuations = (sess._consecutiveForcedContinuations || 0) + 1;
        this.emit('forcedContinuation', {
          sessionId: toolEvent.session,
          entry,
          consecutive: sess._consecutiveForcedContinuations,
          total: list.length,
        });
      }
    }

    // Check failure alerting threshold
    if (!toolEvent.success && toolEvent.session) {
      const alert = this.failureAlerter.check(toolEvent.session, toolEvent.tool, toolEvent.timestamp);
      if (alert) {
        this.emit('failureAlert', alert);
      }
    }

    // Track per-agent tool count if tool fired inside a subagent
    if (toolEvent.agentId && toolEvent.session) {
      const session = this.data.liveSessions[toolEvent.session];
      if (session) {
        const agent = session._activeSubagents?.[toolEvent.agentId];
        if (agent) {
          agent._toolCount = (agent._toolCount || 0) + 1;
          agent._lastTool = toolEvent.tool;
          agent._lastToolAt = Date.now();
          // C1 — per-agent failure tally. Only counts real PostToolUse failures,
          // not validation events (those get their own counter below).
          if (toolEvent.success === false
              && toolEvent.type !== 'validation_block'
              && toolEvent.type !== 'validation_suggest') {
            agent._failureCount = (agent._failureCount || 0) + 1;
            agent._lastError = toolEvent.error || null;
          }
          // C3 — per-agent validation-block tally. Layer 1 deterministic blocks
          // on the agent's Bash calls. High counts indicate the agent is running
          // a weird command pattern and is being auto-corrected away from it.
          if (toolEvent.type === 'validation_block') {
            agent._validationBlockCount = (agent._validationBlockCount || 0) + 1;
          }
          // V2 — live agent telemetry from transcript parsing piggybacked on tool events
          const alm = event._agentLiveMetrics;
          if (alm) {
            if (alm.cost?.total_cost_usd != null) agent._liveCost = alm.cost.total_cost_usd;
            if (alm.context_window?.used_percentage != null) agent._liveContextPct = alm.context_window.used_percentage;
            if (alm.context_window?.total_input_tokens != null) agent._liveContextTokens = alm.context_window.total_input_tokens;
            if (alm.model?.display_name) agent._liveModel = alm.model.display_name;
            // Count turns from model costs
            if (alm._modelCosts) {
              const totalTurns = Object.values(alm._modelCosts).reduce((s, m) => s + (m.count || 0), 0);
              if (totalTurns > 0) agent._liveTurns = totalTurns;
            }
            // Prompt fallback: fill from transcript if SubagentStart missed it
            if (!agent.prompt && alm._prompt) agent.prompt = alm._prompt;
          }
          // Emit update so UI refreshes agent tool counts in real time
          this.emit('subagentUpdate', {
            sessionId: toolEvent.session,
            action: 'toolEvent',
            agentId: toolEvent.agentId,
            activeSubagents: session._activeSubagents,
            subagentHistory: session._subagentHistory || [],
          });
        }
      }
    }

    // Derive a live session from tool events if no statusLine data exists
    // This ensures sessions show as "live" even when statusLine hook isn't firing
    if (toolEvent.session) {
      const id = toolEvent.session;
      const existing = this.data.liveSessions[id];
      if (!existing || !existing._fromStatusLine) {
        const cwd = event.cwd || existing?.workspace?.current_dir || '';
        const projectName = cwd ? cwd.split(/[\\/]/).pop() : '';
        const sessionData = {
          ...(existing || {}),
          session_id: id,
          _lastSeen: Date.now(),
          _fromToolEvents: true,
          _toolCount: (existing?._toolCount || 0) + 1,
          _lastTool: toolEvent.tool,
          _entrypoint: event.entrypoint || existing?._entrypoint || null,
          workspace: { current_dir: cwd },
        };
        // Add model info if we don't have it yet (try to extract from project's file data)
        if (!sessionData.model) {
          sessionData.model = { display_name: 'Active' };
        }
        if (!sessionData.cost) {
          sessionData.cost = { total_cost_usd: 0 };
        }
        this.data.liveSessions[id] = sessionData;
        this.emit('liveSession', { id, data: sessionData });
      } else {
        // Update _lastSeen and tool count on existing statusLine-derived session
        existing._lastSeen = Date.now();
        existing._toolCount = (existing._toolCount || 0) + 1;
        existing._lastTool = toolEvent.tool;
        if (!existing._entrypoint && event.entrypoint) existing._entrypoint = event.entrypoint;
        // A tool ran — any pending permission request has been decided
        if (existing._awaitingPermission) existing._awaitingPermission = null;
        // Activity after SessionEnd means the session resumed
        if (existing._ended) { existing._ended = false; existing._endedAt = null; }
        this.emit('liveSession', { id, data: existing });
      }
    }

    // Accumulate tool events for current turn timeline. Placed AFTER the
    // live-session derivation block so the first tool event on a brand-new
    // session also lands in _currentTurnEvents (the session entry didn't
    // exist before derivation).
    if (toolEvent.session) {
      const sess = this.data.liveSessions[toolEvent.session];
      if (sess) {
        if (!sess._currentTurnEvents) sess._currentTurnEvents = [];
        sess._currentTurnEvents.push({
          ts: toolEvent.timestamp,
          tool: toolEvent.tool,
          durationMs: toolEvent.durationMs,
          agentId: toolEvent.agentId,
          type: toolEvent.type,
          success: toolEvent.success,
        });
      }
    }
  }

  /** Update live session data from statusLine POST */
  updateLiveSession(data) {
    const id = data.session_id || 'unknown';
    const existing = this.data.liveSessions[id] || {};
    data._lastSeen = Date.now();
    data._startedAt = existing._startedAt || Date.now();
    data._fromStatusLine = true;
    // Origin: who spawned this session (claude-desktop / cli / claude-vscode).
    // Stamped by hook-forwarder from CLAUDE_CODE_ENTRYPOINT.
    data._entrypoint = data.entrypoint || existing._entrypoint || null;

    // Merge-not-clobber for model / context_window. A status post can legitimately
    // arrive WITHOUT these fields — e.g. a toolPiggyback post whose transcript parse
    // couldn't resolve the model, or a statusLine payload with empty fields. Because
    // we replace the session object wholesale below, an empty incoming post would
    // otherwise wipe previously-good values: the live tab's model dot + context gauge
    // blank to (none)/0%, and a session that then goes idle stays stuck there until a
    // fresh good post arrives (which never comes if it's quiet). Observed 2026-06-15
    // (session 2780e600 stuck at (none)/0% for 18 min; 0d1eced5 flickering). Carry the
    // last-known value forward instead.
    const incomingModel = data.model?.display_name || data.model?.id || '';
    if (!incomingModel && (existing.model?.display_name || existing.model?.id)) {
      data.model = existing.model;
    }
    const incomingCtxTokens = data.context_window?.total_input_tokens ?? 0;
    const incomingCtxPct = data.context_window?.used_percentage ?? 0;
    const incomingHasCtx = !!data.context_window && (incomingCtxTokens > 0 || incomingCtxPct > 0);
    if (!incomingHasCtx && existing.context_window) {
      data.context_window = existing.context_window;
    }

    // Plan-quota overlay: newer Claude Code builds include rate_limits
    // (five_hour / seven_day used_percentage + resets_at) in the statusline
    // payload after every API response — fresher than the 60s OAuth poll.
    // Dormant until this machine's CC version sends the field; the OAuth
    // poll remains the full source (per-model + extra-usage data).
    if (data.rate_limits && (data.rate_limits.five_hour || data.rate_limits.seven_day)) {
      this.overlayRateLimits(data.rate_limits);
    }
    // Preserve tool count from derived sessions
    if (existing._toolCount) data._toolCount = existing._toolCount;
    if (existing._lastTool) data._lastTool = existing._lastTool;

    // Preserve cost-at-last-turn-end for per-turn cost calculation
    if (existing._costAtLastTurnEnd != null) data._costAtLastTurnEnd = existing._costAtLastTurnEnd;

    // Context velocity tracking — recalculate percentage for extended-context models
    const modelDisplayName = data.model?.display_name || data.model?.id || '';
    const totalInputTokens = data.context_window?.total_input_tokens ?? 0;
    const resolvedCtxSize = resolveContextWindowSize(data.context_window?.context_window_size, modelDisplayName, totalInputTokens);
    const reportedCtxSize = data.context_window?.context_window_size;
    let newCtxPct = data.context_window?.used_percentage ?? 0;
    // Stamp resolved size onto context_window so frontend can use it directly
    if (data.context_window) {
      data.context_window._resolvedSize = resolvedCtxSize; // may be null
    }
    if (resolvedCtxSize && reportedCtxSize && resolvedCtxSize !== reportedCtxSize && totalInputTokens > 0) {
      newCtxPct = Math.min(100, Math.round((totalInputTokens / resolvedCtxSize) * 100));
      // Rewrite used_percentage to reflect real utilization. Without this,
      // surfaces reading used_percentage directly (CLI, legacy components)
      // show 100% on 1M-context sessions past the 200k mark.
      if (data.context_window) data.context_window.used_percentage = newCtxPct;
    }
    const ctxHistory = [...(existing._contextHistory || [])];
    ctxHistory.push({ pct: newCtxPct, ts: Date.now(), tokens: totalInputTokens });
    if (ctxHistory.length > MAX_CONTEXT_HISTORY) ctxHistory.shift();
    data._contextHistory = ctxHistory;

    // Context warning thresholds
    data._contextWarning = newCtxPct > 90 ? 'critical' : newCtxPct > 80 ? 'approaching' : null;

    // Detect model switches — suppress prefix-matched display name flicker
    // (e.g. "Opus" vs "Opus 4.6 (1M context)" from alternating statusLine posts)
    const newModel = data.model?.display_name || data.model?.id || '';
    const prevModel = existing._currentModel || '';
    const switches = [...(existing._modelSwitches || [])];
    let resolvedModel = newModel;
    if (prevModel && newModel && prevModel !== newModel) {
      if (prevModel.startsWith(newModel) || newModel.startsWith(prevModel)) {
        resolvedModel = prevModel.length >= newModel.length ? prevModel : newModel;
      } else {
        switches.push({ from: prevModel, to: newModel, ts: Date.now() });
      }
    }
    data._modelSwitches = switches;
    data._currentModel = resolvedModel;

    // Preserve turn tracking state from recordTurnEnd
    data._turnCount = existing._turnCount ?? 0;
    data._turnHistory = existing._turnHistory || [];
    data._currentTurnEvents = existing._currentTurnEvents || [];
    data._currentTurnStartTs = existing._currentTurnStartTs || null;
    data._tokensPerTurn = existing._tokensPerTurn ?? 0;
    data._estimatedTurnsRemaining = existing._estimatedTurnsRemaining ?? null;
    data._lastTurnCostDelta = existing._lastTurnCostDelta ?? 0;

    // Preserve compact tracking state
    data._compactEvents = existing._compactEvents || [];
    data._lastCompactAt = existing._lastCompactAt ?? null;

    // Preserve lifecycle event timestamps. These are stamped by recordTurnEnd
    // (_lastStopAt) and updatePrompt (_lastUserPromptAt). Without explicit
    // preservation here, every statusLine refresh would wipe them — which would
    // break the heartbeat's "between turns" detection (idle band rendering).
    data._lastStopAt = existing._lastStopAt ?? null;
    data._lastUserPromptAt = existing._lastUserPromptAt ?? null;
    data._lastLifecycleEvent = existing._lastLifecycleEvent ?? null;
    data._stopSeq = existing._stopSeq ?? 0;

    // Preserve subagent tracking state
    data._activeSubagents = existing._activeSubagents || {};
    data._subagentHistory = existing._subagentHistory || [];

    // Preserve prompt tracking state
    data._currentPrompt = existing._currentPrompt || null;
    data._promptHistory = existing._promptHistory || [];

    // Preserve per-model token counts (from hook-forwarder transcript parsing)
    if (!data._modelCosts && existing._modelCosts) data._modelCosts = existing._modelCosts;

    this.data.liveSessions[id] = data;
    this.emit('liveSession', { id, data });
  }

  /** Remove live sessions not seen in the last `maxAgeMs` */
  pruneStale(maxAgeMs = STALE_SESSION_MS) {
    // Sweep orphaned subagents before pruning sessions — otherwise a stuck
    // subagent's session could be deleted wholesale and the orphan would
    // never be recorded.
    this.sweepOrphanedSubagents();

    const cutoff = Date.now() - maxAgeMs;
    let changed = false;
    for (const [id, sess] of Object.entries(this.data.liveSessions)) {
      if ((sess._lastSeen || 0) < cutoff) {
        delete this.data.liveSessions[id];
        changed = true;
      }
    }
    if (changed) {
      this.data.timestamp = Date.now();
      this.emit('update', { liveSessions: this.data.liveSessions, timestamp: this.data.timestamp });
    }
  }

  /**
   * Detect subagents that never emitted SubagentStop. Moves them into
   * _subagentHistory with status:'orphaned' and writes a failure-store row
   * so the Failures tab reflects the loss. Idle threshold = time since last
   * tool event from the agent (or start time if no tool event ever fired).
   *
   * Runs from pruneStale() on the server's periodic timer. Safe to call
   * repeatedly — already-removed agents are simply not present.
   */
  sweepOrphanedSubagents(maxIdleMs = SUBAGENT_ORPHAN_MS) {
    const now = Date.now();
    let anyOrphaned = false;
    for (const [sessionId, sess] of Object.entries(this.data.liveSessions)) {
      const active = sess._activeSubagents;
      if (!active || Object.keys(active).length === 0) continue;

      const history = sess._subagentHistory || [];
      for (const [agentId, agent] of Object.entries(active)) {
        const lastSignal = agent._lastToolAt || agent.startedAt || 0;
        const idleMs = now - lastSignal;
        if (idleMs < maxIdleMs) continue;

        history.push({
          agentId,
          type: agent.type,
          description: agent.description || '',
          model: agent.model || '',
          modelId: '',
          startedAt: agent.startedAt,
          endedAt: null,
          durationMs: null,
          lastMessage: '',
          transcriptPath: '',
          toolCount: agent._toolCount || 0,
          lastTool: agent._lastTool || '',
          tokens: null,
          cost: null,
          costEstimated: false,
          turns: null,
          status: 'orphaned',
          spannedCompactAt: agent._spannedCompactAt || null,
          orphanedAfterMs: idleMs,
          // Carry C1/C3 counters so the orphaned row still shows fails/blocks
          failureCount: agent._failureCount || 0,
          lastError: agent._lastError || null,
          validationBlockCount: agent._validationBlockCount || 0,
          // Orphaned agents never had a SubagentStop, so transcript never parsed
          transcriptStatus: 'missing',
          parentAgentId: agent.parentAgentId || null,
          // V2 — carry prompt through orphan sweep
          prompt: agent.prompt || '',
          permissionMode: null,
        });
        delete active[agentId];
        anyOrphaned = true;

        const promptCtx = this._promptContextFor(sessionId);
        this.failureStore.append({
          sessionId,
          toolName: 'Agent',
          eventType: 'subagent_orphaned',
          error: `No SubagentStop received within ${Math.round(idleMs / 60_000)} min — may be compaction, parent interrupt, or dropped hook`,
          toolInput: {
            agent_id: agentId,
            agent_type: agent.type,
            description: agent.description || '',
            startedAt: agent.startedAt,
            lastTool: agent._lastTool || '',
            toolCount: agent._toolCount || 0,
            spannedCompactAt: agent._spannedCompactAt || null,
          },
          cwd: sess.workspace?.current_dir || '',
          durationMs: idleMs,
          promptId: promptCtx.promptId,
          promptSnippet: promptCtx.promptSnippet,
        });
      }

      if (history.length > MAX_SUBAGENT_HISTORY) {
        sess._subagentHistory = history.slice(-MAX_SUBAGENT_HISTORY);
      } else {
        sess._subagentHistory = history;
      }
      sess._activeSubagents = active;

      this.emit('subagentUpdate', {
        sessionId,
        action: 'orphan-sweep',
        agentId: null,
        activeSubagents: sess._activeSubagents,
        subagentHistory: sess._subagentHistory,
      });
    }
    return anyOrphaned;
  }

  /**
   * Update statusLine state. Emits 'statusLineState' event only if the class
   * or stalled flag actually changed (prevents broadcast spam from the file
   * watcher when it re-reads settings and classification is unchanged).
   */
  updateStatusLineState(next) {
    const prev = this.data.statusLineState;
    const merged = {
      ...prev,
      ...next,
      lastCheckedAt: Date.now(),
    };
    const classChanged = prev.class !== merged.class;
    const stalledChanged = prev.stalled !== merged.stalled;
    this.data.statusLineState = merged;
    if (classChanged || stalledChanged) {
      this.emit('statusLineState', merged);
    }
  }

  /** Record an incoming statusLine-sourced POST for stall detection. */
  recordStatusLinePost() {
    this._toolEventsSinceLastStatusPost = 0;
    const prev = this.data.statusLineState;
    const wasStalled = prev.stalled;
    this.data.statusLineState = {
      ...prev,
      lastStatusPostAt: Date.now(),
      stalled: false,
    };
    if (wasStalled) {
      this.emit('statusLineState', this.data.statusLineState);
    }
  }

  /** Manual refresh: aggressively prune sessions not seen recently */
  forceRefresh() {
    const cutoff = Date.now() - FORCE_REFRESH_MS;
    let pruned = 0;
    for (const [id, sess] of Object.entries(this.data.liveSessions)) {
      if ((sess._lastSeen || 0) < cutoff) {
        delete this.data.liveSessions[id];
        pruned++;
      }
    }
    this.data.timestamp = Date.now();
    // Always emit update so frontend gets fresh state (even if no sessions pruned)
    this.emit('update', { liveSessions: this.data.liveSessions, timestamp: this.data.timestamp });
    return { pruned, remaining: Object.keys(this.data.liveSessions).length };
  }

  /**
   * Mark a session ended (SessionEnd hook). Deliberately does NOT remove the
   * entry — sessions linger until the stale prune (user preference: the
   * refresh button handles immediate cleanup). The flag lets the UI render an
   * ended state instead of "idle".
   */
  markSessionEnded(sessionId) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];
    if (!session) return;
    session._ended = true;
    session._endedAt = Date.now();
    session._awaitingPermission = null;
    session._lastLifecycleEvent = 'session-end';
    // Do NOT bump _lastSeen — an ended session should age toward the stale
    // prune from its last real activity, not from the end notification.
    this.emit('liveSession', { id, data: session });
  }

  /**
   * Mark a session as waiting on a permission decision (PermissionRequest
   * hook). Cleared by the next tool event / prompt / turn end — whichever
   * follows the user's decision.
   */
  markAwaitingPermission(sessionId, toolName) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];
    if (!session) return;
    session._awaitingPermission = { tool: toolName || null, since: Date.now() };
    session._lastSeen = Date.now();
    this.emit('liveSession', { id, data: session });
  }

  /** Record a turn end from Stop hook */
  recordTurnEnd(sessionId, data) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];
    if (!session) return;

    session._awaitingPermission = null;
    session._lastSeen = Date.now();
    session._turnCount = (session._turnCount || 0) + 1;
    session._lastStopAt = Date.now();
    session._stopSeq = (session._stopSeq || 0) + 1;
    session._lastLifecycleEvent = 'stop';

    // Per-turn cost: difference between current cumulative cost and cost at previous turn end
    const currentCost = session.cost?.total_cost_usd ?? 0;
    const costAtLastTurnEnd = session._costAtLastTurnEnd ?? 0;
    const turnCost = Math.max(0, currentCost - costAtLastTurnEnd);
    session._costAtLastTurnEnd = currentCost;
    session._lastTurnCostDelta = turnCost;

    // Snapshot context percentage at turn end
    const ctxPct = session.context_window?.used_percentage ?? 0;
    const totalTokens = session.context_window?.total_input_tokens ?? 0;

    const turnEvents = session._currentTurnEvents || [];
    const turnStartTs = session._currentTurnStartTs || (turnEvents.length > 0 ? turnEvents[0].ts : Date.now());
    const turnEndTs = Date.now();
    const toolTimeMs = turnEvents.reduce((sum, e) => sum + (e.durationMs || 0), 0);

    const history = session._turnHistory || [];
    history.push({
      turn: session._turnCount,
      cost: turnCost,
      ctxPct,
      tokens: totalTokens,
      ts: turnEndTs,
      compact: false,
      startTs: turnStartTs,
      durationMs: turnEndTs - turnStartTs,
      toolTimeMs,
      toolCount: turnEvents.length,
      events: turnEvents.slice(-100),
    });
    session._currentTurnEvents = [];
    if (history.length > MAX_TURN_HISTORY) history.shift();
    session._turnHistory = history;

    // Compute average tokens per turn from context history deltas
    if (history.length >= 2) {
      const tokenDeltas = [];
      for (let i = 1; i < history.length; i++) {
        if (!history[i].compact && !history[i - 1].compact) {
          const delta = history[i].tokens - history[i - 1].tokens;
          if (delta > 0) tokenDeltas.push(delta);
        }
      }
      if (tokenDeltas.length > 0) {
        session._tokensPerTurn = Math.round(tokenDeltas.reduce((a, b) => a + b, 0) / tokenDeltas.length);
        const modelName = session.model?.display_name || session._currentModel || '';
        const contextLimit = resolveContextWindowSize(session.context_window?.context_window_size, modelName, totalTokens);
        if (contextLimit && session._tokensPerTurn > 0) {
          const remaining = contextLimit - totalTokens;
          session._estimatedTurnsRemaining = Math.max(0, Math.round(remaining / session._tokensPerTurn));
        } else {
          session._estimatedTurnsRemaining = null;
        }
      }
    }

    const turnData = {
      sessionId: id,
      turn: session._turnCount,
      cost: turnCost,
      ctxPct,
      tokensPerTurn: session._tokensPerTurn,
      turnsRemaining: session._estimatedTurnsRemaining,
    };

    this.emit('turnEnd', turnData);
  }

  /** Record a compact event from PreCompact hook */
  recordCompact(sessionId, data) {
    const id = sessionId || 'unknown';
    // Auto-create a thin live session entry if PreCompact arrives before
    // any statusLine or tool event has minted one. Otherwise the compaction
    // would be silently dropped — which is exactly how finding #3 stayed
    // invisible for weeks.
    if (!this.data.liveSessions[id]) {
      this.data.liveSessions[id] = {
        session_id: id,
        _startedAt: Date.now(),
        _fromCompactEvent: true,
        _compactEvents: [],
        _lastCompactAt: null,
        _turnHistory: [],
        _turnCount: 0,
        context_window: {},
      };
    }
    const session = this.data.liveSessions[id];

    session._lastSeen = Date.now();
    const ctxPct = session.context_window?.used_percentage ?? 0;
    const event = {
      ts: Date.now(),
      trigger: data.trigger || 'auto',
      ctxPct,
    };

    const events = session._compactEvents || [];
    events.push(event);
    session._compactEvents = events;
    session._lastCompactAt = Date.now();

    // Stamp every currently-active subagent so the UI can flag "this agent's
    // lifetime crossed a compaction" — a common failure mode where the
    // post-compaction parent may not emit SubagentStop for the original agent.
    const active = session._activeSubagents || {};
    for (const agent of Object.values(active)) {
      agent._spannedCompactAt = [...(agent._spannedCompactAt || []), Date.now()];
    }

    // Mark in turn history
    const history = session._turnHistory || [];
    history.push({
      turn: session._turnCount || 0,
      cost: 0,
      ctxPct,
      tokens: session.context_window?.total_input_tokens ?? 0,
      ts: Date.now(),
      compact: true,
      trigger: event.trigger,
    });
    if (history.length > MAX_TURN_HISTORY) history.shift();
    session._turnHistory = history;

    this.emit('compactEvent', { sessionId: id, ...event });
  }

  /** Update current prompt from UserPromptSubmit hook */
  updatePrompt(sessionId, promptText) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];
    if (!session) return;

    session._lastSeen = Date.now();
    session._currentPrompt = promptText;
    session._lastUserPromptAt = Date.now();
    session._currentTurnStartTs = Date.now();
    session._currentTurnEvents = [];
    session._lastLifecycleEvent = 'prompt';
    // New prompt = the user is here: clear ended/awaiting-permission states
    session._awaitingPermission = null;
    if (session._ended) { session._ended = false; session._endedAt = null; }
    // Fresh user prompt resets the consecutive-continuation streak — any
    // prior Stop-hook back-and-forth was resolved by the user giving new input.
    session._consecutiveForcedContinuations = 0;
    const history = session._promptHistory || [];
    history.push({ text: promptText, ts: Date.now() });
    if (history.length > MAX_PROMPT_HISTORY) history.shift();
    session._promptHistory = history;

    this.emit('promptUpdate', { sessionId: id, prompt: promptText, history });
  }

  /** Add a subagent from SubagentStart hook */
  addSubagent(sessionId, data) {
    const id = sessionId || 'unknown';
    let session = this.data.liveSessions[id];

    // Auto-create live session if it doesn't exist yet
    // (SubagentStart can fire before statusLine or tool events)
    if (!session) {
      session = {
        session_id: id,
        _lastSeen: Date.now(),
        _startedAt: Date.now(),
        _fromSubagentEvent: true,
        _activeSubagents: {},
        _subagentHistory: [],
        model: { display_name: 'Active' },
        cost: { total_cost_usd: 0 },
        workspace: { current_dir: data.cwd || '' },
      };
      this.data.liveSessions[id] = session;
      this.emit('liveSession', { id, data: session });
    }

    session._lastSeen = Date.now();
    const agentId = data.agent_id || `agent-${Date.now()}`;
    if (!session._activeSubagents) session._activeSubagents = {};
    session._activeSubagents[agentId] = {
      type: data.agent_type || 'unknown',
      description: data.description || '',
      model: data.model || '',
      startedAt: Date.now(),
      _toolCount: 0,
      _lastTool: '',
      _lastToolAt: null,
      _spannedCompactAt: null,
      // C1/C3 — per-agent failure + validation-block counters start at zero
      _failureCount: 0,
      _lastError: null,
      _validationBlockCount: 0,
      // E1 — parent/child nesting. null if Claude Code didn't provide one.
      parentAgentId: data.parent_agent_id || null,
      // V2 — prompt from transcript line 1, transcript paths
      prompt: data.prompt || '',
      agentTranscriptPath: data.agent_transcript_path || '',
      // V2 — live telemetry (updated via tool events with _agentLiveMetrics)
      _liveCost: null,
      _liveContextPct: null,
      _liveContextTokens: null,
      _liveModel: null,
      _liveTurns: null,
    };

    this.emit('subagentUpdate', {
      sessionId: id,
      action: 'start',
      agentId,
      activeSubagents: session._activeSubagents,
      subagentHistory: session._subagentHistory || [],
    });
  }

  /** Remove a subagent from SubagentStop hook */
  removeSubagent(sessionId, data) {
    const id = sessionId || 'unknown';
    let session = this.data.liveSessions[id];
    if (!session) {
      // Session may not exist if SubagentStart was missed — create minimal session
      session = {
        session_id: id,
        _lastSeen: Date.now(),
        _startedAt: Date.now(),
        _fromSubagentEvent: true,
        _activeSubagents: {},
        _subagentHistory: [],
        model: { display_name: 'Active' },
        cost: { total_cost_usd: 0 },
        workspace: { current_dir: data.cwd || '' },
      };
      this.data.liveSessions[id] = session;
      this.emit('liveSession', { id, data: session });
    }

    session._lastSeen = Date.now();
    const agentId = data.agent_id || '';
    const active = session._activeSubagents || {};
    const agent = active[agentId];

    const history = session._subagentHistory || [];
    const metrics = data._transcriptMetrics || {};

    if (agent) {
      // Move from active to history with full details + transcript metrics
      const transcriptCost = metrics.cost?.total_cost_usd || null;
      let finalCost = transcriptCost;
      let costEstimated = false;

      // Fallback: estimate cost from context window token delta if transcript didn't provide it
      if (finalCost === null && agent.startedAt && session._contextHistory?.length >= 2) {
        const startTs = agent.startedAt;
        const endTs = Date.now();
        const ctxHistory = session._contextHistory;
        // Find closest snapshots bracketing the agent's active window
        let startSnapshot = null;
        let endSnapshot = null;
        for (const snap of ctxHistory) {
          if (snap.ts <= startTs) startSnapshot = snap;
          if (snap.ts <= endTs) endSnapshot = snap;
        }
        if (startSnapshot && endSnapshot && endSnapshot.tokens > startSnapshot.tokens) {
          const tokenDelta = endSnapshot.tokens - startSnapshot.tokens;
          const modelId = session._currentModel || session.model?.display_name || session.model?.id || '';
          finalCost = estimateCost(modelId, { input: tokenDelta });
          costEstimated = true;
        }
      }

      history.push({
        agentId,
        type: agent.type,
        description: agent.description || '',
        model: metrics.model?.display_name || agent.model || '',
        modelId: metrics.model?.id || '',
        startedAt: agent.startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - agent.startedAt,
        lastMessage: data.last_assistant_message || '',
        transcriptPath: data.agent_transcript_path || '',
        toolCount: agent._toolCount || 0,
        lastTool: agent._lastTool || '',
        tokens: metrics.tokens || null,
        cost: finalCost,
        costEstimated,
        turns: metrics.turns || null,
        status: 'completed',
        spannedCompactAt: agent._spannedCompactAt || null,
        // C1/C3 — surface the per-agent counters on the history entry
        failureCount: agent._failureCount || 0,
        lastError: agent._lastError || null,
        validationBlockCount: agent._validationBlockCount || 0,
        // C2 — transcript parse status ('ok' if metrics populated, 'missing' / 'parse_failed' otherwise)
        transcriptStatus: metrics.status || (metrics.tokens ? 'ok' : 'missing'),
        // E1 — carry parent linkage through
        parentAgentId: agent.parentAgentId || null,
        // V2 — prompt + permission mode
        prompt: agent.prompt || data.prompt || '',
        permissionMode: data.permission_mode || null,
      });
      delete active[agentId];
    } else {
      // SubagentStart was missed — create history entry from stop data + transcript
      const transcriptCost = metrics.cost?.total_cost_usd || null;
      history.push({
        agentId,
        type: data.agent_type || 'unknown',
        description: '',
        model: metrics.model?.display_name || '',
        modelId: metrics.model?.id || '',
        startedAt: null,
        endedAt: Date.now(),
        durationMs: null,
        lastMessage: data.last_assistant_message || '',
        transcriptPath: data.agent_transcript_path || '',
        toolCount: 0,
        lastTool: '',
        tokens: metrics.tokens || null,
        cost: transcriptCost,
        costEstimated: false,
        turns: metrics.turns || null,
        failureCount: 0,
        lastError: null,
        validationBlockCount: 0,
        transcriptStatus: metrics.status || (metrics.tokens ? 'ok' : 'missing'),
        // V2 — prompt + permission mode (from SubagentStop data)
        prompt: data.prompt || '',
        permissionMode: data.permission_mode || null,
      });
    }
    if (history.length > MAX_SUBAGENT_HISTORY) history.shift();
    session._subagentHistory = history;
    session._activeSubagents = active;

    this.emit('subagentUpdate', {
      sessionId: id,
      action: 'stop',
      agentId,
      activeSubagents: session._activeSubagents,
      subagentHistory: session._subagentHistory,
    });
  }

  /**
   * Record a config change from ConfigChange hook.
   *
   * ConfigChange events are persisted to the failure store (with
   * eventType:'config_change') so they render on the Failures tab — NOT
   * because they're failures, but because config drift is the single most
   * common cause of "why did my hooks stop working?" mysteries and that tab
   * is the observability surface. Also kept on the live session for
   * per-session display.
   */
  recordConfigChange(sessionId, data) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];

    const event = {
      ts: Date.now(),
      config_path: data.config_path || '',
      changes: data.changes || {},
    };

    if (session) {
      // No _lastSeen update — ConfigChange is passive (fires on ALL sessions
      // when any session modifies settings.json) and must not prevent pruning.
      const events = session._configChanges || [];
      events.push(event);
      if (events.length > 20) events.shift();
      session._configChanges = events;
    }

    // Persist cross-session via the failure store so the event survives
    // server restarts and appears on the Failures tab for the session.
    const configPath = data.config_path || 'unknown path';
    const changeSummary = typeof data.changes === 'object'
      ? Object.keys(data.changes || {}).join(', ').slice(0, 200)
      : String(data.changes || '').slice(0, 200);
    const cfgPromptCtx = this._promptContextFor(id);
    this.failureStore.append({
      sessionId: id,
      toolName: 'Config',
      eventType: 'config_change',
      error: `Settings modified: ${configPath}${changeSummary ? ` (${changeSummary})` : ''}`,
      toolInput: {
        config_path: data.config_path || '',
        changes: data.changes || {},
      },
      cwd: session?.workspace?.current_dir || '',
      durationMs: null,
      promptId: cfgPromptCtx.promptId,
      promptSnippet: cfgPromptCtx.promptSnippet,
    });

    this.emit('configChange', { sessionId: id, event });
  }

  /** Record a task completion from TaskCompleted hook */
  recordTaskCompleted(sessionId, data) {
    const id = sessionId || 'unknown';
    const session = this.data.liveSessions[id];
    if (!session) return;

    // No _lastSeen update — passive event, must not prevent pruning.
    const tasks = session._completedTasks || [];
    tasks.push({
      ts: Date.now(),
      task_id: data.task_id || '',
      task_description: data.task_description || '',
      status: data.status || 'completed',
    });
    // Keep last 50 task completions per session
    if (tasks.length > 50) tasks.shift();
    session._completedTasks = tasks;

    this.emit('taskCompleted', { sessionId: id, task: tasks[tasks.length - 1] });
  }

  /** Update plan info (type, display mode, usage) from plan-detector */
  updatePlanInfo(info) {
    this.data.planInfo = { ...this.data.planInfo, ...info, lastUpdated: Date.now() };
    this.emit('planInfo', this.data.planInfo);
  }

  /**
   * Overlay statusline-sourced rate limits onto planInfo.usage.
   * statusline shape: { five_hour: { used_percentage, resets_at<epoch s> }, seven_day: {...} }
   * planInfo shape:   { fiveHour: { utilization, resets_at<ISO> }, sevenDay: {...} }
   * Only the 5h/7d gauges are overlaid — per-model and extra-usage data still
   * come from the OAuth poll. Statusline data arrives after every API
   * response, so this keeps the headline gauges fresh between polls.
   */
  overlayRateLimits(rateLimits) {
    const usage = { ...(this.data.planInfo.usage || {}) };
    const mapWindow = (w) => ({
      utilization: typeof w.used_percentage === 'number' ? w.used_percentage : null,
      resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
    });
    let changed = false;
    if (rateLimits.five_hour && typeof rateLimits.five_hour.used_percentage === 'number') {
      usage.fiveHour = { ...usage.fiveHour, ...mapWindow(rateLimits.five_hour) };
      changed = true;
    }
    if (rateLimits.seven_day && typeof rateLimits.seven_day.used_percentage === 'number') {
      usage.sevenDay = { ...usage.sevenDay, ...mapWindow(rateLimits.seven_day) };
      changed = true;
    }
    if (!changed) return;
    this.data.planInfo = {
      ...this.data.planInfo,
      usage,
      usageSource: 'statusline',
      usageTimestamp: Date.now(),
      lastUpdated: Date.now(),
    };
    this.emit('planInfo', this.data.planInfo);
  }

  /** Get full snapshot for initial load */
  getSnapshot() {
    return { ...this.data };
  }
}

export { Store };
export const store = new Store();