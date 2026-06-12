import { useState } from 'react';
import { useSubagents } from '../hooks/useSubagents.js';
import { formatN, formatUsd, relativeTime } from '../lib/format.js';
import { getModelColor, getModelFamily } from '../../src/lib/model-colors';

const RECENT_LIMIT = 50;

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function ModelDot({ modelId }) {
  if (!modelId) return <span className="text-gray-600">—</span>;
  const color = getModelColor(modelId);
  return (
    <span className="inline-flex items-center gap-1.5" title={modelId}>
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: color.hex }} />
      <span className="text-gray-300">{getModelFamily(modelId)}</span>
    </span>
  );
}

function StatusBadge({ status }) {
  if (!status) {
    return (
      <span
        className="px-1.5 py-0 text-[10px] rounded-full bg-gray-800/50 text-gray-500 border border-gray-700"
        title="No toolUseResult found in the parent transcript — parent pruned, or run did not complete a dispatch round-trip"
      >
        unknown
      </span>
    );
  }
  if (status === 'completed') {
    return <span className="px-1.5 py-0 text-[10px] rounded-full bg-green/10 text-green border border-green/40">completed</span>;
  }
  return <span className="px-1.5 py-0 text-[10px] rounded-full bg-red/10 text-red border border-red/40">{status}</span>;
}

/**
 * Surface 3 — Subagents (plan 3.3, v2-ia.md).
 * Cross-session leaderboard from <sessionId>/subagents/agent-*.jsonl
 * transcripts, joined with each parent's toolUseResult for type/status.
 */
export default function SubagentsSurface() {
  const { data, loading, error } = useSubagents();
  const [expanded, setExpanded] = useState(null);

  if (loading && !data) return <div className="p-12 text-center text-sm text-gray-400">Loading subagents…</div>;
  if (error) return <div className="p-12 text-center text-sm text-red-400">{error}</div>;
  if (!data) return null;

  const { agents = [], byType = [], totalAgents } = data;
  const totalCost = byType.reduce((sum, r) => sum + r.totalCost, 0);
  const totalFails = byType.reduce((sum, r) => sum + r.fails, 0);
  const recent = agents.slice(0, RECENT_LIMIT);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Subagents</h1>
          <p className="text-xs text-gray-500 mt-1">
            Cross-session subagent activity from on-disk agent transcripts
            (<code className="text-gray-400">~/.claude/projects/*/&lt;session&gt;/subagents/</code>).
            Type and status joined from each parent session's dispatch records.
          </p>
        </div>
        <span className="text-[10px] text-gray-600 font-mono" title="Aggregator last recompute">
          computed {relativeTime(data.lastComputedAt)}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <Card label="Agent runs" value={formatN(totalAgents)} hint="agent transcripts on disk" />
        <Card label="Agent types" value={formatN(byType.length)} hint="distinct subagent_type values" />
        <Card label="Total cost" value={formatUsd(totalCost)} hint="estimated from per-model token usage" />
        <Card
          label="Non-completed"
          value={formatN(totalFails)}
          hint="status other than 'completed' (killed, errored, orphaned)"
          color={totalFails > 0 ? 'text-red' : 'text-gray-100'}
        />
      </div>

      {/* Leaderboard by type */}
      <Section title="By agent type (ranked by total cost)">
        {byType.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-xs text-gray-500">No subagent activity yet</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2" title="subagent_type from the dispatching Agent tool call">Type</th>
                <th className="px-3 py-2 text-right" title="agent transcripts of this type">Runs</th>
                <th className="px-3 py-2 text-right" title="estimated cost across all runs">∑ Cost</th>
                <th className="px-3 py-2 text-right" title="input + output + cache tokens">∑ Tokens</th>
                <th className="px-3 py-2 text-right" title="mean wall-clock duration per run">Avg dur</th>
                <th className="px-3 py-2 text-right" title="runs with status ≠ completed">Fails</th>
                <th className="px-3 py-2" title="model with the most tokens across this type's runs">Top model</th>
              </tr>
            </thead>
            <tbody>
              {byType.map((r) => (
                <tr key={r.agentType} className="border-b border-gray-800/50 hover:bg-gray-800/40">
                  <td className="px-3 py-1.5 text-gray-200 font-mono">{r.agentType}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-100">{r.runs}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-100">{formatUsd(r.totalCost)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-300">{formatN(r.totalTokens)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtDuration(r.avgDurationMs)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${r.fails > 0 ? 'text-red' : 'text-gray-600'}`}>
                    {r.fails > 0 ? r.fails : '—'}
                  </td>
                  <td className="px-3 py-1.5"><ModelDot modelId={r.topModel} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Recent runs */}
      <Section title={`Recent agent runs (last ${recent.length} — click a row for prompt detail)`}>
        {recent.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-xs text-gray-500">No agent runs yet</div>
        ) : (
          <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 w-[10%]" title="Last activity in the agent transcript">When</th>
                <th className="px-3 py-2 w-[20%]" title="subagent_type">Type</th>
                <th className="px-3 py-2 w-[11%]" title="Primary model">Model</th>
                <th className="px-3 py-2 w-[8%] text-right" title="Estimated cost">Cost</th>
                <th className="px-3 py-2 w-[9%] text-right" title="Total tokens">Tokens</th>
                <th className="px-3 py-2 w-[9%] text-right" title="Wall-clock duration">Dur</th>
                <th className="px-3 py-2 w-[12%]" title="Run outcome">Status</th>
                <th className="px-3 py-2 w-[21%]" title="Parent session id">Session</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <RecentRow
                  key={a.agentId}
                  agent={a}
                  expanded={expanded === a.agentId}
                  onToggle={() => setExpanded(expanded === a.agentId ? null : a.agentId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function RecentRow({ agent: a, expanded, onToggle }) {
  const accent = a.status && a.status !== 'completed' ? 'inset 3px 0 0 var(--color-red)' : undefined;
  return (
    <>
      <tr
        className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer"
        onClick={onToggle}
        title={a.prompt || a.agentId}
      >
        <td className="px-3 py-1.5 font-mono text-gray-400" style={accent ? { boxShadow: accent } : undefined}>
          {relativeTime(a.lastTs)}
        </td>
        <td className="px-3 py-1.5 font-mono whitespace-nowrap overflow-hidden text-gray-200">{a.agentType || '—'}</td>
        <td className="px-3 py-1.5 whitespace-nowrap overflow-hidden"><ModelDot modelId={a.primaryModel} /></td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-100">{formatUsd(a.totalCost)}</td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-300">{formatN(a.totalTokens)}</td>
        <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtDuration(a.durationMs)}</td>
        <td className="px-3 py-1.5"><StatusBadge status={a.status} /></td>
        <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap overflow-hidden" title={a.parentSessionId || ''}>
          {a.parentSessionId ? a.parentSessionId.slice(0, 8) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-800/50 bg-gray-950/60">
          <td colSpan={8} className="px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-gray-600 mb-0.5">Prompt</div>
            <div className="text-xs text-gray-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {a.prompt || 'No prompt captured for this run'}
            </div>
            <div className="mt-2 text-[10px] text-gray-600 font-mono">
              agent {a.agentId} · {a.messageCount} msgs · {a.toolCallCount} tool calls · project {a.projectDir || '—'}
            </div>
          </td>
        </tr>
      )}
    </>
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
