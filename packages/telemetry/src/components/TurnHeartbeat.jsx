import { useMemo, useState, useEffect } from 'react';
import InfoIcon from './InfoIcon';
import { getToolColor as getToolToken, IDENTITY, VIZ } from '../lib/style-tokens';
import { getModelColor } from '../lib/model-colors';

/**
 * Display-window sizing for the live heatmap. Returns a totalMs that:
 *   - is at least 60s (so very short turns don't render as a tiny strip)
 *   - always leaves ~30s of future runway ahead of the playhead so the
 *     cursor visibly moves through the strip instead of snapping back
 *     when the scale extends.
 *
 * Effective cursor position = elapsed / displayMs, asymptotic to 100%
 * but never reaching it — the strip extends gracefully as time passes.
 */
function getDisplayMs(elapsedMs) {
  return Math.max(60_000, elapsedMs + 30_000);
}

/**
 * Tick a `now` state at `intervalMs` while `isActive` so callers can
 * recompute elapsed-based positions on every tick. Cleans up the
 * interval on unmount or when isActive flips false.
 */
function useTickingNow(isActive, intervalMs = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [isActive, intervalMs]);
  return now;
}

// Adapter: the existing layout code expects a hex string; the style-tokens
// helper returns a palette entry. Keep this thin so we don't carry tool/color
// knowledge in this file.
function getToolColor(tool) {
  return getToolToken(tool).hex;
}

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatScaleLabel(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${totalSec}s`;
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

function LegendRow({ color, label, tools }) {
  return (
    <div className="flex items-start gap-1.5 leading-tight">
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 mt-[3px] ${color}`} />
      <span><span className="text-gray-200 font-medium">{label}</span> <span className="text-gray-500">— {tools}</span></span>
    </div>
  );
}

