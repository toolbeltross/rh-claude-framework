import { useState, useEffect } from 'react';
import InfoIcon from './InfoIcon';

export default function SubagentTracker({ liveSession }) {
  if (!liveSession) return null;

  const active = liveSession._activeSubagents || {};
  const history = liveSession._subagentHistory || [];
  const activeEntries = Object.entries(active);
  const totalCompleted = history.length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <div className="flex items-center gap-3 mb-2">
        <span
          className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5"
          title="Subagents spawned via the Task tool. They use cheaper models (Haiku, Sonnet) automatically — this is why multiple models appear in the Model Breakdown."
        >
          Agents{' '}
          <InfoIcon text="Subagents spawned via the Task tool. They run in parallel using cheaper models (Haiku, Sonnet) automatically. Explore=search codebase, Plan=architecture, Bash=commands, general-purpose=research." />
        </span>
        <span className="text-sm font-mono text-cyan">{activeEntries.length} active</span>
        {totalCompleted > 0 && (
          <span className="text-xs text-gray-500">{totalCompleted} completed</span>
        )}
      </div>

      {/* Active agents */}
      {activeEntries.length > 0 ? (
        <div className="flex flex-col gap-1 mb-2">
          {activeEntries.map(([id, agent]) => (
            <ActiveAgent key={id} agentId={id} agent={agent} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-600 mb-2">No active agents</p>
      )}

      {/* Completed agents */}
      {totalCompleted > 0 && (
        <div className="border-t border-gray-800 pt-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Completed</span>
          <div className="flex flex-col gap-1 mt-1">
            {history.slice().reverse().map((agent, i) => (
              <CompletedAgent key={agent.agentId || i} agent={agent} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveAgent({ agentId, agent }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - agent.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [agent.startedAt]);

  const modelLabel = agent.model ? ` (${friendlyModel(agent.model)})` : '';

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse shrink-0" title="Agent is actively running" />
      <span className="font-semibold text-gray-200" title={`Agent type: ${agent.type}`}>{agent.type}</span>
      {modelLabel && <span className="text-gray-500" title="Model used by this agent">{modelLabel}</span>}
      <span className="text-gray-500">running {elapsed}s</span>
      {agent.description && (
        <span className="text-gray-500 truncate" title={agent.description}>— {agent.description}</span>
      )}
    </div>
  );
}

function CompletedAgent({ agent }) {
  const [expanded, setExpanded] = useState(false);
  const duration = agent.durationMs ? `${Math.round(agent.durationMs / 1000)}s` : '?';
  const modelLabel = agent.model ? ` (${friendlyModel(agent.model)})` : '';
  const hasMessage = !!agent.lastMessage;

  return (
    <div className="text-xs">
      <div
        className={`flex items-center gap-2 ${hasMessage ? 'cursor-pointer' : ''}`}
        onClick={() => hasMessage && setExpanded(!expanded)}
        title={hasMessage ? 'Click to expand/collapse result' : ''}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" title="Agent completed" />
        <span className="text-gray-400">{agent.type}</span>
        {modelLabel && <span className="text-gray-600">{modelLabel}</span>}
        <span className="text-gray-600">{duration}</span>
        {agent.description && (
          <span className="text-gray-600 truncate" title={agent.description}>— {agent.description}</span>
        )}
        {hasMessage && (
          <span className="text-gray-600 ml-auto">{expanded ? '\u25B2' : '\u25BC'}</span>
        )}
      </div>
      {expanded && agent.lastMessage && (
        <div className="mt-1 ml-4 p-2 bg-gray-950 rounded text-gray-400 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
          {agent.lastMessage}
        </div>
      )}
    </div>
  );
}

function friendlyModel(model) {
  if (!model) return '';
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model;
}