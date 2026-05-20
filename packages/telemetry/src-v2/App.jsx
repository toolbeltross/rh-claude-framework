import { useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import HistorySurface from './components/HistorySurface.jsx';
import PlaceholderSurface from './components/PlaceholderSurface.jsx';
import { useAggregates } from './hooks/useAggregates.js';

export default function App() {
  const [active, setActive] = useState('history'); // default surface for Phase 3 MVP
  const { aggregates, loading, error, lastUpdated, refresh } = useAggregates();

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      <Sidebar active={active} onSelect={setActive} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header lastUpdated={lastUpdated} onRefresh={refresh} />
        <main className="flex-1 overflow-auto">
          <Surface active={active} aggregates={aggregates} loading={loading} error={error} />
        </main>
      </div>
    </div>
  );
}

function Surface({ active, aggregates, loading, error }) {
  switch (active) {
    case 'history':
      return <HistorySurface aggregates={aggregates} loading={loading} error={error} />;
    case 'live':
      return <PlaceholderSurface
        title="Live"
        phaseRef="Phase 3.1"
        hint="Will lift v1's ContextWindow, ModelBreakdownMini, TurnHeartbeat, CurrentPrompt, SubagentTracker. Source: WS liveSessions[activeSession]."
      />;
    case 'sessions':
      return <PlaceholderSurface
        title="Sessions"
        phaseRef="Phase 3.2"
        hint={`Will browse all ${aggregates?.totalSessions ?? '—'} on-disk sessions with filter/search/pagination. Source: GET /api/aggregates (per-session detail to be added).`}
      />;
    case 'subagents':
      return <PlaceholderSurface
        title="Subagents"
        phaseRef="Phase 3.3"
        hint="Cross-session leaderboard of subagent activity. Source: walking <sessionId>/subagents/agent-*.jsonl files (595 found in current ~/.claude/projects/)."
      />;
    case 'oversight':
      return <PlaceholderSurface
        title="Oversight"
        phaseRef="Phase 3.5"
        hint="New top-level surface for oversight-events.jsonl (Layer 3a rejections, guards, scribe outputs, hook perf). 6 event types catalogued in Phase 0.6."
      />;
    case 'failures':
      return <PlaceholderSurface
        title="Failures"
        phaseRef="Phase 3.4"
        hint="Promoted from v1 subtab. Source: existing GET /api/failures + /api/failures/patterns + /api/failures/top-cost (D4 — currently API-only)."
      />;
    case 'trends':
      return <PlaceholderSurface
        title="Trends"
        phaseRef="Phase 3.6"
        hint="Lift v1 TrendsTab.jsx verbatim. Source: existing GET /api/trends?days=N."
      />;
    default:
      return <PlaceholderSurface title={active} phaseRef="unknown" />;
  }
}
