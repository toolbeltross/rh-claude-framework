import { useMemo, useState, useEffect } from 'react';
import InfoIcon, { Legend } from './InfoIcon';
import { getAgentTypeColor, IDENTITY } from '../lib/style-tokens';

// Resolution lives in `style-tokens.js`; this Proxy lets existing
// `TYPE_HEX[agentType]` call sites work without rewriting downstream code.
const TYPE_HEX = new Proxy({}, {
  get: (_target, key) => getAgentTypeColor(key).hex,
});

const DEFAULT_AGENT_COLOR = IDENTITY.meta.hex;
const COMPACT_COLOR = '#fbbf24';
const PROMPT_COLOR = '#60a5fa';
const STOP_COLOR = '#6b7280';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

/**
 * Gantt-lite visualization of subagent activity in a session.
 *
 * Lanes: one row per agent (active + historical), sorted by startedAt.
 * X-axis: session time, from the earliest recorded event to now.
 * Bars: agent lifetime from startedAt → endedAt (or now, for active agents).
 * Overlays: compaction (amber vertical), user prompts (blue), Stop events (gray ticks).
 *
 * Defaults to collapsed — many sessions have 0 or 1 subagent so this is
 * purely for sessions with substantial parallel work.
 */
export default function SubagentTimeline({ liveSession, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [now, setNow] = useState(Date.now());

  // Re-tick every second while expanded so active bars grow in real time.
  useEffect(() => {
    if (!expanded) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expanded]);

  const activeMap = liveSession?._activeSubagents || {};
  const history = liveSession?._subagentHistory || [];

  const allAgents = useMemo(() => {
    const out = [];
    for (const [agentId, a] of Object.entries(activeMap)) {
      out.push({
        agentId,
        type: a.type || 'unknown',
        startedAt: a.startedAt,
        endedAt: null, // active
        status: 'active',
        toolCount: a._toolCount || 0,
        failureCount: a._failureCount || 0,
        validationBlockCount: a._validationBlockCount || 0,
      });
    }
    for (const h of history) {
      out.push({
        agentId: h.agentId,
        type: h.type || 'unknown',
        startedAt: h.startedAt,
        endedAt: h.endedAt,
        status: h.status || 'completed',
        toolCount: h.toolCount || 0,
        failureCount: h.failureCount || 0,
        validationBlockCount: h.validationBlockCount || 0,
        transcriptStatus: h.transcriptStatus,
      });
    }
    // Sort by startedAt ascending; null startedAt go to the top
    out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    return out;
  }, [activeMap, history]);

  const compactEvents = liveSession?._compactEvents || [];
  const promptHistory = liveSession?._promptHistory || [];
  const turnHistory = liveSession?._turnHistory || [];
  const stopEvents = turnHistory.filter((t) => !t.compact && t.ts);

  // Compute time domain
  const { tMin, tMax } = useMemo(() => {
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const a of allAgents) {
      if (a.startedAt) tMin = Math.min(tMin, a.startedAt);
      if (a.endedAt) tMax = Math.max(tMax, a.endedAt);
    }
    for (const c of compactEvents) {
      if (c.ts) { tMin = Math.min(tMin, c.ts); tMax = Math.max(tMax, c.ts); }
    }
    for (const p of promptHistory) {
      if (p.ts) { tMin = Math.min(tMin, p.ts); tMax = Math.max(tMax, p.ts); }
    }
    const activeCount = Object.keys(activeMap).length;
    if (activeCount > 0) tMax = Math.max(tMax, now);
    if (!isFinite(tMin) || !isFinite(tMax) || tMax <= tMin) return { tMin: 0, tMax: 0 };
    // Add a 3% right pad so the "now" edge is visible
    const pad = (tMax - tMin) * 0.03;
    return { tMin, tMax: tMax + pad };
  }, [allAgents, compactEvents, promptHistory, activeMap, now]);

  // Don't render for trivial sessions (<2 agents and no overlays)
  const trivial =
    allAgents.length < 2 && compactEvents.length === 0 && stopEvents.length < 2;

  if (allAgents.length === 0 || tMax === tMin) {
    return null;
  }

  const span = tMax - tMin;
  const xPct = (ts) => span > 0 ? ((ts - tMin) / span) * 100 : 0;
  const laneHeight = 18;
  const lanePad = 4;
  const headerHeight = 14;
  const footerHeight = 14;
  const innerHeight = allAgents.length * (laneHeight + lanePad);
  const svgHeight = headerHeight + innerHeight + footerHeight;

  return (
    <div
      data-testid="subagent-timeline"
      className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5"
    >
      <button
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 w-full"
        onClick={() => setExpanded(!expanded)}
        title="Show timeline of subagent activity, compactions, and prompts"
      >
        <span className="text-gray-600">{expanded ? '\u25B2' : '\u25BC'}</span>
        <span className="font-semibold uppercase tracking-wider">Timeline</span>
        <span className="text-[10px] text-gray-600">
          {allAgents.length} agent{allAgents.length > 1 ? 's' : ''}
          {compactEvents.length > 0 && ` · ${compactEvents.length} compact`}
          {stopEvents.length > 0 && ` · ${stopEvents.length} stop`}
        </span>
        <InfoIcon>
          <div className="space-y-1.5">
            <p>Horizontal bars = subagent lifetime. Vertical markers overlay session-level events.</p>
            <div className="flex flex-wrap gap-x-1 gap-y-0.5">
              <Legend color="bg-amber" label="compaction" />
              <Legend color="bg-blue" label="user prompt" />
              <Legend color="bg-gray-600" label="Stop / turn end" />
            </div>
            <p className="text-[10px] text-gray-500">Hidden by default — click to expand. Useful on sessions with overlapping agents or where you suspect a compaction orphaned a subagent.</p>
          </div>
        </InfoIcon>
        {trivial && !expanded && (
          <span className="text-[10px] text-gray-600 ml-auto" title="Timeline has little to show for this session — still available if you want it">
            (sparse)
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5">
          <svg
            width="100%"
            height={svgHeight}
            viewBox={`0 0 1000 ${svgHeight}`}
            preserveAspectRatio="none"
            className="block"
          >
            {/* Header: start + end time */}
            <text x="0" y={headerHeight - 3} fontSize="10" fill="#6b7280" fontFamily="monospace">
              {formatTime(tMin)}
            </text>
            <text x="1000" y={headerHeight - 3} fontSize="10" fill="#6b7280" textAnchor="end" fontFamily="monospace">
              {formatTime(tMax)}
            </text>

            {/* Agent lanes */}
            {allAgents.map((a, i) => {
              const laneY = headerHeight + i * (laneHeight + lanePad);
              const startX = a.startedAt ? xPct(a.startedAt) * 10 : 0;
              const endT = a.endedAt || now;
              const endX = xPct(endT) * 10;
              const barWidth = Math.max(2, endX - startX);
              const color = TYPE_HEX[a.type] || DEFAULT_AGENT_COLOR;
              const isActive = a.status === 'active';
              const isOrphaned = a.status === 'orphaned';
              const opacity = isOrphaned ? 0.5 : 1;
              const stroke = isOrphaned ? '#f87171' : 'none';
              const title = [
                `${a.type} ${(a.agentId || '').slice(-8)}`,
                a.startedAt ? `start ${formatTime(a.startedAt)}` : '',
                a.endedAt ? `end ${formatTime(a.endedAt)}` : isActive ? 'still active' : '',
                `${a.toolCount || 0} tools`,
                a.failureCount > 0 ? `${a.failureCount} fails` : '',
                a.validationBlockCount > 0 ? `${a.validationBlockCount} blocked` : '',
                isOrphaned ? 'orphaned' : '',
                a.transcriptStatus && a.transcriptStatus !== 'ok' ? `transcript ${a.transcriptStatus}` : '',
              ].filter(Boolean).join(' · ');
              return (
                <g key={a.agentId || i}>
                  <rect
                    x={startX}
                    y={laneY}
                    width={barWidth}
                    height={laneHeight}
                    rx={3}
                    fill={color}
                    opacity={opacity}
                    stroke={stroke}
                    strokeWidth={isOrphaned ? 1.5 : 0}
                    strokeDasharray={isOrphaned ? '3,2' : undefined}
                    data-testid={`timeline-lane-${a.status}`}
                  >
                    <title>{title}</title>
                  </rect>
                  {/* Active pulse indicator at right edge */}
                  {isActive && (
                    <circle cx={endX} cy={laneY + laneHeight / 2} r={2.5} fill={color}>
                      <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {/* Type label inside bar if wide enough */}
                  {barWidth > 40 && (
                    <text
                      x={startX + 4}
                      y={laneY + laneHeight / 2 + 3}
                      fontSize="9"
                      fill="#0a0a0a"
                      fontFamily="monospace"
                      style={{ pointerEvents: 'none' }}
                    >
                      {a.type}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Compaction vertical lines (amber) */}
            {compactEvents.map((c, i) => (
              <line
                key={`cmp-${i}`}
                x1={xPct(c.ts) * 10}
                x2={xPct(c.ts) * 10}
                y1={headerHeight}
                y2={headerHeight + innerHeight}
                stroke={COMPACT_COLOR}
                strokeWidth="1.5"
                opacity="0.7"
                data-testid="timeline-compact-line"
              >
                <title>compaction · {formatTime(c.ts)} · trigger: {c.trigger || 'auto'}</title>
              </line>
            ))}

            {/* User prompt vertical lines (blue, thinner) */}
            {promptHistory.map((p, i) => (
              <line
                key={`prm-${i}`}
                x1={xPct(p.ts) * 10}
                x2={xPct(p.ts) * 10}
                y1={headerHeight}
                y2={headerHeight + innerHeight}
                stroke={PROMPT_COLOR}
                strokeWidth="1"
                opacity="0.5"
                data-testid="timeline-prompt-line"
              >
                <title>user prompt · {formatTime(p.ts)} · {(p.text || '').slice(0, 80)}</title>
              </line>
            ))}

            {/* Stop events as small gray ticks at the bottom */}
            {stopEvents.map((t, i) => (
              <line
                key={`stp-${i}`}
                x1={xPct(t.ts) * 10}
                x2={xPct(t.ts) * 10}
                y1={headerHeight + innerHeight}
                y2={headerHeight + innerHeight + 5}
                stroke={STOP_COLOR}
                strokeWidth="1"
                data-testid="timeline-stop-tick"
              >
                <title>turn {t.turn} end · {formatTime(t.ts)}</title>
              </line>
            ))}

            {/* Footer duration label */}
            <text
              x="500"
              y={svgHeight - 2}
              fontSize="10"
              fill="#4b5563"
              textAnchor="middle"
              fontFamily="monospace"
            >
              span {formatDuration(tMax - tMin)}
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
