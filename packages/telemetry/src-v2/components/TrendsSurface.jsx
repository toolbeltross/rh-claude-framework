/**
 * Trends surface — adapted (near-verbatim) from v1 src/components/TrendsTab.jsx.
 *
 * Wraps GET /api/trends (which itself wraps @rh/oversight rh-supervisor-sweep
 * via createRequire). Same data, same shape — just sits in v2's sidebar layout
 * instead of v1's tab bar. Custom Tooltip components from InfoIcon replaced
 * with native title attributes per v2 simplification.
 */
import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

function fmtDelta(d) {
  if (d === null || d === undefined) return '—';
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : `${d}`;
}

function deltaClass(d) {
  if (d === null || d === undefined || d === 0) return 'text-gray-400';
  return d > 0 ? 'text-amber' : 'text-green';
}

export default function TrendsSurface() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/trends?days=${days}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [days]);

  if (loading && !data) return <div className="p-6 text-sm text-gray-400">Loading trends…</div>;
  if (error) return <div className="p-6 text-sm text-red">Error: {error}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">No data</div>;

  const { current, prior } = data;
  const dayData = current.byDay.map(([day, count]) => ({ day: day.slice(5), count }));
  const eventTypeRows = current.byType.map(([type, count]) => {
    const priorCount = (prior.byType.find((p) => p[0] === type) || [, 0])[1];
    return { type, count, prior: priorCount, delta: count - priorCount };
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Trends</h1>
          <p className="text-xs text-gray-500 mt-1">
            Cross-session oversight aggregations from <code className="text-gray-400">rh-supervisor-sweep</code> via <code className="text-gray-400">/api/trends</code>.
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {[1, 7, 14, 30].map((n) => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={`px-2 py-1 rounded ${
                days === n
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 border border-transparent'
              }`}
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
          tooltip="Structured oversight events in window"
        />
        <SummaryCard
          label="Layer 3a rejections"
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
      <Section title="Daily cadence">
        {dayData.length === 0 ? (
          <Empty hint="No events in window" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dayData}>
              <XAxis dataKey="day" tick={{ fill: '#8888a0', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#8888a0', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: '#111118', border: '1px solid #2a2a38', borderRadius: 4, fontSize: 12 }}
                labelStyle={{ color: '#8888a0' }}
              />
              <Bar dataKey="count" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Section>

      {/* Event-type table */}
      <Section title="Event types (current vs prior)">
        {eventTypeRows.length === 0 ? (
          <Empty hint="No events in window" />
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
              {eventTypeRows.map((r) => (
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
      </Section>

      {/* Patterns: missing elements + subagent failure patterns */}
      <div className="grid grid-cols-2 gap-3">
        <PatternList
          title="Top missing oversight elements"
          tooltip="Top oversight-block elements (verificationToken, contextReport, batchOverflow) flagged by agent-oversight-guard.js as missing from subagent prompts"
          rows={current.missingElements}
          emptyMessage="No oversight_auto_inject events in window"
        />
        <PatternList
          title="Top subagent failure patterns"
          tooltip="Top patterns matched by agent-result-guard.js across all subagent outputs"
          rows={current.subagentPatterns}
          emptyMessage="No subagent_failure_detected events in window"
        />
      </div>

      {/* Hot sessions */}
      <Section title="Top sessions by event count">
        {current.bySid.length === 0 ? (
          <Empty hint="No sessions with events in window" />
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
      </Section>

      <div className="text-[10px] text-gray-500 px-1">
        Window: {new Date(current.windowStart).toLocaleDateString()} → {new Date(current.windowEnd).toLocaleDateString()}
        {' · '}
        Sources: {data.sources.events.fileMissing ? 'events file missing' : `${current.total} events parsed`}
        {data.sources.supervisoryLog.fileMissing ? ', no supervisory log' : ''}
      </div>
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

function Empty({ hint }) {
  return <div className="text-xs text-gray-500 italic py-2 text-center">{hint}</div>;
}

function SummaryCard({ label, current, prior, tooltip }) {
  const delta = prior !== null && prior !== undefined ? current - prior : null;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4" title={tooltip}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-gray-100">{current}</span>
        <span className={`text-xs ${deltaClass(delta)}`}>{fmtDelta(delta)}</span>
        <span className="text-[10px] text-gray-500">vs prior {prior}</span>
      </div>
    </div>
  );
}

function PatternList({ title, tooltip, rows, emptyMessage }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h2 className="text-[10px] uppercase tracking-wider text-gray-500 mb-3" title={tooltip}>{title}</h2>
      {rows.length === 0 ? (
        <Empty hint={emptyMessage} />
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
