import { useState, useEffect } from 'react';
import { getModelColor } from '../lib/model-colors';
import { creditsToDollars } from './PlanUsage';

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function friendlyModel(liveModel, fallback) {
  const id = liveModel?.id;
  const disp = liveModel?.display_name;
  const hay = `${id || ''} ${disp || ''}`.toLowerCase();
  if (hay.includes('opus')) return 'Opus';
  if (hay.includes('sonnet')) return 'Sonnet';
  if (hay.includes('haiku')) return 'Haiku';
  return fallback || disp || '?';
}

/** Live elapsed timer. Ticks once a second while a session is running. */
function useElapsed(startedAt, durationMs) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt && !durationMs) return;
    const i = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(i);
  }, [startedAt, durationMs]);
  if (durationMs > 0) return durationMs;
  if (startedAt) return Date.now() - startedAt;
  return 0;
}

/**
 * Inline session metadata strip for the tab-bar row.
 *
 * Shows (in order): session id · elapsed · ●model · cost/tokens · lines.
 * Items drop from right to left as window width shrinks via Tailwind
 * responsive classes — lines (xl), session id (lg), elapsed (md), cost
 * (sm). Model is always visible.
 *
 * Returns null when activeTab is 'overview' or no session data is available.
 */
export default function SessionMetaStrip({ sessionId, liveSession, session, displayMode = 'cost', planInfo }) {
  const isTokenMode = displayMode === 'tokens';
  const live = liveSession;

  // Must call hooks before any early returns
  const rawDuration = live?.cost?.total_duration_ms ?? 0;
  const startedAt = live?._startedAt ?? 0;
  const elapsed = useElapsed(startedAt, rawDuration);

  if (!sessionId || sessionId === 'overview') return null;
  if (!live && !session) return null;

  const elapsedStr = live ? formatDuration(elapsed) : (session?.duration || '');

  const modelFamily = live
    ? friendlyModel(live.model, live._currentModel)
    : (session?.primaryModel || '?');
  const modelColor = getModelColor(modelFamily);

  const cost = live?.cost?.total_cost_usd ?? session?.cost ?? 0;
  const usage = live?.context_window?.current_usage;
  const totalTok = usage
    ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
    : session?.tokens?.total ?? 0;

  const linesAdded = live?.cost?.total_lines_added ?? session?.linesAdded ?? 0;
  const linesRemoved = live?.cost?.total_lines_removed ?? session?.linesRemoved ?? 0;
  const hasLines = linesAdded > 0 || linesRemoved > 0;

  const shortId = sessionId.slice(0, 8);

  const metricValue = isTokenMode
    ? (totalTok > 0 ? formatTokens(totalTok) : null)
    : (cost > 0 ? `$${cost.toFixed(2)}` : null);

  const Dot = () => <span className="text-gray-700" aria-hidden>·</span>;

  return (
    <div
      className="flex-1 min-w-0 inline-flex items-center justify-end gap-2 text-[11px] font-mono text-gray-400 px-2 whitespace-nowrap overflow-hidden self-center"
      role="status"
      aria-label="Session metadata"
    >
      {/* Session ID — hidden below lg (1024px) */}
      {shortId && (
        <>
          <span className="hidden lg:inline text-gray-500" title={`Session ID: ${sessionId}`}>
            {shortId}
          </span>
          <span className="hidden lg:inline"><Dot /></span>
        </>
      )}

      {/* Elapsed — hidden below md (768px) */}
      {elapsedStr && (
        <>
          <span className="hidden md:inline text-gray-400" title="Elapsed session time">
            {elapsedStr}
          </span>
          <span className="hidden md:inline"><Dot /></span>
        </>
      )}

      {/* Model — always visible */}
      <span
        className={`inline-flex items-center gap-1 shrink-0 ${modelColor.text}`}
        title={`Model: ${live?.model?.display_name || live?.model?.id || modelFamily}`}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: modelColor.hex }} />
        {modelFamily}
      </span>

      {/* Cost / Tokens — hidden below sm (640px) */}
      {metricValue && (
        <>
          <span className="hidden sm:inline"><Dot /></span>
          <span
            className="hidden sm:inline text-green"
            title={isTokenMode ? `Total tokens: ${totalTok.toLocaleString()}` : `Session cost: $${cost.toFixed(4)}`}
          >
            {metricValue}
          </span>
        </>
      )}

      {/* Lines — hidden below xl (1280px) */}
      {hasLines && (
        <>
          <span className="hidden xl:inline"><Dot /></span>
          <span
            className="hidden xl:inline text-amber"
            title={`Lines added: ${linesAdded}, removed: ${linesRemoved}`}
          >
            +{linesAdded}{linesRemoved > 0 && `/-${linesRemoved}`}
          </span>
        </>
      )}

      {/* Extra Usage indicator — always visible when active */}
      {(() => {
        const extra = planInfo?.usage?.extraUsage;
        if (!extra?.is_enabled) return null;
        const usedDollars = creditsToDollars(extra.used_credits);
        if (usedDollars == null) return null;
        const limitDollars = creditsToDollars(extra.monthly_limit);
        const anyAtLimit = planInfo?.usage && [
          planInfo.usage.fiveHour?.utilization,
          planInfo.usage.sevenDay?.utilization,
          planInfo.usage.sevenDayOpus?.utilization,
          planInfo.usage.sevenDaySonnet?.utilization,
        ].some(u => u != null && u >= 100);

        return (
          <>
            <Dot />
            <span
              className={`inline-flex items-center gap-1 shrink-0 ${anyAtLimit ? 'text-amber' : 'text-gray-500'}`}
              title={anyAtLimit
                ? `Extra Usage active — $${usedDollars.toFixed(2)} spent${limitDollars ? ` of $${limitDollars.toFixed(0)} monthly cap` : ''}`
                : `Extra Usage enabled — $${usedDollars.toFixed(2)} spent this month`
              }
            >
              {anyAtLimit && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber animate-pulse-dot" />}
              <span className="text-[10px] uppercase">Extra</span>
              <span className="font-mono">${usedDollars.toFixed(2)}</span>
            </span>
          </>
        );
      })()}
    </div>
  );
}
