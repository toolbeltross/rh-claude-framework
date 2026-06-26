import { useEffect, useState } from 'react';
import { formatN, formatUsd, relativeTime, isoDate } from '../lib/format.js';
import { getModelColor, getModelFamily } from '../../src/lib/model-colors';

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

/**
 * Drill-through detail for one historical (or live) session.
 * Data: GET /api/sessions/:id — rolled-up record + deep transcript parse
 * (prompt timeline, per-tool counts) + this session's subagent runs.
 */
export default function SessionDetail({ sessionId, ccdMeta, onBack }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} — transcript may have been pruned`))))
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [sessionId]);

  const title = ccdMeta?.title;
  const pr = ccdMeta?.prNumber ? { n: ccdMeta.prNumber, state: ccdMeta.prState } : null;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <button
          onClick={onBack}
          className="px-2 py-1 rounded bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-xs"
          title="Back to the sessions list"
        >
          ‹ Sessions
        </button>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-100 whitespace-nowrap overflow-hidden">
            {title || detail?.projectPath?.split(/[\\/]/).pop() || sessionId.slice(0, 8)}
          </h1>
          <div className="text-xs text-gray-500 font-mono mt-0.5" title={detail?.projectPath || ''}>
            {sessionId}
            {pr && (
              <span
                className={`ml-2 px-1.5 py-0 rounded-full border text-[10px] ${
                  pr.state === 'MERGED'
                    ? 'bg-accent/10 text-accent border-accent/40'
                    : 'bg-green/10 text-green border-green/40'
                }`}
                title={`Pull request #${pr.n} — ${pr.state || 'open'}`}
              >
                PR #{pr.n} · {pr.state || 'OPEN'}
              </span>
            )}
          </div>
        </div>
      </div>

      {error && <div className="p-8 text-center text-sm text-red-400">{error}</div>}
      {!detail && !error && <div className="p-8 text-center text-sm text-gray-400">Loading session…</div>}

      {detail && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-5 gap-3">
            <Card label="Cost" value={formatUsd(detail.totalCost)} hint="estimated from per-model token usage" />
            <Card label="Messages" value={formatN(detail.messageCount)} hint="user + assistant messages" />
            <Card label="Tool calls" value={formatN(detail.toolCallCount)} hint="tool_use blocks" />
            <Card label="Duration" value={fmtDuration(detail.durationMs)} hint={`${isoDate(detail.firstTs)} → last activity ${relativeTime(detail.lastTs)}`} />
            <Card label="Prompts" value={formatN(detail.promptCount)} hint="user prompts in this session" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Model breakdown */}
            <Section title="Models">
              {Object.keys(detail.models).length === 0 ? (
                <Empty text="No model usage recorded" />
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                      <th className="px-2 py-1.5">Model</th>
                      <th className="px-2 py-1.5 text-right" title="fresh input tokens">In</th>
                      <th className="px-2 py-1.5 text-right" title="output tokens">Out</th>
                      <th className="px-2 py-1.5 text-right" title="cache read tokens">Cache rd</th>
                      <th className="px-2 py-1.5 text-right" title="cache write tokens">Cache wr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(detail.models)
                      .filter(([id]) => id !== '<synthetic>') // system-message bucket, no real usage
                      .map(([id, t]) => {
                      const c = getModelColor(id);
                      return (
                        <tr key={id} className="border-b border-gray-800/50">
                          <td className="px-2 py-1.5">
                            <span className="inline-flex items-center gap-1.5" title={id}>
                              <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: c.hex }} />
                              <span className="text-gray-200">{getModelFamily(id)}</span>
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-gray-300">{formatN(t.input)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-gray-300">{formatN(t.output)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-gray-400">{formatN(t.cacheRead)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-gray-400">{formatN(t.cacheWrite)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Tool usage */}
            <Section title={`Tools (${formatN(detail.toolCallCount)} calls)`}>
              {Object.keys(detail.toolsByName).length === 0 ? (
                <Empty text="No tool calls" />
              ) : (
                <div className="space-y-1">
                  {Object.entries(detail.toolsByName)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([name, count]) => {
                      const max = Math.max(...Object.values(detail.toolsByName));
                      return (
                        <div key={name} className="flex items-center gap-2 text-xs" title={`${name}: ${count} calls`}>
                          <span className="w-36 text-gray-300 font-mono whitespace-nowrap overflow-hidden">{name}</span>
                          <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
                            <div className="h-full bg-blue/60 rounded" style={{ width: `${(count / max) * 100}%` }} />
                          </div>
                          <span className="w-10 text-right font-mono text-gray-400">{count}</span>
                        </div>
                      );
                    })}
                </div>
              )}
            </Section>
          </div>

          {/* Subagents of this session */}
          <Section title={`Subagent runs (${detail.subagents.length})`}>
            {detail.subagents.length === 0 ? (
              <Empty text="No subagent transcripts for this session" />
            ) : (
              <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                    <th className="px-2 py-1.5 w-[22%]">Type</th>
                    <th className="px-2 py-1.5 w-[12%]">Model</th>
                    <th className="px-2 py-1.5 w-[10%] text-right">Cost</th>
                    <th className="px-2 py-1.5 w-[10%] text-right">Tokens</th>
                    <th className="px-2 py-1.5 w-[10%] text-right">Dur</th>
                    <th className="px-2 py-1.5 w-[36%]">Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.subagents.map((a) => {
                    const c = getModelColor(a.primaryModel);
                    return (
                      <tr key={a.agentId} className="border-b border-gray-800/50" title={a.prompt || a.agentId}>
                        <td className="px-2 py-1.5 font-mono text-gray-200 whitespace-nowrap overflow-hidden">{a.agentType || '—'}</td>
                        <td className="px-2 py-1.5">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: c.hex }} />
                            <span className="text-gray-300">{getModelFamily(a.primaryModel) || '—'}</span>
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-100">{formatUsd(a.totalCost)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-300">{formatN(a.totalTokens)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-300">{fmtDuration(a.durationMs)}</td>
                        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap overflow-hidden">{a.prompt || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Section>

          {/* Prompt timeline */}
          <Section title={`Prompt timeline (${detail.prompts.length}${detail.promptCount > detail.prompts.length ? ` of ${detail.promptCount}` : ''})`}>
            {detail.prompts.length === 0 ? (
              <Empty text="No user prompts captured" />
            ) : (
              <div className="space-y-1.5 max-h-96 overflow-y-auto">
                {detail.prompts.map((p, i) => (
                  <div key={i} className="flex gap-3 text-xs" title={p.text}>
                    <span className="text-gray-600 font-mono shrink-0 w-12" title={p.ts || ''}>{fmtTime(p.ts)}</span>
                    <span className="text-gray-300 whitespace-nowrap overflow-hidden">{p.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Card({ label, value, hint }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-100">{value}</div>
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

function Empty({ text }) {
  return <div className="flex items-center justify-center py-4 text-xs text-gray-500">{text}</div>;
}
