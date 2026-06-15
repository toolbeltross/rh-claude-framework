import { useState, useEffect, useMemo } from 'react';
import InfoIcon, { Legend } from './InfoIcon';
import { getModelColor, getModelFamily } from '../lib/model-colors';
import { getAgentTypeColor } from '../lib/style-tokens';
import SubagentTimeline from './SubagentTimeline';

// Backwards-compatible adapter — existing call sites in this file expect a
// Tailwind class string keyed by agent type. Resolution lives in
// `style-tokens.js` (identity-only palette; no status colors).
const TYPE_COLORS = new Proxy({}, {
  get: (_target, key) => getAgentTypeColor(key).text,
});

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function friendlyModel(model) {
  if (!model) return '';
  const m = typeof model === 'string' ? model : model.display_name || model.id || '';
  if (m.includes('opus') || m.includes('Opus')) return 'Opus';
  if (m.includes('sonnet') || m.includes('Sonnet')) return 'Sonnet';
  if (m.includes('haiku') || m.includes('Haiku')) return 'Haiku';
  return m;
}

function formatTokens(n) {
  if (!n && n !== 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

function formatCost(cost) {
  if (!cost && cost !== 0) return '';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function modelDotColor(modelStr) {
  const mc = getModelColor(modelStr);
  return mc.hex;
}

// ── Header stat components ──────────────────────────────────

function HeaderStat({ value, label, color = 'text-gray-400', title }) {
  return (
    <div className="flex flex-col items-center gap-0" title={title}>
      <span className={`text-base font-bold font-mono leading-tight ${color}`}>{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-gray-500">{label}</span>
    </div>
  );
}

function HeaderMiniStat({ value, label, color = 'text-gray-400', title }) {
  return (
    <div className="flex flex-col items-center gap-0" title={title}>
      <span className={`text-xs font-semibold font-mono leading-tight ${color}`}>{value}</span>
      <span className="text-[8px] uppercase tracking-wider text-gray-600">{label}</span>
    </div>
  );
}

function HeaderSep() {
  return <div className="w-px h-6 bg-gray-700 shrink-0" />;
}

// ── Mini context bar for active agents ──────────────────────

function ContextBar({ pct, title }) {
  const color = pct >= 80 ? 'bg-red' : pct >= 50 ? 'bg-amber' : 'bg-green';
  const textColor = pct >= 80 ? 'text-red' : pct >= 50 ? 'text-amber' : 'text-gray-400';
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span className="inline-block w-12 h-1 bg-gray-700 rounded-full overflow-hidden">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className={`text-[10px] font-mono ${textColor}`}>{pct}%</span>
    </span>
  );
}

// ── Expanded detail panel ───────────────────────────────────

function DetailPanel({ agent, isActive }) {
  const tokens = agent.tokens;
  const totalTokens = tokens ? (tokens.input + tokens.output) : 0;
  const modelLabel = friendlyModel(agent.model || agent.modelId || agent._liveModel);

  return (
    <td colSpan={7} className="!p-0 !pb-2 !border-b !border-gray-800">
      {/* Side-by-side prompt + result */}
      <div className="grid grid-cols-2 gap-1.5 px-2 pt-1.5 ml-6">
        <div className="flex flex-col min-h-0">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-600 mb-0.5">Prompt</div>
          <div className="flex-1 min-h-[60px] max-h-40 overflow-y-auto bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-[11px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
            {agent.prompt || (isActive ? 'Loading prompt...' : 'Prompt not captured')}
          </div>
        </div>
        <div className="flex flex-col min-h-0">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-600 mb-0.5">Result</div>
          <div className="flex-1 min-h-[60px] max-h-40 overflow-y-auto bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-[11px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">
            {isActive
              ? <span className="text-gray-600 italic">Agent still running...</span>
              : (agent.lastMessage || 'No result captured')}
          </div>
        </div>
      </div>
      {/* Metadata row */}
      <div className="flex items-center gap-2 flex-wrap px-2 ml-6 mt-1.5 text-[10px] text-gray-600">
        {agent.startedAt && <span title="Start time">{formatTime(agent.startedAt)}</span>}
        {agent.endedAt && <><span>—</span><span title="End time">{formatTime(agent.endedAt)}</span></>}
        {totalTokens > 0 && (
          <span title={`Input: ${formatTokens(tokens.input)} | Output: ${formatTokens(tokens.output)} | Cache Read: ${formatTokens(tokens.cacheRead)} | Cache Write: ${formatTokens(tokens.cacheWrite)}`}>
            <span className="text-gray-300">{formatTokens(tokens.input)}</span> in / <span className="text-green">{formatTokens(tokens.output)}</span> out
          </span>
        )}
        {agent.turns > 0 && <span title="Number of model turns">{agent.turns} turns</span>}
        {modelLabel && (
          <span title={`Model: ${agent.modelId || agent.model || modelLabel}`}>
            {modelLabel}
          </span>
        )}
        {agent.permissionMode && (
          <span className="px-1.5 py-0 rounded-full border text-[9px] bg-gray-800/50 text-gray-500 border-gray-700" title={`Permission mode: ${agent.permissionMode}`}>
            {agent.permissionMode}
          </span>
        )}
        {agent.description && (
          <span className="text-gray-500" title={`Description: ${agent.description}`}>{agent.description}</span>
        )}
        <span className="font-mono ml-auto" title={`Agent ID: ${agent.agentId || ''}`}>
          {(agent.agentId || '').slice(-8)}
        </span>
      </div>
    </td>
  );
}

// ── Main component ──────────────────────────────────────────

export default function AgentActivity({ liveSession }) {
  const active = liveSession?._activeSubagents || {};
  const history = liveSession?._subagentHistory || [];
  const [expandedId, setExpandedId] = useState(null);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const activeEntries = useMemo(() => {
    return Object.entries(active).sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0));
  }, [active]);

  const completedEntries = useMemo(() => {
    const completed = history.filter(a => a.status !== 'orphaned');
    const orphaned = history.filter(a => a.status === 'orphaned');
    completed.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    return [...completed, ...orphaned];
  }, [history]);

  const totalCompleted = history.length;
  const totalCost = useMemo(() => history.reduce((sum, a) => sum + (a.cost || 0), 0), [history]);
  const totalTokens = useMemo(() => history.reduce((sum, a) => {
    if (a.tokens) return sum + (a.tokens.input || 0) + (a.tokens.output || 0);
    return sum;
  }, 0), [history]);
  // `total_cost_usd` from the statusLine payload is MAIN-THREAD cost only — it does
  // not include subagent spend. Dividing agent cost by it alone produced a misleading
  // ratio >100% (e.g. 1900%) on fan-out-heavy sessions. Express instead as the
  // subagents' share of TOTAL session spend (main thread + agents) — a bounded 0–100%.
  const mainThreadCost = liveSession?.cost?.total_cost_usd ?? 0;
  const totalSpend = mainThreadCost + totalCost;
  const pctOfSession = totalSpend > 0 ? Math.round((totalCost / totalSpend) * 100) : 0;

  // Health indicators
  const orphanedCount = useMemo(() => history.filter(a => a.status === 'orphaned').length, [history]);
  const totalFails = useMemo(() => {
    const fromHistory = history.reduce((s, a) => s + (a.failureCount || 0), 0);
    const fromActive = Object.values(active).reduce((s, a) => s + (a._failureCount || 0), 0);
    return fromHistory + fromActive;
  }, [history, active]);
  const transcriptLostCount = useMemo(() => history.filter(a => a.transcriptStatus === 'missing' || a.transcriptStatus === 'parse_failed').length, [history]);

  // Timeline stats
  const compactCount = liveSession?._compactEvents?.length || 0;
  const turnHistory = liveSession?._turnHistory || [];
  const stopCount = turnHistory.filter(t => !t.compact && t.ts).length;

  const version = liveSession?.version || '';

  const hasAnyAgents = activeEntries.length > 0 || completedEntries.length > 0;

  return (
    <div className="px-4 py-2 flex flex-col">
      {/* ── Header stats strip ── */}
      <div data-testid="agents-header-strip" className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 mb-2 flex items-center gap-4 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 shrink-0 inline-flex items-center gap-1.5"
              title="Subagents spawned by Claude. Each runs in its own context.">
          Agents <InfoIcon>
            <div className="space-y-1.5">
              <p>Subagents spawned by Claude. Each runs in its own context. Live telemetry (cost, context fill) is parsed from agent transcripts in real time.</p>
              <div className="flex flex-wrap gap-x-1 gap-y-0.5">
                <Legend color="bg-green" label="active (pulsing)" />
                <Legend color="bg-gray-600" label="completed" />
                <Legend color="bg-red" label="orphaned" />
              </div>
              <p className="text-[10px] text-gray-500">Model shown as colored dot next to name: purple=Opus, blue=Sonnet, cyan=Haiku. Click any row to expand full prompt + result.</p>
            </div>
          </InfoIcon>
        </span>

        <HeaderSep />

        <div className="flex items-center gap-3">
          <HeaderStat value={activeEntries.length} label="active" color="text-green" title="Currently running agents" />
          <HeaderStat value={totalCompleted} label="done" color="text-gray-400" title={`${totalCompleted} completed agents this session`} />
        </div>

        <HeaderSep />

        <div className="flex items-center gap-3">
          <HeaderStat value={formatCost(totalCost)} label="agent cost" color="text-amber" title={`Total agent cost: ${formatCost(totalCost)} — ${pctOfSession}% of ${formatCost(totalSpend)} total spend (main thread ${formatCost(mainThreadCost)} + agents ${formatCost(totalCost)})`} />
          <HeaderMiniStat value={`${pctOfSession}%`} label="of total" title={`Subagents accounted for ${pctOfSession}% of total session spend (main thread ${formatCost(mainThreadCost)} + agents ${formatCost(totalCost)})`} />
          <HeaderMiniStat value={formatTokens(totalTokens)} label="tokens" title={`Total tokens across all completed agents: ${totalTokens.toLocaleString()}`} />
        </div>

        {/* Health indicators — only show when non-zero */}
        {(orphanedCount > 0 || totalFails > 0 || transcriptLostCount > 0) && (
          <>
            <HeaderSep />
            <div className="flex items-center gap-3">
              {orphanedCount > 0 && (
                <HeaderMiniStat value={orphanedCount} label="orphaned" color="text-red" title={`${orphanedCount} agent${orphanedCount > 1 ? 's' : ''} orphaned (no SubagentStop received)`} />
              )}
              {totalFails > 0 && (
                <HeaderMiniStat value={totalFails} label="fails" color="text-red" title={`${totalFails} tool failure${totalFails > 1 ? 's' : ''} across all agents`} />
              )}
              {transcriptLostCount > 0 && (
                <HeaderMiniStat value={transcriptLostCount} label="lost tx" color="text-amber" title={`${transcriptLostCount} agent transcript${transcriptLostCount > 1 ? 's' : ''} not found — cost totals understate spend`} />
              )}
            </div>
          </>
        )}

        <HeaderSep />

        {/* Timeline toggle */}
        <button
          data-testid="timeline-toggle"
          className="flex items-center gap-1.5 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
          onClick={() => setTimelineOpen(!timelineOpen)}
          title="Click to expand/collapse the subagent timeline Gantt chart"
        >
          <span>{timelineOpen ? '▴' : '▾'} timeline</span>
          <span className="text-gray-500">{activeEntries.length + totalCompleted}a{compactCount > 0 ? ` · ${compactCount}c` : ''}{stopCount > 0 ? ` · ${stopCount}s` : ''}</span>
        </button>

        {/* Version badge — far right */}
        {version && (
          <span className="ml-auto px-1.5 py-0 rounded-full border text-[9px] bg-gray-800/50 text-gray-500 border-gray-700 shrink-0 font-mono" title={`Claude Code version (from statusLine): ${version}`}>
            v{version}
          </span>
        )}
      </div>

      {/* ── Timeline (collapsible from header toggle) ── */}
      {timelineOpen && (
        <div className="mb-2">
          <SubagentTimeline liveSession={liveSession} defaultExpanded={true} />
        </div>
      )}

      {/* ── Table ── */}
      {!hasAnyAgents ? (
        <div className="flex items-center justify-center py-6">
          <p className="text-gray-500 text-xs">No agent events yet</p>
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-4 py-1 pr-1 text-left sticky top-0 bg-gray-900 z-10" title="Agent status"></th>
                <th className="py-1 pr-2 text-left sticky top-0 bg-gray-900 z-10 whitespace-nowrap" title="Agent type (model dot: purple=Opus, blue=Sonnet, cyan=Haiku)">Agent</th>
                <th className="py-1 pr-2 text-right sticky top-0 bg-gray-900 z-10 whitespace-nowrap" title="Agent cost (live estimate for active, transcript for completed)">Cost</th>
                <th className="py-1 pr-2 text-right sticky top-0 bg-gray-900 z-10 whitespace-nowrap" title="Context fill (live for active, total tokens for completed)">Ctx</th>
                <th className="py-1 pr-2 text-right sticky top-0 bg-gray-900 z-10 whitespace-nowrap" title="Duration">Dur</th>
                <th className="py-1 pr-2 text-right sticky top-0 bg-gray-900 z-10 whitespace-nowrap" title="Tool calls (last tool in parentheses)">Tools</th>
                <th className="py-1 pl-2 text-left sticky top-0 bg-gray-900 z-10" title="Agent prompt and result. Full text on hover, click row to expand.">Prompt / Result</th>
              </tr>
            </thead>
            <tbody>
              {/* Active agents */}
              {activeEntries.map(([agentId, agent]) => (
                <ActiveAgentRow
                  key={agentId}
                  agentId={agentId}
                  agent={agent}
                  expanded={expandedId === agentId}
                  onToggle={() => setExpandedId(expandedId === agentId ? null : agentId)}
                />
              ))}

              {/* Separator */}
              {activeEntries.length > 0 && completedEntries.length > 0 && (
                <tr><td colSpan={7} className="pt-1.5 pb-0.5 text-[9px] uppercase tracking-widest text-gray-600 border-b-0">completed</td></tr>
              )}

              {/* Completed + orphaned agents */}
              {completedEntries.map((agent) => (
                <CompletedAgentRow
                  key={agent.agentId}
                  agent={agent}
                  expanded={expandedId === agent.agentId}
                  onToggle={() => setExpandedId(expandedId === agent.agentId ? null : agent.agentId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Active agent row ────────────────────────────────────────

function ActiveAgentRow({ agentId, agent, expanded, onToggle }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - agent.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [agent.startedAt]);

  const color = TYPE_COLORS[agent.type] || 'text-gray-300';
  const modelStr = agent._liveModel || agent.model || agent.type;
  const modelHex = modelDotColor(modelStr);
  const toolCount = agent._toolCount || 0;
  const lastTool = agent._lastTool || '';

  // Staleness detection
  const lastSignal = agent._lastToolAt || agent.startedAt || 0;
  const idleReal = Math.max(0, Math.floor((Date.now() - lastSignal) / 1000));
  const isStale = idleReal > 120;
  const isOrphanCandidate = idleReal > 600;

  const compactCrossings = agent._spannedCompactAt?.length || 0;
  const failureCount = agent._failureCount || 0;
  const validationBlockCount = agent._validationBlockCount || 0;

  return (
    <>
      <tr
        className="bg-green/[0.03] cursor-pointer hover:bg-green/[0.06] transition-colors"
        onClick={onToggle}
        title="Click to expand full prompt detail"
      >
        <td className="py-1.5 pr-1 align-middle" style={{ boxShadow: 'inset 3px 0 0 var(--color-green)' }}>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isOrphanCandidate ? 'bg-red animate-pulse-dot' : isStale ? 'bg-amber' : 'bg-green animate-pulse-dot'}`}
            title={isOrphanCandidate ? `Stale: idle ${formatDuration(idleReal * 1000)} — likely orphaned` : isStale ? `Idle ${formatDuration(idleReal * 1000)}` : 'Agent is actively running'}
          />
        </td>
        <td className="py-1.5 pr-2 align-middle whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: modelHex }} title={`Model: ${modelStr}`} />
            <span className={`font-bold ${color}`} title={`Agent type: ${agent.type}`}>{agent.type}</span>
          </span>
          {isStale && !isOrphanCandidate && (
            <span className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40" title={`No tool events for ${formatDuration(idleReal * 1000)}`}>
              idle {formatDuration(idleReal * 1000)}
            </span>
          )}
          {isOrphanCandidate && (
            <span className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-red/10 text-red border-red/40" title={`Idle ${formatDuration(idleReal * 1000)} — likely orphaned`}>
              idle {formatDuration(idleReal * 1000)}
            </span>
          )}
          {compactCrossings > 0 && (
            <span className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40" title={`Ran during ${compactCrossings} compaction event${compactCrossings > 1 ? 's' : ''}`}>
              ↻{compactCrossings}c
            </span>
          )}
          {failureCount > 0 && (
            <span data-testid="agent-failure-count" className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-red/10 text-red border-red/40 font-mono" title={`${failureCount} tool failure${failureCount > 1 ? 's' : ''}${agent._lastError ? ` — last: ${String(agent._lastError).slice(0, 120)}` : ''}`}>
              {failureCount === 1 ? '1 fail' : `${failureCount} fails`}
            </span>
          )}
          {validationBlockCount > 0 && (
            <span data-testid="agent-validation-block-count" className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40 font-mono" title={`${validationBlockCount} Bash call${validationBlockCount > 1 ? 's' : ''} blocked by validator`}>
              {validationBlockCount} blocked
            </span>
          )}
          {agent.parentAgentId && (
            <span data-testid="agent-parent-ref" className="ml-1 text-[10px] text-gray-500 font-mono" title={`Spawned by parent agent ${agent.parentAgentId.slice(-8)}`}>
              ↳ parent {agent.parentAgentId.slice(-8)}
            </span>
          )}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap font-mono">
          {agent._liveCost != null
            ? <span className="text-amber" title={`Live cost estimate: $${agent._liveCost.toFixed(4)}`}>{formatCost(agent._liveCost)}</span>
            : <span className="text-gray-600" title="Cost available after agent completes">—</span>}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap">
          {agent._liveContextPct != null
            ? <ContextBar pct={agent._liveContextPct} title={`Agent context: ${agent._liveContextPct}% filled${agent._liveContextTokens ? ` (${formatTokens(agent._liveContextTokens)} tokens)` : ''}`} />
            : <span className="text-gray-600" title="Context data available after first tool event">—</span>}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap text-gray-400 font-mono" title={`Elapsed: ${formatDuration(elapsed * 1000)}`}>
          {formatDuration(elapsed * 1000)}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap" title={`${toolCount} tool calls${lastTool ? ` (most recent: ${lastTool})` : ''}`}>
          <span className="text-gray-300">{toolCount}</span>
          {lastTool && <span className="text-gray-600 text-[10px] ml-0.5">({lastTool})</span>}
        </td>
        <td className="py-1.5 pl-2 align-top">
          <div className="text-[11px] text-gray-400 whitespace-nowrap overflow-hidden" title={agent.prompt || ''}>
            {agent.prompt || <span className="text-gray-600 italic">Loading prompt...</span>}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-green/[0.02]">
          <DetailPanel agent={{ ...agent, agentId }} isActive={true} />
        </tr>
      )}
    </>
  );
}

// ── Completed agent row ─────────────────────────────────────

function CompletedAgentRow({ agent, expanded, onToggle }) {
  const color = TYPE_COLORS[agent.type] || 'text-gray-300';
  const modelStr = agent.model || agent.modelId || '';
  const modelHex = modelDotColor(modelStr);
  const isOrphaned = agent.status === 'orphaned';
  const tokens = agent.tokens;
  const totalTokens = tokens ? (tokens.input || 0) + (tokens.output || 0) : 0;
  const compactCrossings = agent.spannedCompactAt?.length || 0;
  const failureCount = agent.failureCount || 0;
  const validationBlockCount = agent.validationBlockCount || 0;
  const transcriptLost = agent.transcriptStatus === 'missing' || agent.transcriptStatus === 'parse_failed';

  const rowBg = isOrphaned ? 'bg-red/[0.02]' : '';
  const accentStyle = isOrphaned ? { boxShadow: 'inset 3px 0 0 var(--color-red)' } : {};

  return (
    <>
      <tr
        className={`${rowBg} cursor-pointer hover:bg-gray-800/30 transition-colors`}
        onClick={onToggle}
        title="Click to expand full prompt and result"
      >
        <td className="py-1.5 pr-1 align-middle" style={accentStyle}>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isOrphaned ? 'bg-red' : 'bg-gray-600'}`}
            title={isOrphaned ? `Orphaned — no SubagentStop received (${Math.round((agent.orphanedAfterMs || 0) / 60_000)} min idle)` : 'Agent completed'}
          />
        </td>
        <td className="py-1.5 pr-2 align-middle whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: modelHex }} title={`Model: ${agent.modelId || agent.model || ''}`} />
            <span className={`font-bold ${color}`} title={`Agent type: ${agent.type}`}>{agent.type}</span>
          </span>
          {isOrphaned && (
            <span className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-red/10 text-red border-red/40" title="No SubagentStop received — likely dropped by compaction, parent interrupt, or hook failure">
              orphaned
            </span>
          )}
          {compactCrossings > 0 && (
            <span className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40" title={`Ran during ${compactCrossings} compaction event${compactCrossings > 1 ? 's' : ''}`}>
              ↻{compactCrossings}c
            </span>
          )}
          {failureCount > 0 && (
            <span data-testid="completed-agent-failure-count" className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-red/10 text-red border-red/40 font-mono" title={`${failureCount} tool failure${failureCount > 1 ? 's' : ''}${agent.lastError ? ` — last: ${String(agent.lastError).slice(0, 120)}` : ''}`}>
              {failureCount === 1 ? '1 fail' : `${failureCount} fails`}
            </span>
          )}
          {validationBlockCount > 0 && (
            <span data-testid="completed-agent-validation-block-count" className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40 font-mono" title={`${validationBlockCount} Bash call${validationBlockCount > 1 ? 's' : ''} blocked by validator`}>
              {validationBlockCount} blocked
            </span>
          )}
          {transcriptLost && (
            <span data-testid="completed-agent-transcript-lost" className="ml-1 text-[10px] px-1.5 py-0 rounded-full border bg-amber/10 text-amber border-amber/40" title={`Transcript ${agent.transcriptStatus === 'missing' ? 'file not found' : 'could not be parsed'} — token/cost data unavailable`}>
              transcript lost
            </span>
          )}
          {agent.parentAgentId && (
            <span data-testid="agent-parent-ref" className="ml-1 text-[10px] text-gray-500 font-mono" title={`Spawned by parent agent ${agent.parentAgentId.slice(-8)}`}>
              ↳ parent {agent.parentAgentId.slice(-8)}
            </span>
          )}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap font-mono">
          {agent.cost != null
            ? <span className={agent.costEstimated ? 'text-amber/60' : 'text-amber'} title={agent.costEstimated ? `Estimated: ~$${agent.cost.toFixed(4)}` : `Cost: $${agent.cost.toFixed(4)}`}>
                {agent.costEstimated ? '~' : ''}{formatCost(agent.cost)}
              </span>
            : <span className="text-gray-600">—</span>}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap font-mono text-gray-500 text-[10px]" title={`Total tokens: ${totalTokens.toLocaleString()}`}>
          {totalTokens > 0 ? formatTokens(totalTokens) : '—'}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap text-gray-500" title={agent.durationMs ? `Duration: ${formatDuration(agent.durationMs)}` : 'Duration unknown'}>
          {agent.durationMs ? formatDuration(agent.durationMs) : '?'}
        </td>
        <td className="py-1.5 pr-2 text-right align-middle whitespace-nowrap text-gray-500" title={`${agent.toolCount || 0} tool calls${agent.lastTool ? ` (last: ${agent.lastTool})` : ''}`}>
          {agent.toolCount || 0}
        </td>
        <td className="py-1.5 pl-2 align-top">
          {agent.prompt && (
            <div className="text-[11px] text-gray-400 whitespace-nowrap overflow-hidden" title={agent.prompt}>
              {agent.prompt}
            </div>
          )}
          {agent.lastMessage && (
            <div className={`text-[11px] whitespace-nowrap overflow-hidden mt-0.5 ${isOrphaned ? 'text-red italic' : failureCount > 0 ? 'text-red/80' : 'text-gray-500'}`} title={agent.lastMessage}>
              {agent.lastMessage}
            </div>
          )}
          {isOrphaned && !agent.lastMessage && (
            <div className="text-[11px] text-red italic whitespace-nowrap overflow-hidden mt-0.5">
              no result — orphaned after {agent.orphanedAfterMs ? formatDuration(agent.orphanedAfterMs) : '?'} idle
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={isOrphaned ? 'bg-red/[0.02]' : ''}>
          <DetailPanel agent={agent} isActive={false} />
        </tr>
      )}
    </>
  );
}
