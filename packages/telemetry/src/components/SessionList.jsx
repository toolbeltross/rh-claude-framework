export default function SessionList({ sessions, onSelect }) {
  if (!sessions?.length) {
    return (
      <div className="absolute top-full right-0 mt-1 bg-gray-900 border border-gray-800 rounded-lg shadow-xl z-50 min-w-[300px] p-3">
        <p className="text-xs text-gray-500">No sessions found</p>
      </div>
    );
  }

  return (
    <div className="absolute top-full right-0 mt-1 bg-gray-900 border border-gray-800 rounded-lg shadow-xl z-50 min-w-[300px] max-w-lg max-h-64 overflow-y-auto py-1">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          onClick={() => onSelect(s)}
          className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-gray-800/60 flex items-center gap-3 flex-wrap"
        >
          <span className="font-semibold text-gray-200 shrink-0 truncate max-w-[140px]">
            {s.projectName || s.sessionId?.slice(0, 8)}
          </span>
          <span className="font-mono text-green shrink-0">
            ${s.cost?.toFixed(2) ?? '0.00'}
          </span>
          {s.primaryModel && (
            <span className="text-accent shrink">
              {s.primaryModel}
            </span>
          )}
          {s.duration && (
            <span className="text-gray-400">
              {s.duration}
            </span>
          )}
          {(s.linesAdded > 0 || s.linesRemoved > 0) && (
            <span className="text-amber">
              +{s.linesAdded || 0}/-{s.linesRemoved || 0}
            </span>
          )}
          <span className="font-mono text-gray-600 text-[10px]">
            {s.sessionId?.slice(0, 8)}
          </span>
        </button>
      ))}
    </div>
  );
}