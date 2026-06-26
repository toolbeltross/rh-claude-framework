import InfoIcon, { Legend } from './InfoIcon';
import { getModelColor } from '../lib/model-colors';

function formatToolName(raw) {
  if (!raw) return '?';
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    const action = parts.length >= 3 ? parts.slice(2).join('__') : parts[parts.length - 1];
    return action.replace(/^preview_/, '');
  }
  return raw;
}

export default function CurrentSession({ session, liveSession, displayMode = 'cost' }) {
  const live = liveSession;
  const isTokenMode = displayMode === 'tokens';

  if (!session && !live) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        <span className="text-xs text-gray-400">SESSION: No data</span>
      </div>
    );
  }

  // Prefer live data when available
  if (live) {
    const cost = live.cost?.total_cost_usd ?? 0;
    const durationMs = live.cost?.total_duration_ms ?? 0;
    const linesAdded = live.cost?.total_lines_added ?? 0;
    const linesRemoved = live.cost?.total_lines_removed ?? 0;
    const modelName = friendlyModel(live.model?.id, live.model?.display_name);
    const toolCount = live._toolCount || 0;
    const lastTool = live._lastTool || '';
    const hasCost = cost > 0;
    const hasDuration = durationMs > 0 || live._startedAt > 0;
    const effectiveDurationMs = durationMs > 0 ? durationMs : (live._startedAt ? Date.now() - live._startedAt : 0);
    const hasLines = linesAdded > 0 || linesRemoved > 0;
    const costDelta = live._lastTurnCostDelta ?? 0;
    const turnCount = live._turnCount ?? 0;
    const activeSubagents = Object.keys(live._activeSubagents || {}).length;

    // Token totals from context_window
    const totalTokens = (live.context_window?.current_usage?.input_tokens ?? 0) +
                        (live.context_window?.current_usage?.output_tokens ?? 0);

    // Last turn token delta
    const history = live._turnHistory || [];
    const nonCompact = history.filter((h) => !h.compact);
    let lastTokenDelta = 0;
    if (nonCompact.length >= 2) {
      lastTokenDelta = Math.max(0, nonCompact[nonCompact.length - 1].tokens - nonCompact[nonCompact.length - 2].tokens);
    }

    return (
      <div className="bg-gray-900 border border-green/30 rounded-lg px-4 py-2">
        <div className="flex items-center gap-6 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5" title="Active Claude Code session with real-time data">
            Session <InfoIcon>
              <div className="space-y-1.5">
                <p>Live session metrics from Claude Code hooks. {isTokenMode ? 'Token counts accumulate' : 'Cost accumulates'} across API calls.</p>
                <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-accent" label="model" /><Legend color="bg-green" label={isTokenMode ? 'tokens' : 'cost'} /><Legend color="bg-gray-300" label="tools" /><Legend color="bg-amber" label="lines" /></div>
              </div>
            </InfoIcon>
          </span>
          <Stat label="Model" value={modelName} color={getModelColor(modelName).text} tooltip="The Claude model powering this session" />

          {isTokenMode ? (
            <>
              {totalTokens > 0 && <Stat label="Tokens" value={formatTokens(totalTokens)} color="text-green" tooltip="Total tokens consumed (input + output) in this session" />}
              {lastTokenDelta > 0 && <Stat label="Last" value={formatTokens(lastTokenDelta)} color="text-green/70" tooltip="Tokens consumed in the last completed turn" />}
            </>
          ) : (
            <>
              {hasCost && <Stat label="Cost" value={`$${cost.toFixed(2)}`} color="text-green" tooltip="Estimated API cost in USD for this session" />}
              {costDelta > 0 && <Stat label="Last" value={`$${costDelta.toFixed(2)}`} color="text-green/70" tooltip="Cost of the last completed turn" />}
            </>
          )}

          {turnCount > 0 && <Stat label="Turn" value={turnCount.toString()} color="text-gray-300" tooltip="Number of completed turns (Claude responses) in this session" />}
          {hasDuration && <Stat label="Duration" value={formatDuration(effectiveDurationMs)} tooltip="Total elapsed time since the session started" />}
          {toolCount > 0 && <Stat label="Tools" value={toolCount.toString()} color="text-gray-300" tooltip="Number of tool calls tracked via PostToolUse hooks" />}
          {lastTool && <Stat label="Last Tool" value={formatToolName(lastTool)} tooltip="Most recent tool call in this session" />}
          {activeSubagents > 0 && <Stat label="Agents" value={activeSubagents.toString()} color="text-green" tooltip="Number of active subagents (Task tool spawns)" />}
          {hasLines && <Stat label="Lines" value={`+${linesAdded}/-${linesRemoved}`} color="text-amber" tooltip="Lines added and removed by Claude in this session" />}
        </div>
      </div>
    );
  }

  // Fallback to file-based session data
  const totalTokens = session.tokens?.total ?? 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
      <div className="flex items-center gap-6 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5" title="Session data from .claude.json">
          Session <InfoIcon>
            <div className="space-y-1.5">
              <p>{isTokenMode ? 'Session metrics from .claude.json. Token counts are cumulative.' : 'Session metrics from .claude.json file.'}</p>
              <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-accent" label="model" /><Legend color="bg-green" label={isTokenMode ? 'tokens' : 'cost'} /><Legend color="bg-amber" label="lines" /></div>
            </div>
          </InfoIcon>
        </span>
        <Stat label="Model" value={session.primaryModel} color={getModelColor(session.primaryModel).text} tooltip="The primary Claude model used" />
        <Stat label="Duration" value={session.duration} tooltip="Total elapsed time for this session" />
        {isTokenMode ? (
          <Stat label="Tokens" value={formatTokens(totalTokens)} color="text-green" tooltip="Total tokens consumed in this session" />
        ) : (
          <Stat label="Cost" value={`$${session.cost.toFixed(2)}`} color="text-green" tooltip="Total API cost in USD" />
        )}
        <Stat label="Lines" value={`+${session.linesAdded}/-${session.linesRemoved}`} color="text-amber" tooltip="Lines added and removed" />
      </div>
    </div>
  );
}

function Stat({ label, value, color, tooltip }) {
  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <span className="text-[10px] uppercase text-gray-400">{label}</span>
      <span className={`text-sm font-mono ${color || 'text-gray-300'}`}>{value}</span>
    </div>
  );
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function friendlyModel(id, displayName) {
  if (!id) return displayName || 'Unknown';
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+(?:-\d+)?)/i);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const version = m[2].replace('-', '.');
    return `${family} ${version}`;
  }
  return displayName || id;
}