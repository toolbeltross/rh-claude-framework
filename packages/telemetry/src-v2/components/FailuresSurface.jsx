import { useMemo, useState } from 'react';
import { useFailures } from '../hooks/useFailures.js';
import { formatN, formatUsd, relativeTime } from '../lib/format.js';

const RANGES = [
  { id: '24h',  label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d',   label: '7d',  ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d',  label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

const ERROR_CLASS_COLOR = {
  not_found:  'text-gray-400',
  permission: 'text-amber-400',
  size_limit: 'text-amber-400',
  timeout:    'text-red-400',
  network:    'text-red-400',
  validation: 'text-amber-400',
  orphan:     'text-red-400',
  config:     'text-amber-400',
  other:      'text-gray-400',
};

export default function FailuresSurface() {
  const [rangeId, setRangeId] = useState('7d');
  const range = RANGES.find((r) => r.id === rangeId);
  const { failures, patterns, topCost, loading, error } = useFailures({ sinceMs: range.ms });

  // Bucket failures by ISO date for the daily bars header
  const dailyBuckets = useMemo(() => {
    const map = new Map();
    const start = Date.now() - range.ms;
    for (const f of failures) {
      const t = typeof f.timestamp === 'number' ? f.timestamp : new Date(f.timestamp).getTime();
      if (t < start) continue;
      const date = new Date(t).toISOString().slice(0, 10);
      map.set(date, (map.get(date) || 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [failures, range.ms]);

  if (loading && failures.length === 0) {
    return <div className="p-12 text-center text-sm text-gray-400">Loading failures…</div>;
  }
  if (error) {
    return <div className="p-12 text-center text-sm text-red-400">{error}</div>;
  }

  const total = patterns?.total ?? failures.length;
  const byTool = patterns?.byTool || {};
  const byError = patterns?.byError || {};
  const topTools = Object.entries(byTool).sort(([, a], [, b]) => b - a).slice(0, 5);
  const topErrors = Object.entries(byError).sort(([, a], [, b]) => b - a).slice(0, 5);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Failures</h1>
          <p className="text-xs text-gray-500 mt-1">
            Tool failures over the last {range.label}. {failures.length === 0 ? 'Quiet so far.' : `${failures.length} in window.`}
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRangeId(r.id)}
              className={`px-2 py-1 rounded ${
                rangeId === r.id
                  ? 'bg-gray-800 text-gray-100'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <Card label="Total (lifetime)" value={formatN(total)} hint="All failures recorded in telemetry-failures.jsonl since first capture" />
        <Card label={`In window (${range.label})`} value={formatN(failures.length)} hint="Failures whose timestamp falls within the selected range" />
        <Card label="Top tool" value={topTools[0]?.[0] || '—'} hint={topTools[0] ? `${topTools[0][1]} failures` : 'No data'} />
        <Card
          label="Top error count"
          value={topErrors[0] ? formatN(topErrors[0][1]) : '—'}
          hint={topErrors[0] ? `${topErrors[0][0].slice(0, 200)} (${topErrors[0][1]} occurrences)` : 'No data'}
        />
      </div>

      {/* Daily bars */}
      <Section title={`Daily failure count (${dailyBuckets.length} days in window)`}>
        {dailyBuckets.length === 0 ? (
          <Empty hint="No failures in window" />
        ) : (
          <DailyBars data={dailyBuckets} />
        )}
      </Section>

      {/* Top patterns side by side */}
      <div className="grid grid-cols-2 gap-3">
        <Section title="Top tools (lifetime)">
          <RankedList rows={topTools} />
        </Section>
        <Section title="Top errors (lifetime)">
          <RankedList rows={topErrors} />
        </Section>
      </div>

      {/* Top cost — surfaces /api/failures/top-cost (D4 endpoint v1 never displayed) */}
      <Section title={`Most expensive failures (${range.label})`}>
        {topCost.length === 0 ? (
          <Empty hint="No cost-tagged failures in window" />
        ) : (
          <div className="space-y-1">
            {topCost.map((f, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 px-2 hover:bg-gray-900 rounded">
                <span className="text-xs text-gray-600 font-mono w-6 text-right">{i + 1}</span>
                <span className="text-sm text-gray-300 w-20">{f.toolName || '—'}</span>
                <span className="text-xs text-gray-400 flex-1 truncate" title={f.error || ''}>{f.error || '—'}</span>
                <span className="text-xs text-green-400 font-mono w-20 text-right">{formatUsd(f.estimatedCost || 0)}</span>
                <span className="text-xs text-gray-600 font-mono w-20 text-right">{relativeTime(f.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Recent failures */}
      <Section title={`Recent failures (${failures.length})`}>
        {failures.length === 0 ? (
          <Empty hint={`No failures in last ${range.label}`} />
        ) : (
          <div className="space-y-0.5 max-h-96 overflow-y-auto">
            {failures.slice(0, 50).map((f, i) => {
              const cls = f.errorClass || 'other';
              const colorClass = ERROR_CLASS_COLOR[cls] || 'text-gray-400';
              return (
                <div key={i} className="flex items-center gap-3 py-1 px-2 hover:bg-gray-900 rounded text-xs">
                  <span className="text-gray-600 font-mono w-16">{relativeTime(f.timestamp)}</span>
                  <span className="text-gray-400 w-16">{f.toolName || '—'}</span>
                  <span className={`${colorClass} w-20 text-[10px] uppercase`}>{cls}</span>
                  <span className="text-gray-500 flex-1 truncate" title={f.error || ''}>{f.error || '—'}</span>
                  {f.estimatedCost > 0 && (
                    <span className="text-gray-600 font-mono w-16 text-right">{formatUsd(f.estimatedCost)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
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

function Empty({ hint }) {
  return <div className="text-xs text-gray-500 italic py-2">{hint}</div>;
}

function DailyBars({ data }) {
  const max = Math.max(...data.map(([, n]) => n));
  return (
    <div className="flex items-end gap-0.5 h-20">
      {data.map(([date, n]) => {
        const h = max ? Math.max(2, (n / max) * 80) : 2;
        return (
          <div
            key={date}
            className="flex flex-col items-center justify-end min-w-[14px]"
            title={`${date}: ${n} failures`}
          >
            <div className="w-2.5 bg-red-400/70 rounded-sm" style={{ height: `${h}px` }} />
          </div>
        );
      })}
    </div>
  );
}

function RankedList({ rows }) {
  if (rows.length === 0) return <Empty hint="No data" />;
  const max = rows[0]?.[1] || 1;
  return (
    <div className="space-y-1">
      {rows.map(([key, count]) => (
        <div key={key} className="flex items-center gap-2 text-xs">
          <span className="text-gray-300 w-32 truncate" title={key}>{key}</span>
          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-400/70" style={{ width: `${(count / max) * 100}%` }} />
          </div>
          <span className="text-gray-500 font-mono w-8 text-right">{count}</span>
        </div>
      ))}
    </div>
  );
}
