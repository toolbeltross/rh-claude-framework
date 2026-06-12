import { useState } from 'react';
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
      return <LiveSurface />;
    case 'sessions':
      return <SessionsSurface />;
    case 'subagents':
      return <SubagentsSurface />;
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
