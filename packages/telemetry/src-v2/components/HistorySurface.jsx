import { formatN, formatUsd, isoDate, relativeTime } from '../lib/format.js';
import { getModelFamily, getModelColor } from '../../src/lib/model-colors.js';

/**
 * History surface — replaces v1's Overview tab.
 *
 * Consumes GET /api/aggregates (the new Phase 2 endpoint). This is the
 * concrete proof that v2 no longer depends on the stale stats-cache.json:
 * numbers shown here are computed live from ~/.claude/projects/*.jsonl
 * every time the server boots and whenever transcripts change.
 */
export default function HistorySurface({ aggregates, loading, error }) {
  if (loading && !aggregates) {
    return <Empty title="Loading…" detail="Walking transcripts" />;
  }
  if (error) {
    return <Empty title="Error" detail={error} />;
  }
  if (!aggregates) {
    return <Empty title="No data" detail="Aggregator returned no aggregates" />;
  }

  const {
    totalSessions, totalMessages, totalCost, firstSessionDate, longestSession,
    dailyActivity = [], modelUsage = {}, hourCounts = {}, lastComputedAt,
  } = aggregates;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">History</h1>
        <p className="text-xs text-gray-500 mt-1">
          Live aggregates from <code className="text-gray-400">~/.claude/projects/</code>.
          {' '}Computed {lastComputedAt ? relativeTime(lastComputedAt) : '—'}.
          {' '}Independent of <code className="text-gray-400">stats-cache.json</code>.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <Card label="Sessions (on disk)" value={formatN(totalSessions)} hint="Count of *.jsonl in ~/.claude/projects/" />
        <Card label="Messages" value={formatN(totalMessages)} hint="user + assistant lines across all transcripts" />
        <Card label="Lifetime cost" value={formatUsd(totalCost)} hint="Sum of token×rate (cost-rates.js) across all sessions" />
        <Card label="First session" value={isoDate(firstSessionDate)} hint="Earliest timestamp seen in any on-disk transcript" />
      </div>

      {/* Model breakdown */}
      <Section title="Model usage (lifetime)">
        <div className="space-y-1">
          {Object.entries(modelUsage)
            .filter(([id]) => id !== '<synthetic>')
            .sort(([, a], [, b]) => (b.cost || 0) - (a.cost || 0))
            .map(([id, m]) => {
              const family = getModelFamily(id);
              const color = getModelColor(id);
              const totalTokens = (m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
              return (
                <div key={id} className="flex items-center gap-3 py-1.5 px-2 hover:bg-gray-900 rounded">
                  <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color.hex }} />
                  <span className="text-sm text-gray-200 font-mono min-w-[180px]">{id}</span>
                  <span className="text-xs text-gray-500 flex-1">{family}</span>
                  <span className="text-xs text-gray-400 font-mono min-w-[80px] text-right">{formatN(totalTokens)} tok</span>
                  <span className="text-xs text-green-400 font-mono min-w-[80px] text-right">{formatUsd(m.cost || 0)}</span>
                </div>
              );
            })}
        </div>
      </Section>

      {/* Daily activity bars */}
      <Section title={`Daily activity (${dailyActivity.length} days)`}>
        <DailyBars data={dailyActivity} />
      </Section>

      {/* Hourly heatmap */}
      <Section title="Hour-of-day distribution (sessions started)">
        <HourHeatmap counts={hourCounts} />
      </Section>

      {longestSession && (
        <Section title="Longest session">
          <div className="text-sm text-gray-300">
            <div className="font-mono text-gray-400">{longestSession.sessionId?.slice(0, 8)}…</div>
            <div className="text-xs text-gray-500 mt-1">
              {Math.floor((longestSession.durationMs || 0) / 60000)} min
              {longestSession.projectPath && ` · ${longestSession.projectPath}`}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

function Card({ label, value, hint }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-100">{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h2 className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ title, detail }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-12 text-center">
      <div className="text-sm text-gray-300">{title}</div>
      {detail && <div className="text-xs text-gray-500 mt-2">{detail}</div>}
    </div>
  );
}

function DailyBars({ data }) {
  if (!data.length) return <div className="text-xs text-gray-500">No activity recorded.</div>;
  const max = Math.max(...data.map((d) => d.messageCount || 0));
  return (
    <div className="flex items-end gap-0.5 h-24 overflow-x-auto">
      {data.map((d) => {
        const h = max ? Math.max(2, (d.messageCount / max) * 96) : 2;
        return (
          <div
            key={d.date}
            className="flex flex-col items-center justify-end min-w-[14px]"
            title={`${d.date}: ${d.messageCount} msgs · ${d.sessionCount} sessions · ${d.toolCallCount} tool calls`}
          >
            <div className="w-2.5 bg-blue-500/70 rounded-sm" style={{ height: `${h}px` }} />
          </div>
        );
      })}
    </div>
  );
}

function HourHeatmap({ counts }) {
  const max = Math.max(0, ...Object.values(counts).map((v) => Number(v) || 0));
  return (
    <div className="flex gap-1">
      {Array.from({ length: 24 }, (_, h) => {
        const c = Number(counts[h] || counts[String(h)] || 0);
        const opacity = max ? Math.max(0.05, c / max) : 0;
        return (
          <div key={h} className="flex flex-col items-center gap-1">
            <div
              className="w-6 h-6 rounded-sm"
              style={{ backgroundColor: `rgba(96, 165, 250, ${opacity})` }}
              title={`${h}:00 UTC — ${c} sessions started`}
            />
            <div className="text-[9px] text-gray-600">{h.toString().padStart(2, '0')}</div>
          </div>
        );
      })}
    </div>
  );
}
