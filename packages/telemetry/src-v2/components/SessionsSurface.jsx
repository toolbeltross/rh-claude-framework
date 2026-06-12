import { useMemo, useState } from 'react';
import { useSessions } from '../hooks/useSessions.js';
import { useCcdTitles } from '../hooks/useCcdTitles.js';
import SessionDetail from './SessionDetail.jsx';
import { formatN, formatUsd, relativeTime } from '../lib/format.js';
import { getModelColor, getModelFamily } from '../../src/lib/model-colors';

const PAGE_SIZE = 50;

const SORTS = [
  { id: 'recent',   label: 'Recent',   cmp: (a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')) },
  { id: 'cost',     label: 'Cost',     cmp: (a, b) => b.totalCost - a.totalCost },
  { id: 'messages', label: 'Messages', cmp: (a, b) => b.messageCount - a.messageCount },
  { id: 'duration', label: 'Duration', cmp: (a, b) => b.durationMs - a.durationMs },
];

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** Human-ish project label from the transcript dir name or cwd */
function projectLabel(s) {
  if (s.projectPath) return s.projectPath.split(/[\\/]/).filter(Boolean).pop() || s.projectPath;
  return s.projectDir || '—';
}

/**
 * Surface 2 — Sessions (plan 3.2, v2-ia.md).
 * Browse/filter/search every on-disk session from the live aggregator.
 */
export default function SessionsSurface() {
  const { data, loading, error } = useSessions();
  const ccdTitles = useCcdTitles();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [model, setModel] = useState('all');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(0);
  const [openSession, setOpenSession] = useState(null); // sessionId → drill-through view

  const sessions = data?.sessions || [];

  const projects = useMemo(
    () => [...new Set(sessions.map(projectLabel))].sort(),
    [sessions]
  );
  const modelFamilies = useMemo(
    () => [...new Set(sessions.map((s) => getModelFamily(s.primaryModel)).filter(Boolean))].sort(),
    [sessions]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = sessions.filter((s) => {
      if (project !== 'all' && projectLabel(s) !== project) return false;
      if (model !== 'all' && getModelFamily(s.primaryModel) !== model) return false;
      if (q && !s.sessionId.toLowerCase().includes(q) && !projectLabel(s).toLowerCase().includes(q)
        && !(s.projectPath || '').toLowerCase().includes(q)) return false;
      return true;
    });
    out.sort(SORTS.find((x) => x.id === sort)?.cmp || SORTS[0].cmp);
    return out;
  }, [sessions, query, project, model, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  if (openSession) {
    return (
      <SessionDetail
        sessionId={openSession}
        ccdMeta={ccdTitles[openSession] || null}
        onBack={() => setOpenSession(null)}
      />
    );
  }

  if (loading && !data) return <div className="p-12 text-center text-sm text-gray-400">Loading sessions…</div>;
  if (error) return <div className="p-12 text-center text-sm text-red-400">{error}</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Sessions</h1>
          <p className="text-xs text-gray-500 mt-1">
            {data.total} sessions on disk (live aggregator over <code className="text-gray-400">~/.claude/projects/</code>).
            Lifetime counts beyond pruned transcripts live on the History surface.
          </p>
        </div>
        <span className="text-[10px] text-gray-600 font-mono" title="Aggregator last recompute">
          computed {relativeTime(data.lastComputedAt)}
        </span>
      </div>

      {/* Filter strip */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search session id / project…"
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 w-64 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-700"
          title="Substring match on session id, project name, or project path"
        />
        <select
          value={project}
          onChange={(e) => { setProject(e.target.value); setPage(0); }}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
          title="Filter by project"
        >
          <option value="all">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={model}
          onChange={(e) => { setModel(e.target.value); setPage(0); }}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
          title="Filter by primary model family"
        >
          <option value="all">All models</option>
          {modelFamilies.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="flex items-center gap-1 ml-auto">
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => { setSort(s.id); setPage(0); }}
              className={`px-2 py-1 rounded ${
                sort === s.id ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900'
              }`}
              title={`Sort by ${s.label.toLowerCase()}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {pageRows.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-xs text-gray-500">
            No sessions match the current filters
          </div>
        ) : (
          <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 w-[24%]" title="Project (from transcript cwd)">Project</th>
                <th className="px-3 py-2 w-[12%]" title="Session id (first 8 chars; hover a row for the full id)">Session</th>
                <th className="px-3 py-2 w-[12%]" title="Primary model (most tokens in this session)">Model</th>
                <th className="px-3 py-2 w-[9%] text-right" title="user + assistant messages">Msgs</th>
                <th className="px-3 py-2 w-[9%] text-right" title="tool_use blocks">Tools</th>
                <th className="px-3 py-2 w-[10%] text-right" title="Estimated from per-model token usage">Cost</th>
                <th className="px-3 py-2 w-[12%] text-right" title="First to last transcript timestamp">Duration</th>
                <th className="px-3 py-2 w-[12%] text-right" title="Last transcript activity">Last active</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => {
                const color = getModelColor(s.primaryModel);
                const ccdTitle = ccdTitles[s.sessionId]?.title;
                return (
                  <tr
                    key={s.sessionId}
                    className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer"
                    onClick={() => setOpenSession(s.sessionId)}
                    title={`${ccdTitle ? `“${ccdTitle}”\n` : ''}${s.sessionId}\n${s.projectPath || s.projectDir || ''}\nClick for full detail`}
                  >
                    <td className="px-3 py-1.5 whitespace-nowrap overflow-hidden text-gray-300">{projectLabel(s)}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-400">{s.sessionId.slice(0, 8)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap overflow-hidden">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: color.hex }} />
                        <span className="text-gray-300">{getModelFamily(s.primaryModel) || '—'}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-100">{formatN(s.messageCount)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-300">{formatN(s.toolCallCount)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-100">{formatUsd(s.totalCost)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-300">{fmtDuration(s.durationMs)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-400">{relativeTime(s.lastTs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          showing {filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          {filtered.length !== sessions.length && ` (filtered from ${sessions.length})`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(Math.max(0, safePage - 1))}
            disabled={safePage === 0}
            className="px-2 py-1 rounded bg-gray-900 disabled:opacity-40 hover:bg-gray-800"
            title="Previous page"
          >
            ‹
          </button>
          <span className="px-2 font-mono">{safePage + 1}/{pageCount}</span>
          <button
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            disabled={safePage >= pageCount - 1}
            className="px-2 py-1 rounded bg-gray-900 disabled:opacity-40 hover:bg-gray-800"
            title="Next page"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
