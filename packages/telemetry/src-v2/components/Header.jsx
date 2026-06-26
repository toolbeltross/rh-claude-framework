import { useEffect, useState } from 'react';
import { MODEL_COLORS } from '../../src/lib/model-colors.js';
import PlanUsage from '../../src/components/PlanUsage.jsx';
import { relativeTime } from '../lib/format.js';

export default function Header({
  lastUpdated,
  onRefresh,
  planInfo,
  statusLineState,
  liveSessions = {},
  sessionActivity = {},
  onLiveClick,
}) {
  // Re-render every 5s so "3s ago" stays current
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const stale = lastUpdated && (Date.now() - lastUpdated) > 60_000;

  const liveIds = Object.keys(liveSessions);
  const anyProcessing = liveIds.some((id) => sessionActivity[id] === 'processing');

  // Mirror StatusLineBanner's health test (src/components/StatusLineBanner.jsx)
  const slClass = statusLineState?.class;
  const slHealthy = (slClass === 'telemetry' || slClass === 'telemetry-wrapper') && !statusLineState?.stalled;
  const slKnown = Boolean(statusLineState?.lastCheckedAt);

  return (
    <header className="h-12 border-b border-gray-800 bg-gray-950 flex items-center px-4 gap-4 text-sm">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="uppercase tracking-wider">env</span>
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-200 font-mono">v2</span>
      </div>

      {/* Plan quota gauges — lifted verbatim from v1 (always visible per v2-ia header spec).
          min-w-0 + overflow-hidden: gauges clip before colliding with the legend. */}
      <div className="min-w-0 overflow-hidden shrink">
        <PlanUsage planInfo={planInfo} inline />
      </div>

      {/* Model legend — drops below xl so the quota gauges keep their room */}
      <div className="hidden xl:flex items-center gap-3 text-xs shrink-0">
        {Object.entries(MODEL_COLORS).map(([name, c]) => (
          <span key={name} className="flex items-center gap-1.5" title={`${name} (${c.hex})`}>
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.hex }} />
            <span className="text-gray-400">{name}</span>
          </span>
        ))}
      </div>

      <div className="flex-1" />

      {/* Live session count — green pulsing while any session is processing */}
      {liveIds.length > 0 && (
        <button
          onClick={onLiveClick}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-900 hover:bg-gray-800 transition-colors text-xs font-mono whitespace-nowrap shrink-0"
          title={`${liveIds.length} live session${liveIds.length === 1 ? '' : 's'} — ${anyProcessing ? 'processing' : 'idle'}. Click to open Live.`}
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              anyProcessing ? 'bg-green animate-pulse-dot' : 'bg-blue'
            }`}
          />
          <span className={anyProcessing ? 'text-green' : 'text-blue'}>{liveIds.length} LIVE</span>
        </button>
      )}

      {/* statusLine health — green ok / amber degraded or stalled / gray unknown */}
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{
          backgroundColor: !slKnown
            ? 'var(--color-gray-600)'
            : slHealthy
              ? 'var(--color-green)'
              : 'var(--color-amber)',
        }}
        title={
          !slKnown
            ? 'statusLine: not yet checked'
            : slHealthy
              ? `statusLine: healthy (${slClass})`
              : `statusLine: ${statusLineState?.stalled ? 'STALLED — tool events flowing but no status posts' : `degraded (${slClass || 'unknown'})`}. Fix: rh-telemetry repair-statusline`
        }
      />

      <div className={`text-xs whitespace-nowrap shrink-0 ${stale ? 'text-amber-400' : 'text-gray-500'}`}>
        {lastUpdated ? `updated ${relativeTime(lastUpdated)}` : 'connecting…'}
      </div>

      <button
        onClick={onRefresh}
        className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800 transition-colors whitespace-nowrap shrink-0"
        title="Force refresh from /api/aggregates"
      >
        ↻ refresh
      </button>
    </header>
  );
}
