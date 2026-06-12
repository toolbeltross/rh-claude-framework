import ContextWindow from '../../src/components/ContextWindow.jsx';
import ModelBreakdownMini from '../../src/components/ModelBreakdownMini.jsx';
import TurnHeartbeat from '../../src/components/TurnHeartbeat.jsx';
import CurrentPrompt from '../../src/components/CurrentPrompt.jsx';
import AgentActivity from '../../src/components/AgentActivity.jsx';
import ToolActivity from '../../src/components/ToolActivity.jsx';
import { formatUsd, relativeTime } from '../lib/format.js';
import { useCcdTitles } from '../hooks/useCcdTitles.js';

/**
 * Surface 1 — Live (plan 3.1, v2-ia.md).
 *
 * One pane of glass for the currently-active Claude Code session. All panels
 * are v1 components lifted verbatim via cross-tree import (the Phase 1
 * pattern); this file only contributes the session picker + layout.
 */
export default function LiveSurface({ live }) {
  const {
    liveSessions,
    sessionIds,
    selectedSessionId,
    selectSession,
    sessionActivity,
    toolEvents,
    connected,
  } = live;
  const ccdTitles = useCcdTitles();

  const liveSession = selectedSessionId ? liveSessions[selectedSessionId] : null;

  if (sessionIds.length === 0) {
    return (
      <div className="p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Live</span>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-xs text-gray-500 mb-2">No active Claude Code session</div>
          <div className="text-xs text-gray-600 max-w-md">
            Run <code className="text-gray-400">claude</code> in a terminal — with telemetry hooks
            configured it will appear here within a few seconds. Hooks missing? Run{' '}
            <code className="text-gray-400">rh-telemetry setup</code>.
          </div>
          {!connected && (
            <div className="mt-4 text-[10px] text-amber" title="WebSocket disconnected — reconnecting with backoff">
              WS disconnected — reconnecting…
            </div>
          )}
        </div>
      </div>
    );
  }

  const sessionToolEvents = toolEvents.filter((e) => e.session === selectedSessionId);

  return (
    <div className="p-6 space-y-4">
      {/* Session picker + meta strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 mr-2">Live</span>
        {sessionIds.map((id) => {
          const s = liveSessions[id];
          const activity = sessionActivity[id] || 'idle';
          const selected = id === selectedSessionId;
          let label = s?.workspace?.project_dir?.split(/[\\/]/).pop()
            || s?.workspace?.current_dir?.split(/[\\/]/).pop()
            || id.slice(0, 8);
          // Two sessions in the same workspace would render identical pills —
          // disambiguate with the short session id.
          const collision = sessionIds.some((other) => {
            if (other === id) return false;
            const o = liveSessions[other];
            const otherLabel = o?.workspace?.project_dir?.split(/[\\/]/).pop()
              || o?.workspace?.current_dir?.split(/[\\/]/).pop()
              || other.slice(0, 8);
            return otherLabel === label;
          });
          if (collision) label = `${label} · ${id.slice(0, 8)}`;
          // Hover shows the same English title Claude Code Desktop displays
          const ccdTitle = ccdTitles[id]?.title;
          return (
            <button
              key={id}
              onClick={() => selectSession(id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                selected ? 'bg-gray-800 text-gray-100' : 'bg-gray-900 text-gray-400 hover:text-gray-200'
              }`}
              title={`${ccdTitle ? `“${ccdTitle}”\n` : ''}${id} — ${activity}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  activity === 'processing' ? 'bg-green animate-pulse-dot' : 'bg-blue'
                }`}
              />
              {label}
            </button>
          );
        })}
        {liveSession && (
          <span className="ml-auto text-[10px] text-gray-500 font-mono" title="model · session cost · last event">
            {liveSession.model?.display_name || liveSession.model?.id || '—'}
            {' · '}{liveSession.cost?.total_cost_usd != null ? formatUsd(liveSession.cost.total_cost_usd) : '—'}
            {' · '}{relativeTime(liveSession._lastSeen)}
          </span>
        )}
      </div>

      {liveSession && (
        <>
          {/* Row 1: context runway + model breakdown (v1 SessionTab row 1) */}
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-9">
              <ContextWindow session={null} liveSession={liveSession} />
            </div>
            <div className="col-span-3">
              <ModelBreakdownMini session={null} liveSession={liveSession} />
            </div>
          </div>

          {/* Current prompt */}
          <CurrentPrompt liveSession={liveSession} />

          {/* Live tool heartbeat for the current turn */}
          <TurnHeartbeat
            liveSession={liveSession}
            toolEvents={sessionToolEvents}
            sessionId={selectedSessionId}
          />

          {/* Subagents — active + completed (v1 Agents tab, lifted whole) */}
          <AgentActivity liveSession={liveSession} />

          {/* Recent tool stream */}
          <ToolActivity events={sessionToolEvents} expanded={false} />
        </>
      )}
    </div>
  );
}
