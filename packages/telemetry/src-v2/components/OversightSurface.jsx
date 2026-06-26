import { useState } from 'react';
import { useOversight } from '../hooks/useOversight.js';
import { formatN, relativeTime } from '../lib/format.js';

const RANGES = [
  { id: 1,  label: '1d' },
  { id: 7,  label: '7d' },
  { id: 14, label: '14d' },
  { id: 30, label: '30d' },
];

// Visual signals per event_type (Phase 0.6 catalog + types observed since)
const EVENT_META = {
  instructions_loaded:         { kind: 'heartbeat', label: 'Instructions loaded',         color: 'text-gray-500' },
  oversight_auto_inject:       { kind: 'warning',   label: 'Auto-injected oversight',    color: 'text-amber-400' },
  daily_regen_stale_alert:     { kind: 'warning',   label: 'OVERSIGHT_STATE.md stale',   color: 'text-amber-400' },
  subagent_orphan_alert:       { kind: 'alert',     label: 'Subagent orphan',            color: 'text-red-400' },
  subagent_protocol_violation: { kind: 'alert',     label: 'Subagent protocol violation', color: 'text-red-400' },
  journal_staleness_alert:     { kind: 'warning',   label: 'Journal stale',              color: 'text-amber-400' },
  layer3a_rejection:           { kind: 'alert',     label: 'Layer 3a rejection',         color: 'text-red-400' },
  scribe_row_review_needed:    { kind: 'warning',   label: 'Scribe row needs review',    color: 'text-amber-400' },
  scribe_db_write_failed:      { kind: 'alert',     label: 'Scribe DB write failed',     color: 'text-red-400' },
};

export default function OversightSurface() {
  const [days, setDays] = useState(7);
  const { data, loading, error } = useOversight(days);

  if (loading && !data) return <div className="p-12 text-center text-sm text-gray-400">Loading oversight events…</div>;
  if (error) return <div className="p-12 text-center text-sm text-red-400">{error}</div>;
  if (!data) return null;

  const { eventsByType = {}, recent = [], total, oldest, newest, sourcePath } = data;
  const types = Object.entries(eventsByType).sort(([, a], [, b]) => b.count - a.count);

  // Separate heartbeat (instructions_loaded) from actionable signal
  const heartbeats = types.filter(([t]) => EVENT_META[t]?.kind === 'heartbeat');
  const actionable = types.filter(([t]) => EVENT_META[t]?.kind !== 'heartbeat');
  const totalActionable = actionable.reduce((sum, [, e]) => sum + e.count, 0);
  const totalHeartbeat = heartbeats.reduce((sum, [, e]) => sum + e.count, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Oversight</h1>
          <p className="text-xs text-gray-500 mt-1">
            Live feed of oversight events from <code className="text-gray-400">~/.claude/oversight-events.jsonl</code>.
            {' '}{total} events in last {days}d. Heartbeats separated from actionable signal.
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setDays(r.id)}
              className={`px-2 py-1 rounded ${
                days === r.id ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <Card label="Total events" value={formatN(total)} hint={`Across last ${days}d`} />
        <Card label="Actionable" value={formatN(totalActionable)} hint="Excludes instructions_loaded heartbeats" color="text-amber-300" />
        <Card label="Heartbeat" value={formatN(totalHeartbeat)} hint="instructions_loaded events" color="text-gray-400" />
        <Card label="Newest" value={newest ? relativeTime(newest) : '—'} hint={newest ? new Date(newest).toISOString() : 'No events'} />
      </div>

      {/* Actionable event types */}
      <Section title="Actionable event types (ranked by count)">
        {actionable.length === 0 ? (
          <Empty hint="No actionable oversight events in window — system is quiet" />
        ) : (
          <div className="space-y-1">
            {actionable.map(([type, entry]) => {
              const meta = EVENT_META[type] || { label: type, color: 'text-gray-400' };
              return (
                <div key={type} className="flex items-center gap-3 py-1.5 px-2 hover:bg-gray-900 rounded">
                  <span className={`text-xs uppercase tracking-wider ${meta.color} w-32`}>{meta.kind || 'event'}</span>
                  <span className="text-sm text-gray-200 flex-1">{meta.label}</span>
                  {meta.label !== type && (
                    <span className="text-xs text-gray-500 font-mono">{type}</span>
                  )}
                  <span className="text-xs text-gray-400 font-mono w-12 text-right">{entry.count}</span>
                  <span className="text-xs text-gray-600 font-mono w-20 text-right">{relativeTime(entry.lastSeen)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Heartbeats */}
      {heartbeats.length > 0 && (
        <Section title="Heartbeats (low-signal, expected)">
          {heartbeats.map(([type, entry]) => (
            <div key={type} className="flex items-center gap-3 py-1 px-2 text-xs">
              <span className="text-gray-500 flex-1">{EVENT_META[type]?.label || type}</span>
              <span className="text-gray-600 font-mono">{type}</span>
              <span className="text-gray-500 font-mono w-12 text-right">{entry.count}</span>
              <span className="text-gray-700 font-mono w-20 text-right">{relativeTime(entry.lastSeen)}</span>
            </div>
          ))}
        </Section>
      )}

      {/* Recent events feed */}
      <Section title={`Recent events (last ${recent.length})`}>
        {recent.length === 0 ? (
          <Empty hint="No events in window" />
        ) : (
          <div className="space-y-0.5 max-h-96 overflow-y-auto">
            {recent.map((e, i) => {
              const meta = EVENT_META[e.event_type] || { color: 'text-gray-400' };
              return (
                <div key={i} className="flex items-center gap-3 py-1 px-2 hover:bg-gray-900 rounded text-xs">
                  <span className="text-gray-600 font-mono w-16">{relativeTime(e.timestamp)}</span>
                  <span className={`uppercase tracking-wider w-32 ${meta.color}`}>{meta.kind || 'event'}</span>
                  <span className="text-gray-300 flex-1 truncate">{e.event_type}</span>
                  {e.data?.session_id && (
                    <span className="text-gray-600 font-mono w-20 truncate" title={e.data.session_id}>
                      {e.data.session_id.slice(0, 8)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <div className="text-[10px] text-gray-600">
        Source: <code>{sourcePath}</code> · Range covers {oldest ? new Date(oldest).toISOString().slice(0, 10) : '—'} → {newest ? new Date(newest).toISOString().slice(0, 10) : '—'}
      </div>
    </div>
  );
}

function Card({ label, value, hint, color = 'text-gray-100' }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
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
