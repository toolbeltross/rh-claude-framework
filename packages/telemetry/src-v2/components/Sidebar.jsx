const SURFACES = [
  { id: 'live',      label: 'Live',      hint: 'Active session' },
  { id: 'sessions',  label: 'Sessions',  hint: 'Browse history' },
  { id: 'subagents', label: 'Subagents', hint: 'Cross-session agents' },
  { id: 'oversight', label: 'Oversight', hint: 'Layer 3a + guards + scribe' },
  { id: 'failures',  label: 'Failures',  hint: 'Tool failures over time' },
  { id: 'trends',    label: 'Trends',    hint: 'Windowed aggregations' },
  { id: 'history',   label: 'History',   hint: 'Lifetime totals' },
];

export default function Sidebar({ active, onSelect }) {
  return (
    <aside className="w-48 border-r border-gray-800 bg-gray-950 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="text-[10px] uppercase tracking-wider text-gray-500">rh-telemetry</div>
        <div className="text-sm font-semibold text-gray-200">v2</div>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
              active === s.id
                ? 'bg-gray-800 text-gray-100'
                : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
            }`}
            title={s.hint}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-gray-800 text-[10px] text-gray-600">
        Phase 3 in progress — most surfaces are placeholders
      </div>
    </aside>
  );
}

export { SURFACES };
