import { useState } from 'react';
import ContextWindow from './ContextWindow';
import ToolActivity from './ToolActivity';
import FailureHistory from './FailureHistory';
import ModelBreakdownMini from './ModelBreakdownMini';
import AgentActivity from './AgentActivity';
import PerformanceMetrics from './PerformanceMetrics';
import TurnTracker from './TurnTracker';
import TurnCostChart from './TurnCostChart';
import TurnHeartbeat from './TurnHeartbeat';
import TurnsTab from './TurnsTab';
import CurrentPrompt from './CurrentPrompt';
import TaskCompletions from './TaskCompletions';

const TABS = ['Agents', 'Tools', 'Turns', 'Failures', 'Details'];

function SubTabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${
        active
          ? 'bg-gray-900 text-gray-100 border border-gray-800 border-b-gray-900'
          : 'bg-gray-950 text-gray-400 border border-transparent hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

export default function SessionTab({ sessionId, liveSession, session, toolEvents, failureEvents, failurePatterns, failureAlerts, planInfo }) {
  const filtered = toolEvents.filter((e) => e.session === sessionId);
  const displayMode = planInfo?.displayMode || 'cost';

  // Auto-select Agents tab when there are active agents, otherwise Tools
  const activeAgentCount = Object.keys(liveSession?._activeSubagents || {}).length;
  const completedAgentCount = (liveSession?._subagentHistory || []).length;
  const hasAgentActivity = activeAgentCount > 0 || completedAgentCount > 0;
  const [activeSubTab, setActiveSubTab] = useState(hasAgentActivity ? 'Agents' : 'Tools');

  const failureCount = failureEvents?.filter(e => e.sessionId === sessionId).length || 0;

  const consecutiveForced = liveSession?._consecutiveForcedContinuations || 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Forced-continuation banner — red when a Stop-hook loop is suspected */}
      {consecutiveForced >= 2 && (
        <div
          data-testid="forced-continuation-banner"
          className="bg-red/10 border border-red/40 text-red rounded-lg px-3 py-2 text-xs"
          title="Claude has been forced to continue multiple times with no new user prompt. A Stop hook may be stuck in a rejection loop. Review hook logic or interrupt the session."
        >
          <span className="font-semibold uppercase tracking-wider">Possible Stop-hook loop:</span>{' '}
          <span className="font-mono">{consecutiveForced}</span> consecutive turns reopened without a new user prompt. A Stop hook may be rejecting repeatedly; consider interrupting or directing Claude manually.
        </div>
      )}
      {/* Row 1: Context Window + Mini Model Breakdown — always visible */}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-9">
          <ContextWindow session={session} liveSession={liveSession} />
        </div>
        <div className="col-span-3">
          <ModelBreakdownMini session={session} liveSession={liveSession} displayMode={displayMode} />
        </div>
      </div>

      {/* Row 1b: Live Turn Heartbeat — shows current turn's tool activity */}
      <TurnHeartbeat liveSession={liveSession} toolEvents={toolEvents} sessionId={sessionId} />

      {/* Row 2: Tabbed subpanel */}
      <div className="flex flex-col">
        {/* Tab bar */}
        <div className="flex items-end gap-1">
          {TABS.map((tab) => (
            <SubTabButton
              key={tab}
              active={activeSubTab === tab}
              onClick={() => setActiveSubTab(tab)}
            >
              <span className="inline-flex items-center gap-1.5">
                {tab}
                {tab === 'Agents' && activeAgentCount > 0 && (
                  <span className="px-1.5 py-0 text-[10px] rounded-full bg-cyan/20 text-cyan font-mono" title={`${activeAgentCount} active agent${activeAgentCount > 1 ? 's' : ''}`}>
                    {activeAgentCount}
                  </span>
                )}
                {tab === 'Tools' && filtered.length > 0 && (
                  <span className="px-1.5 py-0 text-[10px] rounded-full bg-gray-800 text-gray-400 font-mono" title={`${filtered.length} tool events`}>
                    {filtered.length}
                  </span>
                )}
                {tab === 'Turns' && (liveSession?._turnCount || 0) > 0 && (
                  <span className="px-1.5 py-0 text-[10px] rounded-full bg-accent/20 text-accent font-mono" title={`${liveSession._turnCount} turns`}>
                    {liveSession._turnCount}
                  </span>
                )}
                {tab === 'Failures' && failureCount > 0 && (
                  <span className="px-1.5 py-0 text-[10px] rounded-full bg-red/20 text-red font-mono" title={`${failureCount} failures`}>
                    {failureCount}
                  </span>
                )}
              </span>
            </SubTabButton>
          ))}
        </div>

        {/* Tab content */}
        <div className="bg-gray-900 border border-gray-800 border-t-0 rounded-b-lg">
          {activeSubTab === 'Agents' && (
            <AgentActivity liveSession={liveSession} />
          )}
          {activeSubTab === 'Tools' && (
            <ToolActivity events={filtered} expanded />
          )}
          {activeSubTab === 'Turns' && (
            <TurnsTab liveSession={liveSession} />
          )}
          {activeSubTab === 'Failures' && (
            <FailureHistory failureEvents={failureEvents} failurePatterns={failurePatterns} failureAlerts={failureAlerts} sessionId={sessionId} toolEvents={filtered} expanded />
          )}
          {activeSubTab === 'Details' && (
            <div className="flex flex-col gap-2 p-2">
              {/* Turn tracker + Turn Cost Chart */}
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-7">
                  <TurnTracker liveSession={liveSession} displayMode={displayMode} />
                </div>
                <div className="col-span-5">
                  <TurnCostChart liveSession={liveSession} displayMode={displayMode} />
                </div>
              </div>
              <PerformanceMetrics session={session} />
              <CurrentPrompt liveSession={liveSession} />
              <TaskCompletions liveSession={liveSession} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
