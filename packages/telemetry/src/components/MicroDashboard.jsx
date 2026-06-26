// Compact HUD for PiP / narrow windows — shows essentials at a glance
// Priority order: Context → Agents → Tools → Turns → Cost/Model

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDuration(ms) {
  if (!ms) return '\u2014';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
}

function formatToolName(raw) {
  if (!raw) return '?';
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    const action = parts.length >= 3 ? parts.slice(2).join('__') : parts[parts.length - 1];
    return action.replace(/^preview_/, '');
  }
  return raw;
}

function getToolSummary(event) {
  const input = event?.input;
  if (!input) return '';
  if (typeof input === 'string') {
    const normalized = input.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : input.slice(0, 50);
  }
  if (typeof input === 'object') {
    if (input.description) return input.description;
    if (input.command) return input.command.slice(0, 50);
    if (input.file_path) {
      const p = input.file_path.replace(/\\/g, '/').split('/');
      return p.length > 2 ? p.slice(-2).join('/') : input.file_path;
    }
    if (input.pattern) return input.pattern;
    if (input.query) return input.query.slice(0, 50);
    return '';
  }
  return '';
}

function ExpandIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h8v8" />
      <path d="M14 2L2 14" />
    </svg>
  );
}

function getProjectName(liveSession) {
  const cwd = liveSession?.workspace?.current_dir || '';
  return cwd ? cwd.split(/[\\/]/).pop() : null;
}