export default function TurnHeartbeat({ liveSession, toolEvents, sessionId }) {
  const events = liveSession?._currentTurnEvents || [];
  const turnStart = liveSession?._currentTurnStartTs;
  const lastStopAt = liveSession?._lastStopAt || 0;
  const lastUserPromptAt = liveSession?._lastUserPromptAt || 0;
  // "Between turns" = Stop fired more recently than the last UserPromptSubmit
  // AND no tool events have arrived since Stop. The tool-events-since-stop
  // check matters for auto-mode (Claude continues without an intervening
  // UserPromptSubmit) and for forced-continuation cycles (Layer 3a rejection
  // forces another tool call after Stop). In both cases the session is still
  // active even though Stop fired — we only want to render the idle band when
  // the session is genuinely waiting on the user.
  const hasToolActivitySinceStop = lastStopAt > 0
    && (toolEvents || []).some(e => e.session === sessionId && e.timestamp > lastStopAt);
  const isBetweenTurns = lastStopAt > 0
    && lastStopAt >= lastUserPromptAt
    && !hasToolActivitySinceStop;
  const isActive = !!(liveSession && (events.length > 0 || turnStart));

  const now = useTickingNow(isActive, 250);

  const filtered = useMemo(() => {
    if (!sessionId) return [];
    return (toolEvents || []).filter(e => e.session === sessionId && e.timestamp >= (turnStart || 0));
  }, [toolEvents, sessionId, turnStart]);

  const timelineEvents = useMemo(() => {
    if (events.length > 0) return events;
    return filtered.map(e => ({
      ts: e.timestamp,
      tool: e.tool,
      durationMs: e.durationMs,
      type: e.type,
      success: e.success,
      agentId: e.agentId,
    }));
  }, [events, filtered]);

  const infoContent = (
    <div className="space-y-2">
      <p>
        Each cell is a time bucket colored by the dominant tool category.
        Brighter = more calls. Dark gaps = LLM thinking. Blue fill = waiting on the user.
      </p>
      <div className="space-y-0.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Cell colors</div>
        <LegendRow color={IDENTITY.fileio.bg} label={IDENTITY.fileio.label} tools="Read, Write, Edit, NotebookEdit" />
        <LegendRow color={IDENTITY.runtime.bg} label={IDENTITY.runtime.label} tools="Bash, WebFetch, WebSearch" />
        <LegendRow color={IDENTITY.orchestration.bg} label={IDENTITY.orchestration.label} tools="Grep, Glob, Agent, Task, Skill, Plan" />
        <LegendRow color={IDENTITY.meta.bg} label={IDENTITY.meta.label} tools="ToolSearch, AskUserQuestion" />
        <LegendRow color="bg-gray-950 border border-gray-700" label="Dark / empty" tools="LLM thinking (no tool running, turn still active)" />
        <LegendRow color={VIZ.idle.bg} label="Blue fill" tools="User-waiting idle (turn ended, awaiting next prompt)" />
        <LegendRow color={VIZ.subagent.bg} label="Top stripe" tools="Tool fired inside a subagent thread (agentId set)" />
        <LegendRow color={VIZ.compaction.bg} label="Amber vertical" tools="Compaction event (context summarized at this point)" />
        <LegendRow color={VIZ.forcedContinuation.bg} label="Red vertical + ▼" tools="Layer 3a rejection forced Claude to retry" />
        <LegendRow color="bg-accent" label="Dashed vertical" tools="Model switch — colored by destination model (Opus / Sonnet / Haiku)" />
        <LegendRow color={VIZ.activity.bg} label="Green line" tools="Live playhead (current time)" />
      </div>
      <p className="text-gray-500 text-[10px]">
        MCP tools (mcp__*) are mapped by action name. Unknown tools → Meta.
        Hover any cell for per-bucket details.
      </p>
    </div>
  );

  // Between-turn idle: events were cleared on Stop, no new prompt yet. Render
  // a dedicated idle bar with a running timer so the user-waiting time is
  // visually accounted for instead of disappearing into a "Waiting..." string.
  if (isBetweenTurns && timelineEvents.length === 0) {
    const idleMs = Math.max(0, now - lastStopAt);
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Turn Heartbeat
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-blue" title="Turn ended; session is idle waiting for the next user prompt">
              <span className="w-1.5 h-1.5 rounded-full bg-blue" />
              <span className="font-mono uppercase tracking-wider">idle</span>
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-gray-400">
            <span title="Time since the most recent Stop hook fired">{formatDuration(idleMs)} waiting</span>
            <InfoIcon>{infoContent}</InfoIcon>
          </div>
        </div>
        <div className="mt-1.5">
          <div
            className="relative w-full rounded-sm overflow-hidden"
            style={{ height: '28px', backgroundColor: VIZ.idle.rgba(0.18) }}
            title={`Idle for ${formatDuration(idleMs)} — waiting for next user prompt`}
          >
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: '100%', backgroundColor: VIZ.idle.rgba(0.35) }}
            />
            <div
              className="absolute top-0 bottom-0 right-0"
              style={{ width: '2px', background: `linear-gradient(to bottom, ${VIZ.activity.rgba(0.95)}, ${VIZ.activity.rgba(0.55)})`, boxShadow: `0 0 6px ${VIZ.activity.rgba(0.65)}` }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (!isActive || timelineEvents.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Turn Heartbeat</span>
          <InfoIcon>{infoContent}</InfoIcon>
        </div>
        <span className="text-[10px] text-gray-500 mt-1">Waiting for tool activity...</span>
      </div>
    );
  }

  const start = turnStart || timelineEvents[0].ts;
  const elapsed = Math.max(now - start, 1);
  const displayMs = getDisplayMs(elapsed);
  const totalToolMs = timelineEvents.reduce((s, e) => s + (e.durationMs || 0), 0);
  const modelMs = Math.max(0, elapsed - totalToolMs);
  const ticks = buildScaleTicks(displayMs);
  const lastTool = timelineEvents[timelineEvents.length - 1]?.tool;
  const lastColor = getToolColor(lastTool);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Turn Heartbeat
          </span>
          {lastTool && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-500" title={`Last tool: ${lastTool}`}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: lastColor }} />
              <span className="font-mono">{lastTool}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span title="Elapsed time this turn">{formatDuration(elapsed)}</span>
          <span className="text-green" title="Total tool execution time">{formatDuration(totalToolMs)} tools</span>
          <span className="text-accent" title="Estimated model thinking time">{formatDuration(modelMs)} model</span>
          <span title="Tool calls this turn">{timelineEvents.length} calls</span>
          <InfoIcon>{infoContent}</InfoIcon>
        </div>
      </div>
      <HeatmapStrip
        events={timelineEvents}
        startTs={start}
        totalMs={displayMs}
        elapsedMs={elapsed}
        ticks={ticks}
        idleStartMs={isBetweenTurns ? Math.max(0, lastStopAt - start) : null}
        compactEvents={liveSession?._compactEvents || []}
        forcedContinuations={liveSession?._forcedContinuations || []}
        modelSwitches={liveSession?._modelSwitches || []}
      />
      <ScaleLabels ticks={ticks} totalMs={displayMs} />
    </div>
  );
}

