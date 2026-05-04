import { useState, useMemo, useEffect } from 'react';
import InfoIcon, { Legend } from './InfoIcon';

const ERROR_CLASS_COLORS = {
  not_found: 'text-gray-400',
  permission: 'text-amber',
  size_limit: 'text-amber',
  timeout: 'text-red',
  network: 'text-red',
  validation: 'text-amber',
  suggestion: 'text-green',
  config: 'text-amber',
  orphan: 'text-red',
  other: 'text-gray-400',
};

function formatCost(cost) {
  if (!cost && cost !== 0) return '';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

const TOOL_COLORS = {
  Read: 'text-blue',
  Write: 'text-blue',
  Edit: 'text-blue',
  Bash: 'text-cyan',
  Glob: 'text-accent',
  Grep: 'text-accent',
  Agent: 'text-accent',
};

function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getToolColor(name) {
  return TOOL_COLORS[name] || 'text-gray-300';
}

export default function FailureHistory({ failureEvents, failurePatterns, failureAlerts, sessionId, toolEvents, expanded: isTabView }) {
  const [expanded, setExpanded] = useState(null);
  const [sortByCost, setSortByCost] = useState(false);
  const [hookHealth, setHookHealth] = useState(null);

  // D5 — poll hook-forwarder self-health every 60s (cheap: reads log tail)
  useEffect(() => {
    let cancelled = false;
    async function fetchHealth() {
      try {
        const res = await fetch('/api/hook-health');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setHookHealth(data);
      } catch {}
    }
    fetchHealth();
    const id = setInterval(fetchHealth, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Filter by session if provided
  const rawFiltered = sessionId
    ? failureEvents.filter(e => e.sessionId === sessionId)
    : failureEvents;

  // D4 — optional sort by estimated cost
  const filtered = useMemo(() => {
    if (!sortByCost) return rawFiltered;
    return [...rawFiltered].sort((a, b) => (b.estimatedCost || 0) - (a.estimatedCost || 0));
  }, [rawFiltered, sortByCost]);

  const total = failurePatterns?.total ?? filtered.length;
  const topTool = failurePatterns?.byTool
    ? Object.entries(failurePatterns.byTool).sort((a, b) => b[1] - a[1])[0]
    : null;

  // D1 — error-class breakdown from filtered events (session scoped)
  const classCounts = useMemo(() => {
    const out = {};
    for (const ev of rawFiltered) {
      const cls = ev.errorClass || 'other';
      out[cls] = (out[cls] || 0) + 1;
    }
    return out;
  }, [rawFiltered]);

  // D4 — top 3 most expensive failures in the filtered set
  const topCost = useMemo(() => {
    return [...rawFiltered]
      .filter((e) => typeof e.estimatedCost === 'number' && e.estimatedCost > 0)
      .sort((a, b) => (b.estimatedCost || 0) - (a.estimatedCost || 0))
      .slice(0, 3);
  }, [rawFiltered]);

  // Compute per-tool failure rates from toolEvents (unified stream).
  // Skips non-tool-execution event types (validation suggestions, config
  // changes, orphan sweeps) which would otherwise inflate Bash's denominator
  // or fake failures that never corresponded to an actual tool call.
  const failureRates = useMemo(() => {
    if (!toolEvents || toolEvents.length === 0) return {};
    const NON_EXECUTION = new Set(['validation_suggest', 'config_change', 'subagent_orphaned']);
    const counts = {}; // { [tool]: { total: N, failures: N } }
    for (const ev of toolEvents) {
      if (NON_EXECUTION.has(ev.type)) continue;
      const tool = ev.tool || 'unknown';
      if (!counts[tool]) counts[tool] = { total: 0, failures: 0 };
      counts[tool].total++;
      if (!ev.success) counts[tool].failures++;
    }
    return counts;
  }, [toolEvents]);

  // Check for active alerts matching this session
  const activeAlerts = useMemo(() => {
    if (!failureAlerts || failureAlerts.length === 0) return [];
    if (sessionId) return failureAlerts.filter(a => a.sessionId === sessionId);
    return failureAlerts;
  }, [failureAlerts, sessionId]);

  const hasActiveAlert = activeAlerts.length > 0;

  return (
    <div className={`${isTabView ? '' : 'bg-gray-900 border border-gray-800 rounded-lg'} px-4 py-2 h-full flex flex-col`}>
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 shrink-0 inline-flex items-center gap-1.5" title="Persistent log of tool failures, validation blocks, tool suggestions, config changes, and orphaned subagents — survives server restarts">
          Events &amp; Failures
          {total > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-red/20 text-red rounded-full font-mono">
              {total}
            </span>
          )}
          {hasActiveAlert && (
            <span
              className="ml-1 inline-block w-2.5 h-2.5 rounded-full bg-red animate-pulse-dot"
              title={`Alert: ${activeAlerts[0].toolName} failed ${activeAlerts[0].count}+ times in 10 min`}
            />
          )}
          <InfoIcon>
            <div className="space-y-1.5">
              <p>Persistent failure tracking across all sessions. Data survives server restarts.</p>
              <div className="flex flex-wrap gap-x-1 gap-y-0.5">
                <Legend color="bg-red" label="tool failure" />
                <Legend color="bg-amber" label="validation block" />
                <Legend color="bg-green" label="tool suggestion" />
                <Legend color="bg-cyan" label="config change" />
                <Legend color="bg-accent" label="orphaned agent" />
              </div>
              <p className="text-[10px] text-gray-500">Query API: /api/failures, /api/failures/patterns, /api/failures/digest</p>
            </div>
          </InfoIcon>
        </h2>
        {topTool && (
          <span className="text-[10px] text-gray-500 ml-auto" title={`Most failing tool (all time): ${topTool[0]} with ${topTool[1]} failures`}>
            top: <span className={getToolColor(topTool[0])}>{topTool[0]}</span> ({topTool[1]})
          </span>
        )}
        {/* D5 — hook-forwarder health chip */}
        {hookHealth && (
          <span
            data-testid="hook-health-chip"
            className={`text-[10px] px-1.5 py-0 rounded-full border shrink-0 font-mono ${
              hookHealth.healthy
                ? 'bg-green/10 text-green border-green/40'
                : 'bg-red/10 text-red border-red/40'
            }`}
            title={
              hookHealth.healthy
                ? `hook-forwarder healthy · transcript P95 ${hookHealth.transcriptP95Ms}ms (${hookHealth.transcriptSamples} samples)`
                : `hook-forwarder: ${hookHealth.errorCount} recent error line${hookHealth.errorCount > 1 ? 's' : ''} in ${hookHealth.logPath}`
            }
          >
            {hookHealth.healthy ? 'hooks ok' : `hooks ${hookHealth.errorCount} err`}
          </span>
        )}
      </div>

      {/* D1 — error-class breakdown chips */}
      {Object.keys(classCounts).length > 0 && (
        <div
          data-testid="error-class-breakdown"
          className="flex flex-wrap gap-1.5 text-[10px] mb-1"
        >
          {Object.entries(classCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([cls, count]) => (
              <span
                key={cls}
                className={`px-1.5 py-0 rounded-full border border-gray-700 bg-gray-800/50 font-mono ${ERROR_CLASS_COLORS[cls] || 'text-gray-400'}`}
                title={`${count} failure${count > 1 ? 's' : ''} classified as ${cls}`}
              >
                {cls} · {count}
              </span>
            ))}
        </div>
      )}

      {/* D4 — top-cost failures panel */}
      {topCost.length > 0 && (
        <div data-testid="top-cost-failures" className="text-[10px] mb-1 border border-gray-800 rounded p-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-gray-400 uppercase tracking-wider">Top cost</span>
            <button
              onClick={() => setSortByCost(!sortByCost)}
              className={`ml-auto px-1.5 py-0 rounded-full border font-mono ${sortByCost ? 'bg-amber/20 text-amber border-amber/40' : 'bg-gray-800 text-gray-400 border-gray-700'}`}
              title="Toggle: sort the full failure list by estimated cost (desc)"
            >
              {sortByCost ? 'sort: cost' : 'sort: time'}
            </button>
          </div>
          {topCost.map((e, i) => (
            <div key={e.id || i} className="flex items-center gap-1.5 text-gray-500">
              <span className="text-amber font-mono">{formatCost(e.estimatedCost)}</span>
              <span className={getToolColor(e.toolName)}>{e.toolName}</span>
              <span className="truncate">{(e.error || '').slice(0, 60)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Failure rate summary — per-tool rates from unified toolEvents */}
      {Object.keys(failureRates).some(t => failureRates[t].failures > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500 mb-1">
          {Object.entries(failureRates)
            .filter(([, v]) => v.failures > 0)
            .sort((a, b) => b[1].failures - a[1].failures)
            .map(([tool, { total: t, failures: f }]) => (
              <span key={tool} title={`${f} failures out of ${t} total calls for ${tool}`}>
                <span className={getToolColor(tool)}>{tool}</span>: {f}/{t} ({Math.round((f / t) * 100)}%)
              </span>
            ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-500 text-sm">No failures recorded</p>
        </div>
      ) : (
        <div className={`flex-1 overflow-auto space-y-1 ${isTabView ? 'max-h-[calc(100vh-320px)]' : 'max-h-48'}`}>
          {filtered.map((event, i) => {
            const isBlock = event.eventType === 'validation_block';
            const isSuggest = event.eventType === 'validation_suggest';
            const isOrphan = event.eventType === 'subagent_orphaned';
            const isConfig = event.eventType === 'config_change';
            const dotColor =
              isOrphan ? 'bg-accent' :
              isConfig ? 'bg-cyan' :
              isSuggest ? 'bg-green' :
              isBlock ? 'bg-amber' :
              'bg-red';
            const labelText =
              isOrphan ? 'orphaned agent' :
              isConfig ? 'config change' :
              isSuggest ? 'tool suggestion' :
              isBlock ? 'validation block' :
              null;
            const errorText = event.error || 'Unknown error';
            const isExpanded = expanded === i;
            const rate = failureRates[event.toolName];

            return (
              <div
                key={event.id || i}
                className={`text-xs py-0.5 rounded hover:bg-gray-800/50 transition-colors cursor-pointer ${isBlock ? 'bg-amber/5' : ''}`}
                onClick={() => setExpanded(isExpanded ? null : i)}
              >
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-gray-500 font-mono shrink-0 text-[11px]" title={event.isoTime || new Date(event.timestamp).toISOString()}>
                    {formatTime(event.timestamp)}
                  </span>
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`}
                    title={
                      isOrphan ? 'Subagent never emitted SubagentStop' :
                      isConfig ? 'Settings file modified during session' :
                      isSuggest ? 'Non-blocking tool suggestion from validator' :
                      isBlock ? 'Blocked by validation' :
                      'Tool call failed'
                    }
                  />
                  <span className={`font-semibold shrink-0 ${getToolColor(event.toolName)}`}>
                    {event.toolName}
                  </span>
                  {labelText && (
                    <span
                      className={`text-[10px] px-1.5 py-0 rounded-full border shrink-0 ${
                        isOrphan ? 'bg-accent/10 text-accent border-accent/40' :
                        isConfig ? 'bg-cyan/10 text-cyan border-cyan/40' :
                        isSuggest ? 'bg-green/10 text-green border-green/40' :
                        'bg-amber/10 text-amber border-amber/40'
                      }`}
                      title={
                        isOrphan ? 'Subagent was swept by the orphan detector' :
                        isConfig ? 'Settings file was modified during this session — can cause hook drift' :
                        isSuggest ? 'Tool-validator suggested a better tool (non-blocking)' :
                        'Pre-flight validator blocked this call'
                      }
                    >
                      {labelText}
                    </span>
                  )}
                  {rate && rate.total > 0 && (
                    <span
                      className="text-[10px] text-gray-600 shrink-0"
                      title={`${rate.failures} failures out of ${rate.total} total calls for ${event.toolName}`}
                    >
                      ({Math.round((rate.failures / rate.total) * 100)}%)
                    </span>
                  )}
                  {/* D2 — retry badge */}
                  {event.retrySequence > 0 && (
                    <span
                      data-testid="failure-retry-badge"
                      className="text-[10px] px-1.5 py-0 rounded-full border bg-red/10 text-red border-red/40 shrink-0 font-mono"
                      title={`Same tool+input was retried without Claude changing approach. Retry #${event.retrySequence}${event.retryOf ? ` of original failure` : ''} — oversight system may have failed to correct.`}
                    >
                      retry #{event.retrySequence}
                    </span>
                  )}
                  {/* D1 — error-class chip inline */}
                  {event.errorClass && event.errorClass !== 'other' && (
                    <span
                      className={`text-[10px] shrink-0 ${ERROR_CLASS_COLORS[event.errorClass] || 'text-gray-500'}`}
                      title={`Error class: ${event.errorClass}`}
                    >
                      [{event.errorClass}]
                    </span>
                  )}
                  <span className={`truncate ${isBlock ? 'text-amber' : 'text-red/80'}`}>
                    {errorText.slice(0, 80)}{errorText.length > 80 ? '...' : ''}
                  </span>
                  {event.sessionId && (
                    <span className="text-gray-600 font-mono text-[10px] shrink-0 ml-auto" title={`Session: ${event.sessionId}`}>
                      {event.sessionId.slice(0, 8)}
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <div className="mt-1 ml-6 p-2 bg-gray-800/50 rounded text-[11px] space-y-1">
                    <div className="text-gray-400">
                      <span className="text-gray-500">Error: </span>
                      <span className="text-red/90 break-all">{errorText}</span>
                    </div>
                    {event.durationMs != null && (
                      <div className="text-gray-500">
                        <span>Duration: </span>{event.durationMs}ms
                      </div>
                    )}
                    {event.cwd && (
                      <div className="text-gray-500">
                        <span>CWD: </span>{event.cwd}
                      </div>
                    )}
                    {event.toolInput && typeof event.toolInput === 'object' && (
                      <div className="text-gray-500 break-all">
                        <span>Input: </span>
                        {event.toolInput.command || event.toolInput.file_path || event.toolInput.pattern || JSON.stringify(event.toolInput).slice(0, 200)}
                      </div>
                    )}
                    {/* D3 — prompt linkage */}
                    {event.promptSnippet && (
                      <div data-testid="failure-prompt-link" className="text-gray-500 break-all">
                        <span className="text-gray-600">Triggered during prompt: </span>
                        <span className="text-blue/80">{event.promptSnippet.slice(0, 150)}{event.promptSnippet.length > 150 ? '…' : ''}</span>
                      </div>
                    )}
                    {/* D2 — retry linkage */}
                    {event.retryOf && (
                      <div className="text-gray-500">
                        <span className="text-gray-600">Retry of: </span>
                        <span className="text-red/80 font-mono">{event.retryOf}</span>
                      </div>
                    )}
                    {event.errorClass && (
                      <div className="text-gray-500">
                        <span className="text-gray-600">Class: </span>
                        <span className={ERROR_CLASS_COLORS[event.errorClass] || 'text-gray-400'}>{event.errorClass}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
