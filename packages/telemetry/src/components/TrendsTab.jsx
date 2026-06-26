import { useState, useEffect } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import InfoIcon from './InfoIcon.jsx';

// P3-2: Trends tab — surfaces cross-session/project oversight event counts
// over a sliding window via the /api/trends endpoint (which wraps
// rh-supervisor-sweep aggregations).
//
// Reads but does not write. Reload on day-range change.

function fmtDelta(d) {
  if (d === null || d === undefined) return '—';
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : `${d}`;
}

function deltaClass(d) {
  if (d === null || d === undefined || d === 0) return 'text-gray-400';
  return d > 0 ? 'text-amber' : 'text-green';
}

export default function TrendsTab() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/trends?days=${days}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [days]);

  if (loading) return <div className="text-gray-400 text-sm p-4">Loading trends...</div>;
  if (error) return <div className="text-red text-sm p-4" data-testid="trends-error">Error: {error}</div>;
  if (!data) return <div className="text-gray-500 text-sm p-4">No data</div>;

  const { current, prior } = data;
  const dayData = current.byDay.map(([day, count]) => ({ day: day.slice(5), count }));
  const eventTypeRows = current.byType.map(([type, count]) => {
    const priorCount = (prior.byType.find(p => p[0] === type) || [, 0])[1];
    return { type, count, prior: priorCount, delta: count - priorCount };
  });

  return (
    <div className="space-y-4" data-testid="trends-tab">
      {/* Header with day-range selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Supervisor Trends <InfoIcon title="Cross-session oversight-event aggregations from rh-supervisor-sweep. Sources: ~/.claude/oversight-events.jsonl + supervisory-log Layer3a rejections." />
        </h2>
        <div className="flex items-center gap-1 text-xs">
          {[1, 7, 14, 30].map(n => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={`px-2 py-1 rounded ${
                days === n
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 border border-transparent'
              }`}
              data-testid={`trends-range-${n}`}
            >
              {n}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary card row */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          label="Oversight events"
          current={current.total}
          prior={prior.total}
          tooltip="Total structured oversight events in window (oversight_auto_inject, consolidation_blocked, subagent_failure_detected, etc.)"
        />
        <SummaryCard
          label="Layer3a rejections"
          current={current.layer3aRejections}
          prior={prior.layer3aRejections}
          tooltip="Stop-hook prompt-evaluation rejections captured by layer3a-capture.js"
        />
        <SummaryCard
          label="Hot sessions"
          current={current.bySid.length}
          prior={prior.bySid.length}
          tooltip="Distinct sessions with at least one oversight event"
        />
      </div>

      {/* Daily cadence chart */}
      <div className="bg-gray-900/50 rounded p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
          Daily cadence
        </h3>
        {dayData.length === 0 ? (
          <div className="text-gray-500 text-sm py-8 text-center">No events in window</div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dayData}>
              <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 4, fontSize: 12 }}
                labelStyle={{ color: '#9ca3af' }}
              />
              <Bar dataKey="count" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Event-type table */}
      <div className="bg-gray-900/50 rounded p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
          Event types
        </h3>
        {eventTypeRows.length === 0 ? (
          <div className="text-gray-500 text-sm py-4 text-center">No events in window</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 font-normal">Type</th>
                <th className="text-right py-1 font-normal">Current</th>
                <th className="text-right py-1 font-normal">Prior</th>
                <th className="text-right py-1 font-normal">Δ</th>
              </tr>
            </thead>
            <tbody>
              {eventTypeRows.map(r => (
                <tr key={r.type} className="border-b border-gray-800/50">
                  <td className="py-1 font-mono text-gray-200">{r.type}</td>
                  <td className="text-right py-1 text-gray-200">{r.count}</td>
                  <td className="text-right py-1 text-gray-500">{r.prior}</td>
                  <td className={`text-right py-1 ${deltaClass(r.delta)}`}>{fmtDelta(r.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Top patterns: missing elements + subagent failure patterns */}
      <div className="grid grid-cols-2 gap-3">
        <PatternList
          title="Top missing oversight elements"
          tooltip="Top oversight-block elements (verificationToken, contextReport, batchOverflow) flagged by agent-oversight-guard.js as missing from subagent prompts"
          rows={current.missingElements}
          emptyMessage="No oversight_auto_inject events in window"
        />
        <PatternList
          title="Top subagent failure patterns"
          tooltip="Top patterns matched by agent-result-guard.js across all subagent outputs in the window"
          rows={current.subagentPatterns}
          emptyMessage="No subagent_failure_detected events in window"
        />
      </div>

      {/* Hot sessions */}
      <div className="bg-gray-900/50 rounded p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
          Top sessions by event count
        </h3>
        {current.bySid.length === 0 ? (
          <div className="text-gray-500 text-sm py-4 text-center">No sessions with events in window</div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {current.bySid.map(([sid, count]) => (
                <tr key={sid} className="border-b border-gray-800/50">
                  <td className="py-1 font-mono text-gray-200">{String(sid).slice(0, 12)}</td>
                  <td className="text-right py-1 text-gray-200">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer: window + source */}
      <div className="text-xs text-gray-500 px-1">
        Window: {new Date(current.windowStart).toLocaleDateString()} → {new Date(current.windowEnd).toLocaleDateString()}
        {' • '}
        Sources: {data.sources.events.fileMissing ? 'events file missing' : `${current.total} events parsed`}
        {data.sources.supervisoryLog.fileMissing ? ', no supervisory log' : ''}
      </div>
    </div>
  );
}

function SummaryCard({ label, current, prior, tooltip }) {
  const delta = prior !== null && prior !== undefined ? current - prior : null;
  return (
    <div className="bg-gray-900/50 rounded p-3" title={tooltip}>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold text-gray-100">{current}</span>
        <span className={`text-xs ${deltaClass(delta)}`}>{fmtDelta(delta)}</span>
        <span className="text-xs text-gray-500">vs prior {prior}</span>
      </div>
    </div>
  );
}

function PatternList({ title, tooltip, rows, emptyMessage }) {
  return (
    <div className="bg-gray-900/50 rounded p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2" title={tooltip}>
        {title}
      </h3>
      {rows.length === 0 ? (
        <div className="text-gray-500 text-sm py-4 text-center">{emptyMessage}</div>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([pattern, count]) => (
              <tr key={pattern} className="border-b border-gray-800/50">
                <td className="py-1 font-mono text-gray-200">{pattern}</td>
                <td className="text-right py-1 text-gray-200">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