function HeatmapStrip({
  events,
  startTs,
  totalMs,
  elapsedMs,
  ticks,
  idleStartMs = null,
  compactEvents = [],
  forcedContinuations = [],
  modelSwitches = [],
}) {
  const HEIGHT = 28;
  const playheadPct = elapsedMs != null
    ? Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100))
    : null;

  // Filter event markers to those that fall inside the visible turn window.
  // Each list uses a different timestamp field name on its records.
  const inWindow = (ts) => ts >= startTs && (ts - startTs) <= totalMs;
  const compactionMarkers = useMemo(
    () => (compactEvents || []).filter(c => c?.ts && inWindow(c.ts)),
    [compactEvents, startTs, totalMs]
  );
  const forcedMarkers = useMemo(
    () => (forcedContinuations || []).filter(f => f?.ts && inWindow(f.ts)),
    [forcedContinuations, startTs, totalMs]
  );
  const switchMarkers = useMemo(
    () => (modelSwitches || []).filter(m => m?.ts && inWindow(m.ts)),
    [modelSwitches, startTs, totalMs]
  );

  const segments = useMemo(() => {
    if (events.length === 0) return [];

    const intervals = events
      .map(e => ({
        startMs: (e.ts - (e.durationMs || 0)) - startTs,
        endMs: e.ts - startTs,
        tool: e.tool,
        durationMs: e.durationMs || 0,
        agentId: e.agentId || null,
      }))
      .sort((a, b) => a.startMs - b.startMs);

    const segs = [];
    let cursor = 0;

    for (const iv of intervals) {
      const toolStart = Math.max(0, iv.startMs);
      if (toolStart > cursor) {
        segs.push({ type: 'gap', startMs: cursor, endMs: toolStart, durationMs: toolStart - cursor });
      }
      segs.push({
        type: 'tool',
        startMs: toolStart,
        endMs: Math.max(toolStart + 1, iv.endMs),
        tool: iv.tool,
        durationMs: iv.durationMs,
        agentId: iv.agentId,
      });
      cursor = Math.max(cursor, iv.endMs);
    }

    const displayEnd = Math.max(elapsedMs || 0, totalMs);
    if (cursor < displayEnd) {
      // If Stop has fired (idleStartMs set) and falls inside the trailing gap,
      // split the gap into a leading "thinking" portion (before Stop) and a
      // trailing "idle" portion (after Stop). Either side may be zero-length.
      if (idleStartMs != null && idleStartMs >= cursor && idleStartMs < displayEnd) {
        if (idleStartMs > cursor) {
          segs.push({ type: 'gap', startMs: cursor, endMs: idleStartMs, durationMs: idleStartMs - cursor });
        }
        segs.push({ type: 'idle', startMs: idleStartMs, endMs: displayEnd, durationMs: displayEnd - idleStartMs });
      } else {
        segs.push({ type: 'gap', startMs: cursor, endMs: displayEnd, durationMs: displayEnd - cursor });
      }
    }

    return segs;
  }, [events, startTs, totalMs, elapsedMs, idleStartMs]);

  return (
    <div className="mt-1.5">
      <div className="relative w-full bg-gray-950/40 rounded-sm overflow-hidden" style={{ height: `${HEIGHT}px` }}>
        {/* Segments — width proportional to duration */}
        <div className="flex w-full h-full">
          {segments.map((seg, i) => {
            const widthPct = ((seg.endMs - seg.startMs) / totalMs) * 100;
            if (seg.type === 'gap') {
              const startSec = (seg.startMs / 1000).toFixed(0);
              const endSec = (seg.endMs / 1000).toFixed(0);
              return (
                <div
                  key={i}
                  className="h-full transition-opacity hover:opacity-80"
                  style={{ width: `${widthPct}%`, backgroundColor: 'rgba(30, 30, 40, 0.5)', minWidth: widthPct > 0.3 ? '1px' : '0' }}
                  title={`${startSec}–${endSec}s: model thinking (${formatDuration(seg.durationMs)})`}
                />
              );
            }
            if (seg.type === 'idle') {
              const startSec = (seg.startMs / 1000).toFixed(0);
              const endSec = (seg.endMs / 1000).toFixed(0);
              return (
                <div
                  key={i}
                  className="h-full transition-opacity hover:opacity-80"
                  style={{ width: `${widthPct}%`, backgroundColor: VIZ.idle.rgba(0.35), minWidth: widthPct > 0.3 ? '1px' : '0' }}
                  title={`${startSec}–${endSec}s: user-waiting idle (${formatDuration(seg.durationMs)})`}
                />
              );
            }
            const catColor = getToolToken(seg.tool);
            const startSec = (seg.startMs / 1000).toFixed(1);
            const endSec = (seg.endMs / 1000).toFixed(1);
            const inSubagent = !!seg.agentId;
            return (
              <div
                key={i}
                className="relative h-full transition-opacity hover:opacity-80"
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: `${catColor.hex}cc`,
                  minWidth: '2px',
                }}
                title={`${startSec}–${endSec}s: ${seg.tool}${inSubagent ? ' (subagent)' : ''} (${formatDuration(seg.durationMs)})`}
              >
                {inSubagent && (
                  <span
                    className="absolute top-0 left-0 right-0 pointer-events-none"
                    style={{ height: '3px', backgroundColor: VIZ.subagent.hex }}
                  />
                )}
              </div>
            );
          })}
        </div>
        {/* Tick overlay */}
        {ticks.slice(1).map((t, i) => (
          <div
            key={`tick-${i}`}
            className="absolute top-0 w-px bg-gray-700/40 pointer-events-none"
            style={{ left: `${t.pct}%`, height: `${HEIGHT}px` }}
          />
        ))}
        {/* Compaction markers — full-height amber lines at each compaction event */}
        {compactionMarkers.map((c, i) => {
          const pct = ((c.ts - startTs) / totalMs) * 100;
          const trigger = c.trigger || 'auto';
          return (
            <div
              key={`cmp-${i}`}
              className="absolute top-0 pointer-events-none"
              style={{
                left: `${pct}%`,
                height: `${HEIGHT}px`,
                width: '1.5px',
                marginLeft: '-0.75px',
                backgroundColor: VIZ.compaction.hex,
                opacity: 0.75,
                zIndex: 1,
              }}
              title={`compaction (${trigger}) at +${Math.round((c.ts - startTs) / 1000)}s`}
            />
          );
        })}
        {/* Forced-continuation markers — full-height red lines with a small triangle on top */}
        {forcedMarkers.map((f, i) => {
          const pct = ((f.ts - startTs) / totalMs) * 100;
          const tip = `Layer 3a rejection forced retry at +${Math.round((f.ts - startTs) / 1000)}s${f.firstTool ? ` · firstTool: ${f.firstTool}` : ''}`;
          return (
            <div key={`fc-${i}`} className="absolute top-0 pointer-events-none" style={{ left: `${pct}%`, height: `${HEIGHT}px`, zIndex: 1 }} title={tip}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '2px',
                  marginLeft: '-1px',
                  height: `${HEIGHT}px`,
                  backgroundColor: VIZ.forcedContinuation.hex,
                  opacity: 0.85,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '-4px',
                  left: 0,
                  marginLeft: '-3px',
                  width: 0,
                  height: 0,
                  borderLeft: '3px solid transparent',
                  borderRight: '3px solid transparent',
                  borderTop: `4px solid ${VIZ.forcedContinuation.hex}`,
                }}
              />
            </div>
          );
        })}
        {/* Model-switch markers — dashed full-height line in the destination model's color */}
        {switchMarkers.map((m, i) => {
          const pct = ((m.ts - startTs) / totalMs) * 100;
          const destColor = getModelColor(m.to).hex;
          return (
            <div
              key={`mw-${i}`}
              className="absolute top-0 pointer-events-none"
              style={{
                left: `${pct}%`,
                height: `${HEIGHT}px`,
                width: 0,
                borderLeft: `1.5px dashed ${destColor}`,
                marginLeft: '-0.75px',
                opacity: 0.7,
                zIndex: 1,
              }}
              title={`model switched: ${m.from || '?'} → ${m.to || '?'}`}
            />
          );
        })}
        {/* Playhead — vertical cursor tracking elapsed time. Smooth-transitioned
            on left% so the 250ms tick rate doesn't show as visible jumps. */}
        {playheadPct != null && (
          <>
            <div
              className="absolute top-0 pointer-events-none"
              style={{
                left: `${playheadPct}%`,
                height: `${HEIGHT}px`,
                width: '2px',
                marginLeft: '-1px',
                background: `linear-gradient(to bottom, ${VIZ.activity.rgba(0.95)}, ${VIZ.activity.rgba(0.55)})`,
                boxShadow: `0 0 6px ${VIZ.activity.rgba(0.65)}`,
                transition: 'left 240ms linear',
                zIndex: 2,
              }}
              title={`Now · t = ${Math.round((elapsedMs ?? 0) / 1000)}s`}
            />
            <div
              className="absolute pointer-events-none animate-pulse-dot"
              style={{
                left: `${playheadPct}%`,
                top: '-2px',
                width: '6px',
                height: '6px',
                marginLeft: '-3px',
                background: VIZ.activity.hex,
                borderRadius: '50%',
                boxShadow: `0 0 4px ${VIZ.activity.rgba(0.9)}`,
                transition: 'left 240ms linear',
                zIndex: 3,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ScaleLabels({ ticks, totalMs }) {
  return (
    <div className="relative w-full" style={{ height: '14px' }}>
      {ticks.map((t, i) => (
        <span
          key={`label-${i}`}
          className="absolute text-[9px] text-gray-500 font-mono"
          style={{ left: `${t.pct}%`, transform: i === 0 ? 'none' : 'translateX(-50%)' }}
        >
          {formatScaleLabel(t.ms)}
        </span>
      ))}
      <span
        className="absolute text-[9px] text-gray-400 font-mono"
        style={{ right: 0 }}
      >
        {formatScaleLabel(totalMs)}
      </span>
    </div>
  );
}
