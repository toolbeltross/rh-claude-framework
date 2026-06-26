import InfoIcon, { Legend } from './InfoIcon';

export default function TurnTracker({ liveSession, displayMode = 'cost' }) {
  if (!liveSession) return null;

  const turnCount = liveSession._turnCount ?? 0;
  const lastCost = liveSession._lastTurnCostDelta ?? 0;
  const tokPerTurn = liveSession._tokensPerTurn ?? 0;
  const turnsLeft = liveSession._estimatedTurnsRemaining;
  const history = liveSession._turnHistory || [];

  // Don't render until we have at least 1 turn
  if (turnCount === 0) return null;

  const isTokenMode = displayMode === 'tokens';

  // Compute average cost per turn from history
  const costTurns = history.filter((h) => !h.compact && h.cost > 0);
  const avgCost = costTurns.length > 0
    ? costTurns.reduce((sum, t) => sum + t.cost, 0) / costTurns.length
    : 0;

  // Compute last turn token delta from history
  let lastTokenDelta = 0;
  const nonCompact = history.filter((h) => !h.compact);
  if (nonCompact.length >= 2) {
    lastTokenDelta = Math.max(0, nonCompact[nonCompact.length - 1].tokens - nonCompact[nonCompact.length - 2].tokens);
  }

  // Color coding: red if last turn cost > 2x average (works for both modes)
  const lastCostColor = lastCost > avgCost * 2 && avgCost > 0 ? 'text-red' : 'text-green';
  const lastTokenColor = lastTokenDelta > tokPerTurn * 2 && tokPerTurn > 0 ? 'text-red' : 'text-green';
  const turnsLeftColor = turnsLeft !== null && turnsLeft <= 3 ? 'text-red' : turnsLeft !== null && turnsLeft <= 8 ? 'text-amber' : 'text-gray-300';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
      <div className="flex items-center gap-5 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5" title="Per-turn metrics — cost/tokens, velocity, and estimated remaining turns">
          Turns <InfoIcon>
            <div className="space-y-1.5">
              <p>Each Claude response is one turn. Tracks {isTokenMode ? 'token consumption' : 'cost and tokens'} per turn to estimate remaining turns before compaction.</p>
              <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-green" label="normal" /><Legend color="bg-red" label="&gt;2x avg" /></div>
            </div>
          </InfoIcon>
        </span>
        <Stat label="Turn" value={turnCount.toString()} color="text-gray-200" tooltip="Number of completed turns (Claude responses)" />

        {isTokenMode ? (
          <>
            {lastTokenDelta > 0 && <Stat label="Last" value={formatTokens(lastTokenDelta)} color={lastTokenColor} tooltip="Tokens consumed in the most recently completed turn" />}
            {tokPerTurn > 0 && <Stat label="Avg" value={`${formatTokens(tokPerTurn)}/turn`} color="text-gray-400" tooltip="Average tokens consumed per turn across this session" />}
          </>
        ) : (
          <>
            {lastCost > 0 && <Stat label="Last" value={`$${lastCost.toFixed(2)}`} color={lastCostColor} tooltip="Cost of the most recently completed turn" />}
            {avgCost > 0 && <Stat label="Avg" value={`$${avgCost.toFixed(2)}/turn`} color="text-gray-400" tooltip="Average cost per turn across this session" />}
          </>
        )}

        {tokPerTurn > 0 && <Stat label="Velocity" value={`${formatTokens(tokPerTurn)}/turn`} color="text-gray-300" tooltip="Average tokens consumed per turn" />}
        {turnsLeft !== null && turnsLeft !== undefined && (
          <Stat label="Remaining" value={`~${turnsLeft}`} color={turnsLeftColor} tooltip="Estimated turns left before hitting context window limit" />
        )}
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

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}