export default function MicroDashboard({
  liveSession,
  session,
  toolEvents = [],
  sessionActivity,
  sessionId,
  onExpand,
  displayMode = 'cost',
  windowWidth = 380,
  sessionIds = [],
  liveSessions = {},
  onSessionChange,
}) {
  const tier = windowWidth >= 600 ? 'wide' : windowWidth >= 420 ? 'medium' : 'compact';
  const hasData = !!(liveSession || session);

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-gray-500 text-xs">
        No active session
      </div>
    );
  }

  // Status
  const isProcessing = sessionActivity?.[sessionId] === 'processing';
  const statusLabel = isProcessing ? 'Processing' : 'Idle';
  const statusColor = isProcessing ? 'text-green' : 'text-blue';
  const dotClass = isProcessing ? 'bg-green animate-pulse-dot' : 'bg-blue';

  // Model + Cost
  const modelName = liveSession?.model?.display_name || liveSession?._currentModel || session?.primaryModel || '?';
  const cost = liveSession?.cost?.total_cost_usd ?? session?.cost ?? 0;
  const isTokenMode = displayMode === 'tokens';

  // Context (Priority 1)
  const ctxPct = liveSession?.context_window?.used_percentage ?? 0;
  const ctxSize = liveSession?.context_window?._resolvedSize ?? liveSession?.context_window?.context_window_size ?? null;
  const totalTokens = liveSession?.context_window?.total_input_tokens ?? 0;
  const turnsLeft = liveSession?._estimatedTurnsRemaining ?? null;
  const barColor = ctxPct > 80 ? 'bg-red' : ctxPct > 50 ? 'bg-amber' : 'bg-accent';
  const pctColor = ctxPct > 80 ? 'text-red' : ctxPct > 50 ? 'text-amber' : 'text-gray-200';
  const turnsColor = turnsLeft !== null && turnsLeft <= 3 ? 'text-red' : turnsLeft !== null && turnsLeft <= 8 ? 'text-amber' : 'text-gray-300';

  // Agents (Priority 2)
  const activeSubagents = liveSession?._activeSubagents || {};
  const activeAgents = Object.keys(activeSubagents).length;
  const subagentHistory = liveSession?._subagentHistory || [];
  const completedAgents = subagentHistory.length;
  const lastAgent = subagentHistory[subagentHistory.length - 1] || null;
  // Find most recent active agent for display
  const activeAgentEntries = Object.entries(activeSubagents);
  const currentAgent = activeAgentEntries.length > 0 ? activeAgentEntries[activeAgentEntries.length - 1] : null;

  // Tools (Priority 3)
  const toolCount = liveSession?._toolCount || 0;
  const lastToolName = formatToolName(liveSession?._lastTool || '');
  const filteredEvents = toolEvents.filter(e => e.session === sessionId);
  const lastEvent = filteredEvents[0] || null;
  const lastToolSummary = lastEvent ? getToolSummary(lastEvent) : '';
  const lastToolFailed = lastEvent && (lastEvent.status === 'error' || lastEvent.error);
  const lastToolBlocked = lastEvent && lastEvent.status === 'blocked';

  // Error counts from recent events
  const errorCount = filteredEvents.filter(e => e.status === 'error' || e.error).length;
  const blockedCount = filteredEvents.filter(e => e.status === 'blocked').length;

  // Turns / Velocity (Priority 4)
  const turnCount = liveSession?._turnCount ?? 0;
  const tokPerTurn = liveSession?._tokensPerTurn ?? 0;

  // Duration + Lines (Priority 5)
  const durationMs = liveSession?.cost?.total_duration_ms ?? session?.durationMs ?? 0;
  const linesAdded = liveSession?.cost?.total_lines_added ?? session?.linesAdded ?? 0;
  const linesRemoved = liveSession?.cost?.total_lines_removed ?? session?.linesRemoved ?? 0;

  // Token totals for token mode
  const usage = liveSession?.context_window?.current_usage;
  const totalTok = usage
    ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    : session?.tokens?.total ?? 0;

  // Token breakdown for medium+ tiers
  const inputTok = usage?.input_tokens || 0;
  const outputTok = usage?.output_tokens || 0;
  const cacheReadTok = usage?.cache_read_input_tokens || 0;
  const cacheWriteTok = usage?.cache_creation_input_tokens || 0;

  // Recent tool events for wide tier
  const recentEvents = filteredEvents.slice(0, 5);

  // Tab switching: build list of switchable sessions
  const canSwitchTabs = sessionIds.length > 1 && onSessionChange;

  return (
    <div className="border border-gray-800 rounded-lg bg-gray-950 p-2 text-xs font-mono space-y-1.5 select-none">

      {/* Tab switcher (when multiple live sessions) */}
      {canSwitchTabs && (
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 -mx-1 px-1">
          {sessionIds.map((id) => {
            const s = liveSessions[id];
            const name = getProjectName(s) || id.slice(0, 8);
            const active = id === sessionId;
            const processing = sessionActivity?.[id] === 'processing';
            return (
              <button
                key={id}
                onClick={() => onSessionChange(id)}
                title={name}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 transition-colors ${
                  active
                    ? 'bg-gray-800 text-gray-100'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                  processing ? 'bg-green animate-pulse-dot' : 'bg-blue'
                }`} />
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* Row 1: ●projectname | Model | Cost/Tokens | Duration | Lines | Expand
          Status label ("Processing"/"Idle") is now dot-only with tooltip — the
          project name takes the reclaimed space so single-session micro views
          can still tell you what session they're showing. */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-1.5 min-w-0 shrink"
          title={`${getProjectName(liveSession) || sessionId?.slice(0,8) || 'Session'} \u2014 ${statusLabel.toLowerCase()}`}
        >
          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
          <span className={`font-semibold truncate ${statusColor}`}>
            {getProjectName(liveSession) || sessionId?.slice(0,8) || statusLabel}
          </span>
        </span>
        <span className="text-accent font-semibold shrink-0" title={`Primary model: ${modelName}`}>{modelName}</span>
        <span
          className="text-green font-semibold"
          title={isTokenMode
            ? `Total tokens: ${totalTok.toLocaleString()}`
            : `Session cost: $${cost.toFixed(4)} (${formatTokens(totalTok)} total tokens)`}
        >
          {isTokenMode ? formatTokens(totalTok) : `$${cost.toFixed(2)}`}
        </span>
        {tier !== 'compact' && durationMs > 0 && (
          <span className="text-gray-400" title={`Session duration: ${formatDuration(durationMs)}`}>
            {formatDuration(durationMs)}
          </span>
        )}
        {tier !== 'compact' && (linesAdded > 0 || linesRemoved > 0) && (
          <span className="text-amber" title={`Lines changed: +${linesAdded} / -${linesRemoved}`}>
            +{linesAdded}{linesRemoved > 0 && `/-${linesRemoved}`}
          </span>
        )}
        {onExpand && (
          <button onClick={onExpand} title="Expand to full dashboard"
            className="text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded p-0.5 transition-colors">
            <ExpandIcon />
          </button>
        )}
      </div>

      {/* Row 2: Context bar */}
      <div className="space-y-0.5"
        title={`Context window: ${ctxPct}% used (${formatTokens(totalTokens)} / ${ctxSize ? formatTokens(ctxSize) : '?'})${turnsLeft !== null ? ` \u2014 ~${turnsLeft} turns remaining` : ''}`}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase text-gray-500 shrink-0 tracking-wider">Context</span>
          <div className="flex-1 h-2.5 bg-gray-800 rounded-full relative overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${Math.min(ctxPct, 100)}%` }} />
            <div className="absolute top-0 bottom-0 w-px bg-amber/40" style={{ left: '80%' }} title="80% warning threshold" />
            <div className="absolute top-0 bottom-0 w-px bg-red/40" style={{ left: '95%' }} title="95% critical threshold" />
          </div>
          <span className={`font-bold text-sm tabular-nums ${pctColor}`}>{ctxPct}%</span>
          {turnsLeft !== null && (
            <span className={`text-[10px] ${turnsColor} shrink-0`} title={`~${turnsLeft} turns remaining before context limit`}>
              ~{turnsLeft}t
            </span>
          )}
        </div>
      </div>

      {/* Medium+: Token breakdown */}
      {tier !== 'compact' && totalTokens > 0 && (
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-gray-300" title={`Input: ${formatTokens(inputTok)}`}>In:{formatTokens(inputTok)}</span>
          <span className="text-green" title={`Output: ${formatTokens(outputTok)}`}>Out:{formatTokens(outputTok)}</span>
          {cacheReadTok > 0 && <span className="text-cyan" title={`Cache read: ${formatTokens(cacheReadTok)}`}>CR:{formatTokens(cacheReadTok)}</span>}
          {cacheWriteTok > 0 && <span className="text-amber" title={`Cache write: ${formatTokens(cacheWriteTok)}`}>CW:{formatTokens(cacheWriteTok)}</span>}
        </div>
      )}

      {/* Row 3: Agents + Tools counts + (medium+: turn/velocity) */}
      <div className="space-y-0.5">
        <div className="flex items-center gap-3 flex-wrap">
          <span title={`${activeAgents} subagent${activeAgents !== 1 ? 's' : ''} running, ${completedAgents} completed`}>
            <span className="text-[10px] uppercase text-gray-500">Agents </span>
            <span className="text-green font-semibold">{activeAgents}</span>
            {completedAgents > 0 && <span className="text-gray-600"> ({completedAgents} done)</span>}
          </span>
          <span className="text-gray-700">|</span>
          <span title={`${toolCount} tool calls this session${errorCount ? ` (${errorCount} errors)` : ''}${blockedCount ? ` (${blockedCount} blocked)` : ''}`}>
            <span className="text-[10px] uppercase text-gray-500">Tools </span>
            <span className="text-gray-300 font-semibold">{toolCount}</span>
            {errorCount > 0 && <span className="text-red ml-1" title={`${errorCount} tool errors`}>{errorCount}err</span>}
            {blockedCount > 0 && <span className="text-amber ml-1" title={`${blockedCount} blocked by validation`}>{blockedCount}blk</span>}
          </span>
          {tier !== 'compact' && turnCount > 0 && (
            <>
              <span className="text-gray-700">|</span>
              <span title={`${turnCount} completed turns`}>
                <span className="text-[10px] uppercase text-gray-500">Turn </span>
                <span className="text-gray-200 font-semibold">{turnCount}</span>
              </span>
              {tokPerTurn > 0 && (
                <span title={`Average ${formatTokens(tokPerTurn)} tokens per turn`}>
                  <span className="text-gray-400">~{formatTokens(tokPerTurn)}/turn</span>
                </span>
              )}
            </>
          )}
        </div>

        {/* Last tool line */}
        {lastToolName && lastToolName !== '?' && (
          <div className={`truncate ${lastToolFailed ? 'text-red' : lastToolBlocked ? 'text-amber' : 'text-gray-500'}`}
            title={`Last tool: ${lastToolName}${lastToolSummary ? ' \u2014 ' + lastToolSummary : ''}${lastToolFailed ? ' (FAILED)' : lastToolBlocked ? ' (BLOCKED)' : ''}`}>
            {lastToolFailed && <span className="text-red font-semibold">! </span>}
            {lastToolBlocked && <span className="text-amber font-semibold">! </span>}
            Last tool: <span className={lastToolFailed ? 'text-red' : lastToolBlocked ? 'text-amber' : 'text-gray-400'}>{lastToolName}</span>
            {lastToolSummary && <span className="text-gray-600"> {lastToolSummary}</span>}
          </div>
        )}

        {/* Last/current agent line */}
        {currentAgent && (() => {
          const [, agent] = currentAgent;
          const elapsed = formatDuration(Date.now() - agent.startedAt);
          return (
            <div className="text-green truncate" title={`Active agent: ${agent.type} — ${agent.description} (${agent.model || '?'}, running ${elapsed})`}>
              Agent: <span className="text-green font-semibold">{agent.type}</span>
              <span className="text-gray-500"> {agent.description}</span>
              <span className="text-gray-600"> ({agent.model || '?'}, {elapsed})</span>
            </div>
          );
        })()}
        {!currentAgent && lastAgent && (
          <div className="text-gray-500 truncate" title={`Last agent: ${lastAgent.type} — ${lastAgent.description} (${lastAgent.model || '?'}, ${formatDuration(lastAgent.durationMs)})`}>
            Last agent: <span className="text-gray-400">{lastAgent.type}</span>
            <span className="text-gray-600"> {lastAgent.description}</span>
            <span className="text-gray-600"> ({lastAgent.model || '?'}, {formatDuration(lastAgent.durationMs)})</span>
          </div>
        )}
      </div>

      {/* Compact only: turn/velocity/duration/lines on own row */}
      {tier === 'compact' && (
        <div className="flex items-center gap-3 flex-wrap text-[10px]">
          {turnCount > 0 && (
            <span title={`${turnCount} completed turns`}>
              <span className="uppercase text-gray-500">Turn </span>
              <span className="text-gray-200 font-semibold">{turnCount}</span>
            </span>
          )}
          {tokPerTurn > 0 && (
            <span title={`Average ${formatTokens(tokPerTurn)} tokens per turn`}>
              <span className="text-gray-400">~{formatTokens(tokPerTurn)}/turn</span>
            </span>
          )}
          {durationMs > 0 && (
            <span className="text-gray-400" title={`Session duration: ${formatDuration(durationMs)}`}>
              {formatDuration(durationMs)}
            </span>
          )}
          {(linesAdded > 0 || linesRemoved > 0) && (
            <span className="text-amber" title={`Lines changed: +${linesAdded} / -${linesRemoved}`}>
              +{linesAdded}{linesRemoved > 0 && `/-${linesRemoved}`}
            </span>
          )}
        </div>
      )}

      {/* Medium+: cost + velocity summary row */}
      {tier !== 'compact' && (
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-500">
          {cost > 0 && <span title={`Total session cost: $${cost.toFixed(4)}`}>Cost: <span className="text-green">${cost.toFixed(2)}</span></span>}
          {turnsLeft !== null && tokPerTurn > 0 && (
            <span title="Estimated cost remaining based on current velocity">
              Est. remaining: <span className="text-gray-300">${((turnsLeft * tokPerTurn / 1000000) * 3).toFixed(2)}</span>
            </span>
          )}
          {liveSession?._compactEvents?.length > 0 && (
            <span className="text-amber" title={`${liveSession._compactEvents.length} context compaction events`}>
              Compacts: {liveSession._compactEvents.length}
            </span>
          )}
        </div>
      )}

      {/* Wide: Recent tool event feed */}
      {tier === 'wide' && recentEvents.length > 0 && (
        <div className="space-y-0.5 border-t border-gray-800 pt-1.5 mt-1">
          <span className="text-[10px] uppercase text-gray-500 tracking-wider">Recent Tools</span>
          {recentEvents.map((evt, i) => {
            const name = formatToolName(evt.tool);
            const summary = getToolSummary(evt);
            const isError = evt.status === 'error' || evt.error;
            const isBlocked = evt.status === 'blocked';
            const dotCls = isError ? 'bg-red' : isBlocked ? 'bg-amber' : 'bg-green';
            const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            return (
              <div key={evt.id || i} className="flex items-center gap-1.5 text-[10px] truncate"
                title={`${name}${summary ? ' \u2014 ' + summary : ''}${isError ? ' (FAILED)' : isBlocked ? ' (BLOCKED)' : ''}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`} />
                <span className="text-gray-500 shrink-0 tabular-nums">{ts}</span>
                <span className={isError ? 'text-red' : isBlocked ? 'text-amber' : 'text-gray-300'}>{name}</span>
                {summary && <span className="text-gray-600 truncate">{summary}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}