import { useEffect, useState } from 'react';
import { MODEL_COLORS } from '../../src/lib/model-colors.js';
import { relativeTime } from '../lib/format.js';

export default function Header({ lastUpdated, onRefresh }) {
  // Re-render every 5s so "3s ago" stays current
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const stale = lastUpdated && (Date.now() - lastUpdated) > 60_000;

  return (
    <header className="h-12 border-b border-gray-800 bg-gray-950 flex items-center px-4 gap-4 text-sm">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="uppercase tracking-wider">env</span>
        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-200 font-mono">v2</span>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {Object.entries(MODEL_COLORS).map(([name, c]) => (
          <span key={name} className="flex items-center gap-1.5" title={`${name} (${c.hex})`}>
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.hex }} />
            <span className="text-gray-400">{name}</span>
          </span>
        ))}
      </div>

      <div className="flex-1" />

      <div className={`text-xs ${stale ? 'text-amber-400' : 'text-gray-500'}`}>
        {lastUpdated ? `updated ${relativeTime(lastUpdated)}` : 'connecting…'}
      </div>

      <button
        onClick={onRefresh}
        className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
        title="Force refresh from /api/aggregates"
      >
        ↻ refresh
      </button>
    </header>
  );
}
