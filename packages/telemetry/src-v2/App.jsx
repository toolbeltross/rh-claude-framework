import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import HistorySurface from './components/HistorySurface.jsx';
import FailuresSurface from './components/FailuresSurface.jsx';
import OversightSurface from './components/OversightSurface.jsx';
import TrendsSurface from './components/TrendsSurface.jsx';
import LiveSurface from './components/LiveSurface.jsx';
import SessionsSurface from './components/SessionsSurface.jsx';
import SubagentsSurface from './components/SubagentsSurface.jsx';
import PlaceholderSurface from './components/PlaceholderSurface.jsx';
import { useAggregates } from './hooks/useAggregates.js';
import { useDashboardData } from '../src/hooks/useDashboardData';

export default function App() {
  const [active, setActive] = useState('history');
  // Cross-surface deep link: { id, ts } nonce → Sessions opens that detail view
  const [sessionDeepLink, setSessionDeepLink] = useState(null);
  const userNavigated = useRef(false);
  const { aggregates, loading, error, lastUpdated, refresh } = useAggregates();
  // Single live-data WS for the whole app — Header (plan gauges, LIVE chip,
  // statusline health) and LiveSurface share it.
  const live = useDashboardData();

  // Cold-load default per v2-ia.md: land on Live when a session is active.
  // Only until the user navigates — never fight an explicit choice.
  useEffect(() => {
    if (userNavigated.current) return;
    if (live.sessionIds.length > 0) setActive('live');
  }, [live.sessionIds]);

  const handleSelect = (id) => {
    userNavigated.current = true;
    setActive(id);
  };

  // Open a specific session's drill-through from any surface (Live meta strip,
  // AgentDetail parent link). The ts nonce re-triggers on repeat clicks.
  const openSessionDetail = (sessionId) => {
    userNavigated.current = true;
    setSessionDeepLink({ id: sessionId, ts: Date.now() });
    setActive('sessions');
  };

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      <Sidebar active={active} onSelect={handleSelect} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header
          lastUpdated={lastUpdated}
          onRefresh={refresh}
          planInfo={live.planInfo}
          statusLineState={live.statusLineState}
          liveSessions={live.liveSessions}
          sessionActivity={live.sessionActivity}
          onLiveClick={() => handleSelect('live')}
        />
        <main className="flex-1 overflow-auto">
          <Surface
            active={active}
            aggregates={aggregates}
            loading={loading}
            error={error}
            live={live}
            sessionDeepLink={sessionDeepLink}
            onOpenSessionDetail={openSessionDetail}
          />
        </main>
      </div>
    </div>
  );
}

function Surface({ active, aggregates, loading, error, live, sessionDeepLink, onOpenSessionDetail }) {
  switch (active) {
    case 'history':
      return <HistorySurface aggregates={aggregates} loading={loading} error={error} />;
    case 'live':
      return <LiveSurface live={live} onOpenDetail={onOpenSessionDetail} />;
    case 'sessions':
      return <SessionsSurface deepLink={sessionDeepLink} />;
    case 'subagents':
      return <SubagentsSurface onOpenSession={onOpenSessionDetail} />;
    case 'oversight':
      return <OversightSurface />;
    case 'failures':
      return <FailuresSurface />;
    case 'trends':
      return <TrendsSurface />;
    default:
      return <PlaceholderSurface title={active} phaseRef="unknown" />;
  }
}
