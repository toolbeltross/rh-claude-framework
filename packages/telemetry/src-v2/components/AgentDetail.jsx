import { useEffect, useState } from 'react';
import { formatN, formatUsd, relativeTime } from '../lib/format.js';
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

/**
 * Drill-through detail for one subagent run.
 * Data: GET /api/subagents/:id — agent record + tool histogram from the
 * agent's own transcript.
 */
export default function AgentDetail({ agentId, onBack, onOpenSession }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    fetch(`/api/subagents/${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} — agent transcript may have been pruned`))))
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [agentId]);

  const color = getModelColor(detail?.primaryModel);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start gap-3">
        <button
          onClick={onBack}
          className="px-2 py-1 rounded bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-xs"
          title="Back to the subagents list"
        >
          ‹ Subagents
        </button>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-100 font-mono flex items-center gap-2">
            {detail?.primaryModel && (
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: color.hex }} title={detail.primaryModel} />
            )}
            {detail?.agentType || agentId.slice(0, 12)}
            {detail?.status && (
              <span
                className={`px-1.5 py-0 text-[10px] rounded-full border font-sans ${
                  detail.status === 'completed'
                    ? 'bg-green/10 text-green border-green/40'
                    : 'bg-red/10 text-red border-red/40'
                }`}
              >
                {detail.status}
              </span>
            )}
          </h1>
          <div className="text-xs text-gray-500 font-mono mt-0.5">
            agent {agentId}
            {detail?.parentSessionId && (
              <>
                {' · spawned by '}
                <button
                  onClick={() => onOpenSession?.(detail.parentSessionId)}
                  className="text-blue hover:underline"
                  title="Open the parent session's detail view"
                >
                  {detail.parentSessionId.slice(0, 8)}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <div className="p-8 text-center text-sm text-red-400">{error}</div>}
      {!detail && !error && <div className="p-8 text-center text-sm text-gray-400">Loading agent…</div>}

      {detail && (
        <>
          <div className="grid grid-cols-5 gap-3">
            <Card label="Cost" value={formatUsd(detail.totalCost)} hint="estimated from per-model token usage" />
            <Card label="Tokens" value={formatN(detail.totalTokens)} hint="input + output + cache" />
            <Card label="Tool calls" value={formatN(detail.toolCallCount)} hint="from parent dispatch record when available" />
            <Card label="Duration" value={fmtDuration(detail.durationMs)} hint={`last activity ${relativeTime(detail.lastTs)}`} />
            <Card label="Model" value={getModelFamily(detail.primaryModel) || '—'} hint={detail.primaryModel || ''} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Section title="Dispatch prompt">
              <div className="text-xs text-gray-300 whitespace-pre-wrap max-h-72 overflow-y-auto">
                {/* deep-parse prompt (500 chars from the agent transcript) over the
                    parent-record slice (300 chars) — whichever carries more */}
                {(detail.prompts?.[0]?.text?.length > (detail.prompt?.length || 0)
                  ? detail.prompts[0].text
                  : detail.prompt) || 'No prompt captured'}
              </div>
            </Section>

            <Section title="Tools used">
              {Object.keys(detail.toolsByName).length === 0 ? (
                <div className="flex items-center justify-center py-4 text-xs text-gray-500">No tool calls in transcript</div>
              ) : (
                <div className="space-y-1">
                  {Object.entries(detail.toolsByName)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 14)
                    .map(([name, count]) => {
                      const max = Math.max(...Object.values(detail.toolsByName));
                      return (
                        <div key={name} className="flex items-center gap-2 text-xs" title={`${name}: ${count} calls`}>
                          <span className="w-36 text-gray-300 font-mono whitespace-nowrap overflow-hidden">{name}</span>
                          <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
                            <div className="h-full bg-cyan/60 rounded" style={{ width: `${(count / max) * 100}%` }} />
                          </div>
                          <span className="w-10 text-right font-mono text-gray-400">{count}</span>
                        </div>
                      );
                    })}
                </div>
              )}
            </Section>
          </div>
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
