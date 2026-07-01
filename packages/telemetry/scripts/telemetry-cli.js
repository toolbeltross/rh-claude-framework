#!/usr/bin/env node
// Standalone CLI for Claude Code telemetry — zero external dependencies.
// Reuses parsing logic from server/parser.js using only Node.js built-ins.

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { CLAUDE_JSON_PATH, STATS_CACHE_PATH, PORT, DEFAULT_CONTEXT_WINDOW_SIZE, resolveContextWindowSize } from '../server/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLAUDE_JSON = CLAUDE_JSON_PATH;
const STATS_CACHE = STATS_CACHE_PATH;

// True only when run directly (node telemetry-cli.js …), false when imported by
// tests. Lets us export the pure helpers without the CLI auto-running on import.
// Path-normalized compare (Windows separator/case differences).
function pathsEqual(a, b) {
  if (!a || !b) return false;
  const n = (p) => p.replace(/\\/g, '/').toLowerCase();
  return n(a) === n(b);
}
const isMain = pathsEqual(process.argv[1], fileURLToPath(import.meta.url));

// ── Parsing (mirrors server/parser.js) ──────────────────────────────────────

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function friendlyModelName(id) {
  if (!id) return 'unknown';
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  return id;
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatCost(usd) {
  if (usd == null) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n) {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function parseSession(path, proj) {
  const modelUsage = proj.lastModelUsage || {};
  const models = Object.entries(modelUsage).map(([id, d]) => ({
    id,
    name: friendlyModelName(id),
    inputTokens: d.inputTokens || 0,
    outputTokens: d.outputTokens || 0,
    cacheRead: d.cacheReadInputTokens || 0,
    cacheWrite: d.cacheCreationInputTokens || 0,
    cost: d.costUSD || 0,
  }));

  const primary = models.reduce((b, m) => (m.cost > (b?.cost || 0) ? m : b), null);

  const input = proj.lastTotalInputTokens || 0;
  const output = proj.lastTotalOutputTokens || 0;
  const cacheRead = proj.lastTotalCacheReadInputTokens || 0;
  const cacheWrite = proj.lastTotalCacheCreationInputTokens || 0;

  return {
    sessionId: proj.lastSessionId || 'unknown',
    projectPath: path,
    projectName: projectNameOf(path),
    cost: proj.lastCost || 0,
    duration: formatDuration(proj.lastDuration),
    durationMs: proj.lastDuration || 0,
    primaryModel: primary?.name || 'unknown',
    models,
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    linesAdded: proj.lastLinesAdded || 0,
    linesRemoved: proj.lastLinesRemoved || 0,
    fps: proj.lastFpsAverage || 0,
    performance: proj.lastSessionMetrics || null,
  };
}

// Normalize a path for comparison: backslashes→slashes, trailing slash stripped,
// lowercased (Windows is case-insensitive; OneDrive paths mix separator styles).
function normalizeDir(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Last path segment, separator-agnostic. Native basename() only splits on the
// host OS separator, so a Windows path (C:\…\proj) processed on a Linux server
// would return the whole string. Split on BOTH \ and / regardless of platform.
function projectNameOf(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'unknown';
}

// Pick the live session that belongs to the *caller*, not merely whichever
// session pinged the server most recently. With several concurrent Claude
// sessions all POSTing live status (statusLine fires every ~2s), max(_lastSeen)
// is non-deterministic and frequently returns a different session — or even a
// different project — than the one that invoked this CLI. Priority:
//   1. exact session_id match  (precise; survives multiple sessions per project)
//   2. same working directory  (scopes to the right project at least)
//   3. globally most-recent    (legacy fallback — preserves old behavior)
// Returns [id, raw] or null. Pure — unit-testable without a server.
function selectLiveSession(liveSessions, { sessionId, cwd } = {}) {
  const entries = Object.entries(liveSessions || {});
  if (entries.length === 0) return null;
  const byRecency = (a, b) => (b[1]._lastSeen || 0) - (a[1]._lastSeen || 0);

  if (sessionId) {
    const exact = entries.filter(([id, s]) => (s.session_id || id) === sessionId);
    if (exact.length) return exact.sort(byRecency)[0];
  }
  const normCwd = normalizeDir(cwd);
  if (normCwd) {
    const sameCwd = entries.filter(([, s]) => normalizeDir(s.workspace?.current_dir) === normCwd);
    if (sameCwd.length) return sameCwd.sort(byRecency)[0];
  }
  return entries.sort(byRecency)[0];
}

// Map a raw live-session record (server snapshot shape) to the flat shape the
// printers consume. Claude Code's statusLine payload nests its real context
// numbers under context_window.{context_window_size, used_percentage,
// total_input_tokens, current_usage.*}. The previous mapping read
// total_tokens / input_tokens / cache_read_tokens etc. — fields that never
// exist in the payload — so it silently fell back to the 200K default and
// zeroed the breakdown even for 1M-context Opus sessions. Pure — unit-testable.
function normalizeLiveSession(raw, id) {
  const cwd = raw.workspace?.current_dir || '';
  const cw = raw.context_window;
  let contextWindow = null;
  if (cw) {
    const usage = cw.current_usage || {};
    const limit = cw.context_window_size || cw._resolvedSize ||
      resolveContextWindowSize(null, raw.model?.display_name, cw.total_input_tokens) ||
      DEFAULT_CONTEXT_WINDOW_SIZE;
    const usedTokens = cw.total_input_tokens ?? 0;
    const usedPercentage = cw.used_percentage ??
      (limit > 0 && usedTokens > 0 ? Math.round((usedTokens / limit) * 100) : 0);
    contextWindow = {
      usedPercentage,
      usedTokens,
      limit,
      // Composition of the most-recent request (NOT cumulative window
      // occupancy — cache_read in particular is cumulative and dwarfs the
      // window, so these must never be summed for a "used" headline).
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
    };
  }
  return {
    sessionId: raw.session_id || id,
    projectName: projectNameOf(cwd),
    cwd,
    model: raw.model?.display_name || 'Active',
    cost: raw.cost?.total_cost_usd ?? 0,
    contextWindow,
    _toolCount: raw._toolCount || 0,
    _lastTool: raw._lastTool || null,
    _lastSeen: raw._lastSeen || 0,
    _turnCount: raw._turnCount || 0,
    _tokensPerTurn: raw._tokensPerTurn || 0,
    _estimatedTurnsRemaining: raw._estimatedTurnsRemaining ?? null,
    _activeSubagents: raw._activeSubagents || {},
    _subagentHistory: raw._subagentHistory || [],
    _durationMs: raw._durationMs || 0,
  };
}

async function fetchLiveSessions() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/snapshot`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.liveSessions || Object.keys(data.liveSessions).length === 0) return null;
    const picked = selectLiveSession(data.liveSessions, {
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      cwd: process.cwd(),
    });
    if (!picked) return null;
    return normalizeLiveSession(picked[1], picked[0]);
  } catch {
    return null;
  }
}

async function loadData() {
  const [claudeJson, statsCache, liveSession] = await Promise.all([
    readJSON(CLAUDE_JSON),
    readJSON(STATS_CACHE),
    fetchLiveSessions(),
  ]);

  const sessions = [];
  if (claudeJson?.projects) {
    for (const [path, proj] of Object.entries(claudeJson.projects)) {
      if (!proj.lastSessionId) continue;
      sessions.push(parseSession(path, proj));
    }
  }
  sessions.sort((a, b) => b.cost - a.cost);

  const topSession = sessions[0] || null;

  return { sessions, topSession, liveSession, stats: statsCache };
}

// ── Output formatters ───────────────────────────────────────────────────────

function printSummary({ sessions, topSession, liveSession, stats }) {
  const lines = ['=== Claude Code Telemetry ===', ''];

  if (liveSession) {
    lines.push(`=== ${liveSession.projectName} (live) ===`);

    // 1. Context — most important
    if (liveSession.contextWindow) {
      const cw = liveSession.contextWindow;
      const limit = cw.limit || DEFAULT_CONTEXT_WINDOW_SIZE;
      const used = cw.usedTokens || 0;
      const pct = cw.usedPercentage ?? (used > 0 ? Math.round((used / limit) * 100) : 0);
      const turnsLeft = liveSession._estimatedTurnsRemaining;
      const turnsStr = turnsLeft != null ? ` | ~${turnsLeft} turns left` : '';
      lines.push(`Context: ${pct}% | ${formatTokens(used)}/${formatTokens(limit)}${turnsStr}`);
    }

    // 2. Agents — summary line + per-agent cost breakdown
    const activeAgents = Object.values(liveSession._activeSubagents || {});
    const completedAgents = liveSession._subagentHistory || [];
    if (activeAgents.length > 0 || completedAgents.length > 0) {
      const activeTypes = activeAgents.map(a => a.type).join(', ');
      const activeStr = activeAgents.length > 0 ? `${activeAgents.length} active (${activeTypes})` : '0 active';
      const agentTotalCost = completedAgents.reduce((s, a) => s + (a.cost || 0), 0);
      const costStr = agentTotalCost > 0 ? ` | ${formatCost(agentTotalCost)}` : '';
      const pct = agentTotalCost > 0 && liveSession.cost > 0
        ? ` (${((agentTotalCost / liveSession.cost) * 100).toFixed(1)}%)`
        : '';
      lines.push(`Agents: ${activeStr} | ${completedAgents.length} completed${costStr}${pct}`);
      // Per-agent cost lines (completed only, sorted by cost desc)
      if (completedAgents.length > 0) {
        const sorted = completedAgents.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0));
        for (const a of sorted) {
          const model = friendlyModelName(a.model || a.modelId || '');
          const tokens = a.tokens ? (a.tokens.input || 0) + (a.tokens.output || 0) : 0;
          const dur = a.durationMs ? formatDuration(a.durationMs) : '';
          const est = a.costEstimated ? '~' : '';
          lines.push(`  ${(a.type || '?').padEnd(14)} ${model.padEnd(7)} ${est}${formatCost(a.cost).padStart(7)}  ${formatTokens(tokens).padStart(6)}  ${dur}`);
        }
      }
    }

    // 3. Tools
    if (liveSession._toolCount) {
      lines.push(`Tools: ${liveSession._toolCount}${liveSession._lastTool ? ` (last: ${liveSession._lastTool})` : ''}`);
    }

    // 4. Turns / Velocity
    if (liveSession._turnCount) {
      const velocity = liveSession._tokensPerTurn ? `${formatTokens(liveSession._tokensPerTurn)}/turn` : '';
      lines.push(`Turn: ${liveSession._turnCount}${velocity ? ` | Velocity: ${velocity}` : ''}`);
    }

    // 5. Cost / Model / Duration — last
    const model = friendlyModelName(liveSession.model);
    const cost = formatCost(liveSession.cost);
    lines.push(`${cost} | ${model}`);
  }

  if (stats) {
    if (liveSession) lines.push('');
    lines.push(`Sessions: ${stats.totalSessions || 0} | Messages: ${stats.totalMessages || 0}${stats.firstSessionDate ? ` | Since: ${stats.firstSessionDate}` : ''}`);
  } else if (!liveSession) {
    lines.push('No sessions found.');
  }

  return lines.join('\n');
}

function printSessions({ sessions }, cwd) {
  const lines = ['=== All Sessions ===', ''];

  if (sessions.length === 0) {
    lines.push('No sessions found.');
    return lines.join('\n');
  }

  // Sort: current project first, then by cost descending
  const normCwd = cwd ? cwd.replace(/\\/g, '/').toLowerCase() : '';
  const sorted = [...sessions].sort((a, b) => {
    const aMatch = normCwd && a.projectPath.replace(/\\/g, '/').toLowerCase() === normCwd ? 1 : 0;
    const bMatch = normCwd && b.projectPath.replace(/\\/g, '/').toLowerCase() === normCwd ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    return b.cost - a.cost;
  });

  lines.push(`  ${'Project'.padEnd(25)} ${'Model'.padEnd(8)} ${'Cost'.padStart(7)}  ${'Duration'.padEnd(10)} ${'Lines'.padEnd(12)}`);
  lines.push('  ' + '-'.repeat(68));

  for (const s of sorted) {
    const isCurrent = normCwd && s.projectPath.replace(/\\/g, '/').toLowerCase() === normCwd;
    const marker = isCurrent ? '* ' : '  ';
    const linesStr = `+${s.linesAdded}/-${s.linesRemoved}`;
    lines.push(`${marker}${s.projectName.padEnd(25)} ${s.primaryModel.padEnd(8)} ${formatCost(s.cost).padStart(7)}  ${s.duration.padEnd(10)} ${linesStr}`);
  }

  lines.push('');
  const totalCost = sorted.reduce((sum, s) => sum + s.cost, 0);
  lines.push(`Total: ${sorted.length} sessions, ${formatCost(totalCost)}`);

  return lines.join('\n');
}

function printCosts({ sessions }) {
  const lines = ['=== Cost Breakdown by Model ===', ''];

  const byModel = {};
  for (const s of sessions) {
    for (const m of s.models) {
      if (!byModel[m.name]) byModel[m.name] = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      byModel[m.name].cost += m.cost;
      byModel[m.name].input += m.inputTokens;
      byModel[m.name].output += m.outputTokens;
      byModel[m.name].cacheRead += m.cacheRead;
      byModel[m.name].cacheWrite += m.cacheWrite;
    }
  }

  const sorted = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  const totalCost = sorted.reduce((sum, [, d]) => sum + d.cost, 0);

  for (const [name, d] of sorted) {
    const pct = totalCost > 0 ? ((d.cost / totalCost) * 100).toFixed(1) : '0.0';
    lines.push(`${name}:`);
    lines.push(`  Cost: ${formatCost(d.cost)} (${pct}%)`);
    lines.push(`  Input: ${formatTokens(d.input)} | Output: ${formatTokens(d.output)}`);
    lines.push(`  Cache Read: ${formatTokens(d.cacheRead)} | Cache Write: ${formatTokens(d.cacheWrite)}`);
    lines.push('');
  }

  lines.push(`Total across all sessions: ${formatCost(totalCost)}`);

  return lines.join('\n');
}

function printContext({ topSession, liveSession }) {
  const lines = ['=== Context Window ===', ''];

  if (liveSession) {
    const name = liveSession.projectName || 'unknown';
    const model = friendlyModelName(liveSession.model);
    lines.push(`Project: ${name} (live)`);
    lines.push(`Model: ${model}`);

    if (liveSession.contextWindow) {
      const cw = liveSession.contextWindow;
      const input = cw.input || 0;
      const output = cw.output || 0;
      const cacheRead = cw.cacheRead || 0;
      const cacheWrite = cw.cacheWrite || 0;
      const limit = cw.limit || DEFAULT_CONTEXT_WINDOW_SIZE;
      const used = cw.usedTokens || 0;
      const pct = cw.usedPercentage ?? (used > 0 ? Math.round((used / limit) * 100) : 0);
      const cacheTotal = cacheRead + input;
      const cacheHit = cacheTotal > 0 ? ((cacheRead / cacheTotal) * 100).toFixed(1) : '0.0';

      lines.push('');
      lines.push(`Context Used: ${formatTokens(used)} / ${formatTokens(limit)} (${pct}%)`);
      lines.push('');
      lines.push('Most recent request:');
      lines.push(`  Input:       ${formatTokens(input).padStart(8)}`);
      lines.push(`  Output:      ${formatTokens(output).padStart(8)}`);
      lines.push(`  Cache Read:  ${formatTokens(cacheRead).padStart(8)}`);
      lines.push(`  Cache Write: ${formatTokens(cacheWrite).padStart(8)}`);
      lines.push('');
      lines.push(`Cache Hit Ratio: ${cacheHit}%`);
    } else {
      lines.push('');
      lines.push(`Cost: ${formatCost(liveSession.cost)}`);
      lines.push('(Context window details not yet available)');
    }
    return lines.join('\n');
  }

  if (!topSession) {
    lines.push('No session data found.');
    return lines.join('\n');
  }

  const t = topSession.tokens;
  const limit = DEFAULT_CONTEXT_WINDOW_SIZE;
  const pct = t.total > 0 ? ((t.total / limit) * 100).toFixed(1) : '0.0';
  const cacheTotal = t.cacheRead + t.input;
  const cacheHit = cacheTotal > 0 ? ((t.cacheRead / cacheTotal) * 100).toFixed(1) : '0.0';

  lines.push(`Project: ${topSession.projectName}`);
  lines.push(`Model: ${topSession.primaryModel}`);
  lines.push('');
  lines.push(`Total Tokens: ${formatTokens(t.total)} / ${formatTokens(limit)} (${pct}%)`);
  lines.push('');
  lines.push('Breakdown:');
  lines.push(`  Input:       ${formatTokens(t.input).padStart(8)}`);
  lines.push(`  Output:      ${formatTokens(t.output).padStart(8)}`);
  lines.push(`  Cache Read:  ${formatTokens(t.cacheRead).padStart(8)}`);
  lines.push(`  Cache Write: ${formatTokens(t.cacheWrite).padStart(8)}`);
  lines.push('');
  lines.push(`Cache Hit Ratio: ${cacheHit}%`);

  if (topSession.performance) {
    const p = topSession.performance;
    lines.push('');
    lines.push('Performance:');
    if (topSession.fps) lines.push(`  FPS: ${topSession.fps.toFixed(1)}`);
    if (p.p50) lines.push(`  p50: ${p.p50.toFixed(1)}ms | p95: ${(p.p95 || 0).toFixed(1)}ms | p99: ${(p.p99 || 0).toFixed(1)}ms`);
  }

  return lines.join('\n');
}

function printActivity({ stats }) {
  const lines = ['=== Daily Activity ===', ''];

  if (!stats?.dailyActivity?.length) {
    lines.push('No activity data found.');
    return lines.join('\n');
  }

  lines.push(`${'Date'.padEnd(12)} ${'Msgs'.padStart(6)} ${'Sessions'.padStart(9)} ${'Tools'.padStart(7)}`);
  lines.push('-'.repeat(38));

  // Show last 14 days
  const recent = stats.dailyActivity.slice(-14);
  for (const day of recent) {
    const date = day.date || day.day || '?';
    lines.push(`${date.padEnd(12)} ${String(day.messages || 0).padStart(6)} ${String(day.sessions || 0).padStart(9)} ${String(day.tools || 0).padStart(7)}`);
  }

  lines.push('');
  if (stats.totalSessions) lines.push(`Total Sessions: ${stats.totalSessions}`);
  if (stats.totalMessages) lines.push(`Total Messages: ${stats.totalMessages}`);

  return lines.join('\n');
}

function printSession({ sessions }, name) {
  const match = sessions.find(
    (s) => s.projectName.toLowerCase() === name.toLowerCase() || s.projectPath.toLowerCase().includes(name.toLowerCase())
  );

  if (!match) {
    return `No session found matching "${name}".\nAvailable: ${sessions.map((s) => s.projectName).join(', ')}`;
  }

  const t = match.tokens;
  const limit = DEFAULT_CONTEXT_WINDOW_SIZE;
  const pct = t.total > 0 ? ((t.total / limit) * 100).toFixed(1) : '0.0';
  const cacheTotal = t.cacheRead + t.input;
  const cacheHit = cacheTotal > 0 ? ((t.cacheRead / cacheTotal) * 100).toFixed(1) : '0.0';

  const lines = [
    `=== Session: ${match.projectName} ===`,
    '',
    `Path: ${match.projectPath}`,
    `Model: ${match.primaryModel}`,
    `Cost: ${formatCost(match.cost)}`,
    `Duration: ${match.duration}`,
    `Lines: +${match.linesAdded} / -${match.linesRemoved}`,
    '',
    `Context: ${formatTokens(t.total)} / ${formatTokens(limit)} (${pct}%)`,
    `Cache Hit: ${cacheHit}%`,
    '',
    'Model Breakdown:',
  ];

  for (const m of match.models) {
    lines.push(`  ${m.name}: ${formatCost(m.cost)} | In: ${formatTokens(m.inputTokens)} | Out: ${formatTokens(m.outputTokens)}`);
  }

  if (match.performance) {
    const p = match.performance;
    lines.push('');
    lines.push('Performance:');
    if (match.fps) lines.push(`  FPS: ${match.fps.toFixed(1)}`);
    if (p.p50) lines.push(`  p50: ${p.p50.toFixed(1)}ms | p95: ${(p.p95 || 0).toFixed(1)}ms | p99: ${(p.p99 || 0).toFixed(1)}ms`);
  }

  return lines.join('\n');
}

async function printLive() {
  // Try to reach the server first
  let liveSession = await fetchLiveSessions();

  if (!liveSession) {
    // Attempt to start the server in background
    const startBg = join(__dirname, 'start-bg.js');
    try {
      const child = spawn(process.execPath, [startBg], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      // ignore spawn failure — we'll report the fetch failure below
    }

    // Poll up to 3 times (1s apart)
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      liveSession = await fetchLiveSessions();
      if (liveSession) break;
    }
  }

  if (!liveSession) {
    return 'No live session reachable. Server may not be running.\nRun: rh-telemetry start';
  }

  // Reuse the live portion of printSummary
  const data = { sessions: [], topSession: null, liveSession, stats: null };
  return printSummary(data);
}

// ── Main ────────────────────────────────────────────────────────────────────

if (isMain) {
const args = process.argv.slice(2);
const command = (args[0] || 'summary').toLowerCase();

// 'live' is special — may need to start the server before loading data
if (command === 'live') {
  console.log(await printLive());
  process.exit(0);
}

const data = await loadData();

let output;
switch (command) {
  case 'summary':
    output = printSummary(data);
    break;
  case 'sessions':
    output = printSessions(data, process.cwd());
    break;
  case 'costs':
  case 'cost':
    output = printCosts(data);
    break;
  case 'context':
    output = printContext(data);
    break;
  case 'activity':
    output = printActivity(data);
    break;
  case 'session':
    if (!args[1]) {
      output = 'Usage: telemetry-cli.js session <project-name>';
    } else {
      output = printSession(data, args.slice(1).join(' '));
    }
    break;
  default:
    // Treat unknown command as a session name lookup
    output = printSession(data, args.join(' '));
    break;
}

console.log(output);
}

// Pure helpers exported for unit testing (no server / no side effects on import).
export { selectLiveSession, normalizeLiveSession, normalizeDir };