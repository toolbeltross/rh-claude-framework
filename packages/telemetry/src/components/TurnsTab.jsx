import { useState } from 'react';
import InfoIcon, { Legend } from './InfoIcon';
import { getToolColor as getToolToken, getToolCategory, IDENTITY } from '../lib/style-tokens';

function getToolColor(tool) {
  return getToolToken(tool).hex;
}

// Swim lanes mirror the IDENTITY palette categories. Lane order is fixed so
// related tools (e.g., Read + Edit) group visually.
const SWIM_LANES = [
  { id: 'fileio',        label: 'File I/O',  hex: IDENTITY.fileio.hex },
  { id: 'runtime',       label: 'Shell/Net', hex: IDENTITY.runtime.hex },
  { id: 'orchestration', label: 'Orches.',   hex: IDENTITY.orchestration.hex },
  { id: 'meta',          label: 'Meta',      hex: IDENTITY.meta.hex },
];

function getLaneIndex(tool) {
  const cat = getToolCategory(tool);
  const idx = SWIM_LANES.findIndex(l => l.id === cat);
  return idx === -1 ? SWIM_LANES.length - 1 : idx;
}

function formatDuration(ms) {
  if (ms == null || ms === 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(11, 19);
}

function formatCost(usd) {
  if (usd == null) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

export default function TurnsTab({ liveSession }) {
  const [expandedTurn, setExpandedTurn] = useState(null);
  const history = liveSession?._turnHistory || [];
  const turns = history.filter(t => !t.compact);

  const infoContent = (
    <div className="space-y-1.5">
      <p>Per-turn breakdown: wall-clock duration, tool execution time, model thinking time, and cost. Click a turn to see its full tool timeline.</p>
      <div className="flex flex-wrap gap-x-1 gap-y-0.5">
        <Legend color="bg-green" label="Tool time" />
        <Legend color="bg-accent" label="Model time" />
        <Legend color="bg-blue" label="Read" />
        <Legend color="bg-amber" label="Write/Edit" />
      </div>
    </div>
  );

  if (turns.length === 0) {
    return (
      <div className="p-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Turn History
          </span>
          <InfoIcon>{infoContent}</InfoIcon>
        </div>
        <div className="flex items-center justify-center py-6 text-xs text-gray-500">
          No turns recorded yet
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Turn History
        </span>
        <InfoIcon>{infoContent}</InfoIcon>
      </div>

      <div className="space-y-0.5">
        {/* Header */}
        <div className="grid grid-cols-12 gap-1 px-2 py-1 text-[10px] text-gray-500 uppercase tracking-wider">
          <div className="col-span-1">Turn</div>
          <div className="col-span-1">Time</div>
          <div className="col-span-2">Duration</div>
          <div className="col-span-2">Tool / Model</div>
          <div className="col-span-1">Tools</div>
          <div className="col-span-1">Cost</div>
          <div className="col-span-4">Timeline</div>
        </div>

        {/* Rows — newest first */}
        {[...turns].reverse().map((turn) => {
          const modelMs = Math.max(0, (turn.durationMs || 0) - (turn.toolTimeMs || 0));
          const isExpanded = expandedTurn === turn.turn;
          const toolPct = turn.durationMs > 0 ? Math.round((turn.toolTimeMs || 0) / turn.durationMs * 100) : 0;

          return (
            <div key={turn.turn}>
              <div
                className={`grid grid-cols-12 gap-1 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors ${
                  isExpanded ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                }`}
                onClick={() => setExpandedTurn(isExpanded ? null : turn.turn)}
                title={`Click to ${isExpanded ? 'collapse' : 'expand'} turn ${turn.turn} timeline`}
              >
                <div className="col-span-1 font-mono text-gray-300">{turn.turn}</div>
                <div className="col-span-1 text-gray-400 font-mono">{formatTime(turn.startTs || turn.ts)}</div>
                <div className="col-span-2 text-gray-300">{formatDuration(turn.durationMs)}</div>
                <div className="col-span-2">
                  <span className="text-green">{formatDuration(turn.toolTimeMs)}</span>
                  <span className="text-gray-600 mx-0.5">/</span>
                  <span className="text-accent">{formatDuration(modelMs)}</span>
                </div>
                <div className="col-span-1 font-mono text-gray-400">{turn.toolCount || 0}</div>
                <div className="col-span-1 text-gray-300">{formatCost(turn.cost)}</div>
                <div className="col-span-4">
                  <MiniTimeline turn={turn} />
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && turn.events && (
                <TurnDetail turn={turn} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniTimeline({ turn }) {
  if (!turn.events || turn.events.length === 0 || !turn.durationMs) {
    return <div className="h-3 rounded bg-gray-950/50" />;
  }

  const startTs = turn.startTs || turn.events[0].ts;
  const totalMs = turn.durationMs || 1;

  return (
    <div className="relative h-3 rounded overflow-hidden bg-gray-950/50">
      {turn.events.map((e, i) => {
        const eventStart = e.ts - (e.durationMs || 0);
        const offsetPct = ((eventStart - startTs) / totalMs) * 100;
        const widthPct = ((e.durationMs || Math.max(totalMs * 0.005, 50)) / totalMs) * 100;
        return (
          <div
            key={i}
            className="absolute top-0 h-full rounded-sm opacity-70"
            style={{
              left: `${Math.max(0, Math.min(offsetPct, 100))}%`,
              width: `${Math.max(0.5, Math.min(widthPct, 100))}%`,
              backgroundColor: getToolColor(e.tool),
              minWidth: '1px',
            }}
            title={`${e.tool}: ${e.durationMs ? formatDuration(e.durationMs) : '?'}`}
          />
        );
      })}
    </div>
  );
}

function TurnDetail({ turn }) {
  const [view, setView] = useState('lollipop');
  const events = turn.events || [];
  if (events.length === 0) {
    return (
      <div className="px-4 py-2 text-[10px] text-gray-500 bg-gray-850">
        No tool events recorded for this turn
      </div>
    );
  }

  const startTs = turn.startTs || events[0].ts;
  const totalMs = turn.durationMs || (events[events.length - 1].ts - startTs) || 1;

  const tabs = [
    { id: 'lollipop', label: 'Lollipop', tip: 'Lollipop chart: stem height ∝ duration, dot color by tool family' },
    { id: 'swimlane', label: 'Swimlane', tip: 'Swim-lane view: events grouped horizontally by tool family' },
    { id: 'list',     label: 'List',     tip: 'Chronological list with model-thinking gaps' },
  ];

  return (
    <div className="bg-gray-800/30 border-l-2 border-accent/30 ml-2 mb-1 rounded-b">
      <div className="flex items-center justify-between px-3 pt-1.5">
        <div className="flex gap-1 text-[10px]">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              className={`px-1.5 py-0.5 rounded ${view === t.id ? 'bg-accent/20 text-accent border border-accent/40' : 'text-gray-500 border border-transparent hover:text-gray-300'}`}
              onClick={() => setView(t.id)}
              title={t.tip}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-[9px] text-gray-500 font-mono">
          {events.length} event{events.length === 1 ? '' : 's'} · {formatDuration(totalMs)}
        </span>
      </div>
      {view === 'lollipop' && <LollipopView events={events} startTs={startTs} totalMs={totalMs} />}
      {view === 'swimlane' && <SwimlaneView events={events} startTs={startTs} totalMs={totalMs} />}
      {view === 'list' && <ListView events={events} startTs={startTs} />}
    </div>
  );
}

function LollipopView({ events, startTs, totalMs }) {
  const HEIGHT = 80;
  const LABEL_SPACE = 12;
  const maxDuration = Math.max(...events.map(e => e.durationMs || 0), 1000);
  const ticks = buildScaleTicks(totalMs);

  return (
    <div className="px-3 py-2">
      <div className="relative w-full bg-gray-950/50 rounded" style={{ height: `${HEIGHT + LABEL_SPACE + 6}px` }}>
        {/* Tick marks */}
        {ticks.map((t, i) => (
          <div
            key={`tick-${i}`}
            className="absolute w-px bg-gray-700/30 pointer-events-none"
            style={{ left: `${t.pct}%`, bottom: 0, height: `${HEIGHT}px` }}
          />
        ))}
        {/* Baseline */}
        <div className="absolute left-0 right-0 h-px bg-gray-700/60" style={{ bottom: '4px' }} />
        {/* Stems with dots and numbers */}
        {events.map((e, i) => {
          const eventEnd = e.ts;
          const eventStart = eventEnd - (e.durationMs || 0);
          const midTs = eventStart + (e.durationMs || 0) / 2;
          const xPct = Math.max(0, Math.min(((midTs - startTs) / totalMs) * 100, 100));
          const stemHeight = e.durationMs > 0
            ? Math.max(4, Math.min((e.durationMs / maxDuration) * HEIGHT, HEIGHT))
            : 5;
          const color = getToolColor(e.tool);
          const failed = e.success === false;
          const offsetSec = ((eventStart - startTs) / 1000).toFixed(1);
          const tip = `#${i + 1} ${e.tool}\n${formatDuration(e.durationMs)} at +${offsetSec}s${e.agentId ? `\nAgent: ${e.agentId.slice(0, 8)}` : ''}${failed ? '\nFAILED' : ''}`;

          return (
            <div
              key={i}
              className="absolute group"
              style={{ left: `${xPct}%`, bottom: '4px', transform: 'translateX(-50%)', padding: '0 4px' }}
              title={tip}
            >
              {/* Stem */}
              <div
                className="opacity-60 group-hover:opacity-100 transition-opacity"
                style={{
                  width: '1.5px',
                  height: `${stemHeight}px`,
                  backgroundColor: color,
                  marginLeft: '2.25px',
                }}
              />
              {/* Pin head */}
              <div
                className="absolute rounded-full opacity-90 group-hover:opacity-100 group-hover:scale-150 transition-all"
                style={{
                  width: '6px',
                  height: '6px',
                  backgroundColor: color,
                  bottom: `${stemHeight - 3}px`,
                  left: '4px',
                  boxShadow: failed ? '0 0 0 1.5px rgba(248, 113, 113, 0.7)' : 'none',
                }}
              />
              {/* Number label above pin */}
              <span
                className="absolute text-[8px] font-mono text-gray-500 group-hover:text-gray-300 transition-colors select-none pointer-events-none"
                style={{
                  bottom: `${stemHeight + 2}px`,
                  left: '7px',
                  transform: 'translateX(-50%)',
                  lineHeight: 1,
                }}
              >
                {i + 1}
              </span>
            </div>
          );
        })}
      </div>
      <div className="relative w-full mt-0.5" style={{ height: '12px' }}>
        {ticks.map((t, i) => (
          <span
            key={`label-${i}`}
            className="absolute text-[9px] text-gray-500 font-mono"
            style={{ left: `${t.pct}%`, transform: i === 0 ? 'none' : 'translateX(-50%)' }}
          >
            {formatScaleLabel(t.ms)}
          </span>
        ))}
        <span className="absolute text-[9px] text-gray-400 font-mono" style={{ right: 0 }}>
          {formatScaleLabel(totalMs)}
        </span>
      </div>
    </div>
  );
}

function buildScaleTicks(totalMs) {
  if (totalMs <= 0) return [];
  let interval;
  if (totalMs <= 30_000) interval = 5_000;
  else if (totalMs <= 60_000) interval = 10_000;
  else if (totalMs <= 180_000) interval = 30_000;
  else if (totalMs <= 600_000) interval = 60_000;
  else interval = 120_000;
  const ticks = [];
  for (let t = 0; t <= totalMs; t += interval) {
    ticks.push({ ms: t, pct: (t / totalMs) * 100 });
  }
  return ticks;
}

function formatScaleLabel(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${totalSec}s`;
}

function SwimlaneView({ events, startTs, totalMs }) {
  const LANE_HEIGHT = 16;

  return (
    <div className="px-3 py-2 space-y-1">
      {SWIM_LANES.map((lane, laneIdx) => {
        const laneEvents = events.filter(e => getLaneIndex(e.tool) === laneIdx);
        if (laneEvents.length === 0) return null;
        const totalLaneMs = laneEvents.reduce((s, e) => s + (e.durationMs || 0), 0);
        return (
          <div key={lane.label} className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400 font-mono w-12 text-right">{lane.label}</span>
            <div className="relative flex-1 rounded bg-gray-950/50" style={{ height: `${LANE_HEIGHT}px` }}>
              {laneEvents.map((e, i) => {
                const eventStart = e.ts - (e.durationMs || 0);
                const offsetPct = ((eventStart - startTs) / totalMs) * 100;
                const minWidthPct = (Math.max(totalMs * 0.005, 100) / totalMs) * 100;
                const widthPct = (e.durationMs || 0) > 0
                  ? ((e.durationMs / totalMs) * 100)
                  : minWidthPct;
                const failed = e.success === false;
                return (
                  <div
                    key={i}
                    className="absolute top-0 rounded-sm opacity-80 hover:opacity-100 transition-opacity"
                    style={{
                      left: `${Math.max(0, Math.min(offsetPct, 100))}%`,
                      width: `${Math.max(0.4, Math.min(widthPct, 100))}%`,
                      height: `${LANE_HEIGHT}px`,
                      backgroundColor: lane.hex,
                      minWidth: '2px',
                      boxShadow: failed ? 'inset 0 0 0 1px rgba(248, 113, 113, 0.7)' : 'none',
                    }}
                    title={`${e.tool}: ${formatDuration(e.durationMs)} at +${((e.ts - startTs - (e.durationMs || 0)) / 1000).toFixed(1)}s${e.agentId ? ` (agent ${e.agentId.slice(0, 8)})` : ''}${failed ? ' — FAILED' : ''}`}
                  />
                );
              })}
            </div>
            <span className="text-[9px] text-gray-500 font-mono w-16 text-left">
              {laneEvents.length}× · {formatDuration(totalLaneMs)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ListView({ events, startTs }) {
  return (
    <div className="px-3 py-1.5 space-y-0">
      {events.map((e, i) => {
        const offsetSec = ((e.ts - startTs) / 1000).toFixed(1);
        const gap = i > 0 ? e.ts - (events[i - 1].durationMs || 0) - events[i - 1].ts : e.ts - startTs;

        return (
          <div key={i} className="flex items-center gap-2 text-[10px] py-0.5">
            <span className="text-gray-500 font-mono w-12 text-right" title="Seconds since turn start">
              +{offsetSec}s
            </span>
            {gap > 1000 && (
              <span className="text-accent/60 font-mono text-[9px]" title="Model thinking gap">
                ↕{formatDuration(gap)}
              </span>
            )}
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: getToolColor(e.tool) }}
            />
            <span className="text-gray-300 font-mono whitespace-nowrap">{e.tool}</span>
            {e.durationMs != null && (
              <span className="text-gray-500">{formatDuration(e.durationMs)}</span>
            )}
            {e.agentId && (
              <span className="px-1 py-0 rounded-full bg-accent/10 text-accent border border-accent/30 text-[9px]">
                agent
              </span>
            )}
            {e.success === false && (
              <span className="px-1 py-0 rounded-full bg-red/10 text-red border border-red/40 text-[9px]">
                fail
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
