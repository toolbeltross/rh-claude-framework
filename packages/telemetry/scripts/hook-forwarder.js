#!/usr/bin/env node
/**
 * Hook forwarder — reads JSON from stdin, POSTs to telemetry server.
 * Works cross-platform (no curl/jq/bash dependency).
 *
 * Usage:
 *   StatusLine:  echo '{"model":...}' | node hook-forwarder.js status
 *   ToolEvent:   node hook-forwarder.js tool <tool_name> <session_id> [event_type]
 */
import http from 'http';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, openSync, fstatSync, readSync, closeSync, mkdirSync, statSync, renameSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { appendFile } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { BASE_URL, HOOK_FORWARDER_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW_SIZE, IDLE_MARKER_PATH, SUPERVISORY_LOG_PATH, OVERSIGHT_LOG_PATH, apiUrl, resolveContextWindowSize } from '../server/config.js';
import { MODEL_RATES, getTier } from '../server/cost-rates.js';
import { shouldPiggybackStatus } from './piggyback-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOG_FILE = join(PROJECT_ROOT, 'hook-debug.log');
const LOG_FILE_ROTATED = LOG_FILE + '.1';
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB; at current rate ~55 days per rotation
const SNAPSHOT_URL = apiUrl('/api/snapshot');
const TIMEOUT = HOOK_FORWARDER_TIMEOUT_MS;

let _rotateChecked = false;
function rotateIfNeeded() {
  // Each hook invocation is a fresh process, so one stat-per-run is cheap.
  if (_rotateChecked) return;
  _rotateChecked = true;
  try {
    const s = statSync(LOG_FILE);
    if (s.size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, LOG_FILE_ROTATED); // overwrites any prior .1
    }
  } catch {} // missing file or rename race — fine, next append creates it
}

function debugLog(msg) {
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ─── Oversight event helpers (added 2026-05-08, P2-1) ────────────────────
// Inline schema matches packages/oversight/scripts/lib/oversight-events.js
// (cross-package require is fragile in ESM; small enough to duplicate).
// HOME-first, to match @rh/shared/config (which the oversight scripts that READ
// this events file use). USERPROFILE-first here could write to a different
// .claude than they read on Git-Bash, where HOME and USERPROFILE both exist but differ.
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
const EVENTS_LOG_PATH = join(HOME_DIR, '.claude', 'oversight-events.jsonl');
const SUBAGENT_FLAG_DIR = join(HOME_DIR, '.claude');

function emitOversightEvent(eventType, data) {
  try {
    const safeData = data || {};
    const dataStr = JSON.stringify(safeData, Object.keys(safeData).sort());
    const contentHash = createHash('sha256').update(dataStr).digest('hex');
    const event = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      data: safeData,
      content_hash: contentHash,
    };
    appendFileSync(EVENTS_LOG_PATH, JSON.stringify(event) + '\n');
  } catch (e) {
    debugLog(`emitOversightEvent error: ${e.message}`);
  }
}

function subagentFlagPath(agentId) {
  return join(SUBAGENT_FLAG_DIR, `subagent-active-${agentId}.flag`);
}

function post(path, data) {
  return new Promise((resolve) => {
    // Stamp the calling process's entrypoint (claude-desktop / cli / claude-vscode)
    // on every payload so the dashboard can tell interactive sessions from
    // headless runs (cron, scheduled tasks, script-spawned `claude -p`).
    if (data && typeof data === 'object' && !data.entrypoint && process.env.CLAUDE_CODE_ENTRYPOINT) {
      data = { ...data, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT };
    }
    const body = JSON.stringify(data);
    const req = http.request(
      `${BASE_URL}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: TIMEOUT },
      (res) => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve()); // silently fail if server not running
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve) => {
    const req = http.request(
      `${BASE_URL}${path}`,
      { method: 'GET', timeout: TIMEOUT },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Append a one-line progress entry to ~/.claude/telemetry-supervisory-log.md (absorbed from progress-tracker.js) */
async function appendProgressEntry(sessionId) {
  try {
    const snapshot = await get('/api/snapshot');
    if (!snapshot) return;
    const liveData = snapshot.liveSessions?.[sessionId];
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const sid = (sessionId || 'unknown').slice(0, 8);
    const turn = liveData?._turnCount ?? '?';
    const cost = liveData?.cost?.total_cost_usd?.toFixed(2) ?? '?';
    const ctxPct = liveData?.context_window?.used_percentage ?? '?';
    const model = liveData?.model?.display_name || liveData?.model?.id || '?';
    const toolCount = liveData?._toolCount ?? '?';
    const entry = `\n- **${ts}** | \`${sid}\` | Turn ${turn} | $${cost} | Context ${ctxPct}% | ${model} | ${toolCount} tools`;
    try {
      await appendFile(SUPERVISORY_LOG_PATH, entry + '\n', 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        const header = `# Supervisory Agent Log\n\nAppend-only log of supervisory agent findings.\n\n---\n\n## Session Progress\n`;
        try {
          mkdirSync(dirname(SUPERVISORY_LOG_PATH), { recursive: true });
          await appendFile(SUPERVISORY_LOG_PATH, header + entry + '\n', 'utf-8');
        } catch {}
      }
    }
    // Dual-write to oversight-system log if OVERSIGHT_LOG_PATH is set. Best-effort:
    // OneDrive offline, missing dir, or permission errors are logged and swallowed
    // so a broken secondary target never disrupts the primary write or the Stop hook.
    if (OVERSIGHT_LOG_PATH) {
      try {
        await appendFile(OVERSIGHT_LOG_PATH, entry + '\n', 'utf-8');
      } catch (err) {
        debugLog(`oversight-log append error: ${err.code || ''} ${err.message}`);
      }
    }
    debugLog(`progress-entry: ${sid} turn=${turn} cost=$${cost} ctx=${ctxPct}% oversight=${OVERSIGHT_LOG_PATH ? 'on' : 'off'}`);
  } catch (e) {
    debugLog(`progress-entry error: ${e.message}`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout in case stdin never closes
    setTimeout(() => resolve(data), 2000);
  });
}

/** Read the head of a file (first N bytes) efficiently */
function readHead(filePath, maxBytes = 8192) {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const readLength = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readLength);
    readSync(fd, buf, 0, readLength, 0);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Derive the agent transcript path from the session transcript path + agent ID.
 *
 * Current Claude Code layout (verified 2026-06-15): the main session transcript
 * lives at  projects/<slug>/<sessionId>.jsonl  and agent transcripts are nested
 * under a session-id directory:  projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl
 * So the session dir is the transcript path with its `.jsonl` extension stripped.
 *
 * The previous derivation used dirname(transcriptPath)/subagents, which dropped the
 * <sessionId> segment and produced projects/<slug>/subagents/... — a path that never
 * existed (4,059 'agent-transcript-not-found' misses observed), so live-agent
 * telemetry for ACTIVE subagents never parsed. We try the nested layout first and
 * fall back to the old sibling layout so older/alternate layouts still resolve.
 */
function deriveAgentTranscriptPath(sessionTranscriptPath, agentId) {
  if (!sessionTranscriptPath || !agentId) return '';
  const file = `agent-${agentId}.jsonl`;
  const nested = join(sessionTranscriptPath.replace(/\.jsonl$/i, ''), 'subagents', file);
  const sibling = join(dirname(sessionTranscriptPath), 'subagents', file);
  if (existsSync(nested)) return nested;
  if (existsSync(sibling)) return sibling;
  return nested; // prefer current-layout path for the not-found debug line
}

/**
 * F-03 dispatch tagging — stable 16-char hash of the subagent's prompt.
 * Same prompt → same tag, so SubagentStart and SubagentStop carry the same
 * correlation key; downstream conflict-detection hooks can match outputs that
 * came from semantically-identical dispatches without needing schema-level
 * prompt capture in the SubagentStop payload.
 */
function computePromptTag(promptText) {
  if (!promptText) return '';
  // Use first 1000 chars to keep the tag stable against trailing-whitespace differences
  // in transcript reads at start vs stop.
  return createHash('sha256').update(promptText.slice(0, 1000)).digest('hex').slice(0, 16);
}

/** Extract the prompt text from the first line of an agent transcript JSONL */
function extractPrompt(agentTranscriptPath) {
  if (!agentTranscriptPath) return '';
  try {
    const head = readHead(agentTranscriptPath, 8192);
    const firstLine = head.split('\n')[0];
    if (!firstLine) return '';
    const entry = JSON.parse(firstLine);
    const content = entry.message?.content;
    if (typeof content === 'string') return content.slice(0, 2000);
    if (Array.isArray(content)) {
      const textBlock = content.find(b => b.type === 'text');
      return (textBlock?.text || '').slice(0, 2000);
    }
    return '';
  } catch {
    return '';
  }
}

/** Read the tail of a file (last N bytes) efficiently without reading the entire file */
function readTail(filePath, maxBytes = 65536) {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    const readStart = Math.max(0, fileSize - maxBytes);
    const readLength = fileSize - readStart;
    const buf = Buffer.alloc(readLength);
    readSync(fd, buf, 0, readLength, readStart);
    return { content: buf.toString('utf-8'), isPartial: readStart > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse transcript JSONL to extract token usage, model, and cost.
 * Optimized: reads only the last 64KB of the file. For context window and model,
 * the last usage entry is sufficient. For cost, sums all usage entries in the tail
 * chunk (accurate for most sessions; statusLine provides authoritative cost data
 * in environments that support it).
 */
function parseTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const startMs = Date.now();
    const { content, isPartial } = readTail(transcriptPath);
    const lines = content.split('\n');
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let lastInput = 0, lastOutput = 0, lastCacheRead = 0, lastCacheWrite = 0;
    let model = '', modelId = '';
    const modelCosts = {}; // model -> { input, output, cacheRead, cacheWrite }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let entry;
      // First line of a partial read may be truncated — skip parse failures
      try { entry = JSON.parse(line); } catch { continue; }
      const msg = entry.message;
      if (!msg || !msg.usage) continue;
      const u = msg.usage;
      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      totalInput += inp;
      totalOutput += out;
      totalCacheRead += cr;
      totalCacheWrite += cw;
      // Track last message's usage (= current context window fill)
      lastInput = inp; lastOutput = out; lastCacheRead = cr; lastCacheWrite = cw;
      if (msg.model) {
        modelId = msg.model;
        if (modelId.includes('opus')) model = 'Opus';
        else if (modelId.includes('sonnet')) model = 'Sonnet';
        else if (modelId.includes('haiku')) model = 'Haiku';
        else model = modelId;
        if (!modelCosts[modelId]) modelCosts[modelId] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
        modelCosts[modelId].input += inp;
        modelCosts[modelId].output += out;
        modelCosts[modelId].cacheRead += cr;
        modelCosts[modelId].cacheWrite += cw;
        modelCosts[modelId].count++;
      }
    }

    // Estimate cost using shared pricing rates
    let totalCost = 0;
    for (const [mid, usage] of Object.entries(modelCosts)) {
      const tier = getTier(mid);
      const p = MODEL_RATES[tier];
      totalCost += (usage.input / 1e6) * p.input + (usage.output / 1e6) * p.output +
                   (usage.cacheRead / 1e6) * p.cacheRead + (usage.cacheWrite / 1e6) * p.cacheWrite;
    }

    // Context fill = last API call's input side (what was sent to the model)
    const lastContextUsed = lastInput + lastCacheRead + lastCacheWrite;
    // Pass the model display name and token count so the resolver can detect
    // extended-context (1M) models via name match OR token overshoot. Passing
    // null here made the forwarder blind to 1M sessions — the server-side
    // recalc in updateLiveSession compensates on the /api/status path, but
    // the local debugLog would still print wrong percentages.
    const contextSize = resolveContextWindowSize(DEFAULT_CONTEXT_WINDOW_SIZE, model, lastContextUsed) ?? DEFAULT_CONTEXT_WINDOW_SIZE;
    const fillPct = Math.min(100, Math.round(lastContextUsed / contextSize * 100));

    const elapsed = Date.now() - startMs;
    debugLog(`transcript parse: ${elapsed}ms, partial=${isPartial}, lines=${lines.length}`);

    return {
      model: { id: modelId, display_name: model },
      cost: { total_cost_usd: Math.round(totalCost * 10000) / 10000 },
      context_window: {
        total_input_tokens: lastContextUsed,
        total_output_tokens: totalOutput,
        context_window_size: contextSize,
        used_percentage: fillPct,
        current_usage: {
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_input_tokens: totalCacheRead,
          cache_creation_input_tokens: totalCacheWrite,
        },
      },
      _modelCosts: modelCosts,
      _partial: isPartial,
    };
  } catch (e) {
    debugLog(`transcript parse error: ${e.message}`);
    return null;
  }
}

const mode = process.argv[2];

debugLog(`mode=${mode} args=${process.argv.slice(3).join(' ')}`);

if (mode === 'status') {
  // StatusLine: read JSON from stdin, forward to /api/status, output formatted line
  const raw = await readStdin();
  debugLog(`status raw length=${raw.length} snippet=${raw.slice(0, 200)}`);
  try {
    const input = JSON.parse(raw);
    // Fire POST and GET in parallel — snapshot gives us turns, velocity, agents
    // _source tags this as a real statusLine post (not a tool-event piggyback)
    // so the server can use it to update stall-detection timing.
    const [, snapshot] = await Promise.all([
      post('/api/status', { ...input, _source: 'statusLine' }),
      get('/api/snapshot').catch(() => null),
    ]);
    const sessionId = input.session_id || '';
    const live = snapshot?.liveSessions?.[sessionId] || {};

    // Output formatted status line for Claude Code
    // -- Extract data from statusline JSON --
    const modelFull = input.model?.display_name || '?';
    const model = modelFull.replace(/\s*\(.*\)/, '');  // "Opus 4.6 (1M context)" → "Opus 4.6"
    const cost = (input.cost?.total_cost_usd || 0).toFixed(2);
    const ctxPct = Math.round(input.context_window?.used_percentage || 0);
    const ctxWindowSize = resolveContextWindowSize(input.context_window?.context_window_size, modelFull);
    const ctxSizeK = Math.round(ctxWindowSize / 1000);
    const curUsage = input.context_window?.current_usage;
    const inputTokens = curUsage?.input_tokens || 0;
    const cacheRead = curUsage?.cache_read_input_tokens || 0;
    const cacheWrite = curUsage?.cache_creation_input_tokens || 0;
    const usedTokensK = Math.round((inputTokens + cacheRead + cacheWrite) / 1000);
    const cwd = input.workspace?.current_dir || '';
    const dirName = cwd.split(/[/\\]/).filter(Boolean).pop() || '';
    const durationMs = input.cost?.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    const linesAdded = input.cost?.total_lines_added || 0;
    const linesRemoved = input.cost?.total_lines_removed || 0;
    const exceeds200k = input.exceeds_200k_tokens || false;

    // -- Extract enriched data from telemetry snapshot --
    const turnCount = live._turnCount || 0;
    const tokensPerTurn = live._tokensPerTurn || 0;
    const estTurnsLeft = live._estimatedTurnsRemaining || (tokensPerTurn > 0 ? Math.floor((ctxWindowSize - usedTokensK * 1000) / tokensPerTurn) : 0);
    const toolCount = live._toolCount || 0;
    const lastTool = live._lastTool || '';
    const activeAgents = live._activeSubagents ? Object.keys(live._activeSubagents).length : 0;
    const agentNames = live._activeSubagents ? Object.values(live._activeSubagents).map(a => a.type || a.description || '?').join(', ') : '';
    const compactCount = live._compactEvents?.length || 0;

    // Cache hit ratio from current usage
    const totalCacheTokens = cacheRead + cacheWrite;
    const cacheHitPct = totalCacheTokens > 0 ? Math.round(cacheRead / totalCacheTokens * 100) : 0;

    // Git branch (fast fail, 500ms timeout)
    let branch = '';
    try {
      const { execSync } = await import('child_process');
      branch = execSync('git branch --show-current 2>/dev/null', { cwd: cwd || undefined, timeout: 500, encoding: 'utf-8' }).trim();
    } catch {}

    // Worktree indicator
    const worktree = input.worktree?.name || '';

    // -- ANSI palette --
    const RST = '\x1b[0m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const YELLOW = '\x1b[33m';
    const RED = '\x1b[31m';
    const MAGENTA = '\x1b[35m';
    const WHITE = '\x1b[37m';
    const BLUE = '\x1b[34m';

    // -- Context bar: 25 chars, smooth unicode, tri-color zones --
    const barWidth = 25;
    const filled = Math.round(ctxPct * barWidth / 100);
    const greenZone = Math.round(barWidth * 0.7);
    const yellowZone = Math.round(barWidth * 0.9);
    let bar = '';
    for (let i = 0; i < barWidth; i++) {
      if (i < filled) {
        const color = i < greenZone ? GREEN : i < yellowZone ? YELLOW : RED;
        bar += `${color}━${RST}`;
      } else {
        bar += `${DIM}─${RST}`;
      }
    }
    const ctxColor = ctxPct >= 90 ? RED : ctxPct >= 70 ? YELLOW : GREEN;
    const ctxWarn = ctxPct >= 90 ? `${RED}!!${RST} ` : ctxPct >= 70 ? `${YELLOW}! ${RST} ` : '   ';

    // -- Line 1: Model | Cost | Duration | Git | Dir | Lines --
    let line1 = `${BOLD}${CYAN}${model}${RST}`;
    line1 += ` ${DIM}|${RST} ${GREEN}$${cost}${RST}`;
    line1 += ` ${DIM}|${RST} ${DIM}${mins}m${secs}s${RST}`;
    if (branch) line1 += ` ${DIM}|${RST} ${MAGENTA}${branch}${RST}`;
    if (worktree) line1 += ` ${DIM}[wt:${worktree}]${RST}`;
    if (dirName) line1 += ` ${DIM}|${RST} ${WHITE}${dirName}${RST}`;
    if (linesAdded || linesRemoved) line1 += ` ${GREEN}+${linesAdded}${RST}${RED}-${linesRemoved}${RST}`;
    process.stdout.write(line1 + '\n');

    // -- Line 2: Context bar + tokens + est turns + cache --
    let line2 = `${ctxWarn}${bar} ${ctxColor}${BOLD}${ctxPct}%${RST}`;
    line2 += ` ${DIM}${usedTokensK}K/${ctxSizeK}K${RST}`;
    if (estTurnsLeft > 0) {
      const turnsColor = estTurnsLeft <= 3 ? RED : estTurnsLeft <= 8 ? YELLOW : GREEN;
      line2 += ` ${DIM}|${RST} ${turnsColor}~${estTurnsLeft} turns left${RST}`;
    }
    if (cacheHitPct > 0) line2 += ` ${DIM}| cache ${cacheHitPct}%${RST}`;
    if (exceeds200k) line2 += ` ${RED}${BOLD}[EXT]${RST}`;
    if (compactCount > 0) line2 += ` ${DIM}[${compactCount}x compact]${RST}`;
    process.stdout.write(line2 + '\n');

    // -- Line 3 (conditional): Agents + Turn velocity + Tools --
    let line3parts = [];
    if (turnCount > 0) line3parts.push(`${DIM}T${turnCount}${RST}`);
    if (tokensPerTurn > 0) line3parts.push(`${DIM}${Math.round(tokensPerTurn / 1000)}K/turn${RST}`);
    if (toolCount > 0) line3parts.push(`${BLUE}${toolCount} tools${RST}${lastTool ? ` ${DIM}(${lastTool})${RST}` : ''}`);
    if (activeAgents > 0) line3parts.push(`${CYAN}${BOLD}${activeAgents} agent${activeAgents > 1 ? 's' : ''}${RST}${agentNames ? ` ${DIM}(${agentNames})${RST}` : ''}`);
    if (line3parts.length > 0) process.stdout.write(line3parts.join(` ${DIM}|${RST} `) + '\n');
  } catch {
    process.stdout.write('Claude Code');
  }
} else if (mode === 'tool') {
  // PostToolUse: forward tool event
  // CLI args from env vars may not expand on Windows, so fall back to stdin JSON
  const argToolName = process.argv[3] || '';
  const argSessionId = process.argv[4] || '';
  const eventType = process.argv[5] || 'post_tool_use';
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const toolName = argToolName && !argToolName.startsWith('$') ? argToolName : (parsed.tool_name || 'unknown');
  const sessionId = argSessionId && !argSessionId.startsWith('$') ? argSessionId : (parsed.session_id || '');
  const cwd = parsed.cwd || '';
  const transcriptPath = parsed.transcript_path || '';
  debugLog(`tool: name=${toolName} session=${sessionId?.slice(0,8)} cwd=${cwd} duration_ms=${parsed.duration_ms} keys=${Object.keys(parsed).join(',')}`);
  try { unlinkSync(IDLE_MARKER_PATH); } catch {}

  // Live agent transcript telemetry — when tool fires inside a subagent,
  // parse the agent's transcript for live cost/context/model data.
  // B-04 fix: existence guard prevents the parseTranscript ENOENT log spam
  // (observed 2026-04-25: 20 identical ENOENT log lines for one subagent
  // whose transcript path doesn't match the deriveAgentTranscriptPath
  // convention — likely lives under a different project slug). When the
  // file is absent we still emit a single debug line per tool event so
  // the path mismatch remains visible.
  let agentLiveMetrics = null;
  if (parsed.agent_id && transcriptPath) {
    try {
      const agentTxPath = deriveAgentTranscriptPath(transcriptPath, parsed.agent_id);
      if (agentTxPath) {
        if (existsSync(agentTxPath)) {
          agentLiveMetrics = parseTranscript(agentTxPath);
        } else {
          agentLiveMetrics = { status: 'transcript-not-found', expectedPath: agentTxPath };
          debugLog(`agent-transcript-not-found: id=${parsed.agent_id} expected=${agentTxPath}`);
        }
      }
    } catch {}
  }

  // Post tool event (include agent_id/agent_type when tool fires inside a subagent)
  const toolPost = post('/api/hooks', {
    tool_name: toolName,
    tool_input: parsed.tool_input || parsed,
    session_id: sessionId,
    event_type: eventType,
    cwd,
    duration_ms: parsed.duration_ms ?? null,
    tool_use_id: parsed.tool_use_id || '',
    agent_id: parsed.agent_id || '',
    agent_type: parsed.agent_type || '',
    _agentLiveMetrics: agentLiveMetrics,
  });
  // Also parse transcript and post live session data (for desktop app which lacks statusLine)
  // _source='toolPiggyback' so server does NOT count this as a real statusLine
  // post for stall detection (otherwise Layer C would never fire because tool
  // events always carry a status post with them).
  //
  // GATED (2026-06-19): only for INTERACTIVE sessions. A tool event from an
  // agent (Task subagent → agent_id; `--agent` headless run → agent_type) must
  // NOT mint a standalone top-level session — that surfaced ~30 phantom
  // rh-daily-guidance tabs during a concurrent daily-regen burst. The tool
  // event itself still forwards agent_id/agent_type above, so nested subagent
  // tracking is unaffected. See scripts/piggyback-gate.js.
  let statusPost = Promise.resolve();
  if (shouldPiggybackStatus({ transcriptPath, sessionId, agentId: parsed.agent_id, agentType: parsed.agent_type })) {
    const txData = parseTranscript(transcriptPath);
    if (txData) {
      const statusPayload = {
        session_id: sessionId,
        ...txData,
        workspace: { current_dir: cwd },
        _source: 'toolPiggyback',
      };
      statusPost = post('/api/status', statusPayload);
      debugLog(`status-from-transcript: ctx=${txData.context_window.used_percentage}% cost=$${txData.cost.total_cost_usd}`);
    }
  }
  await Promise.all([toolPost, statusPost]);
} else if (mode === 'tool-failure') {
  // PostToolUseFailure: forward with error
  const argToolName = process.argv[3] || '';
  const argSessionId = process.argv[4] || '';
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const toolName = argToolName && !argToolName.startsWith('$') ? argToolName : (parsed.tool_name || 'unknown');
  const sessionId = argSessionId && !argSessionId.startsWith('$') ? argSessionId : (parsed.session_id || '');
  await post('/api/hooks', {
    tool_name: toolName,
    tool_input: parsed.tool_input || parsed,
    session_id: sessionId,
    event_type: 'post_tool_use_failure',
    success: false,
    error: parsed.error || 'Unknown error',
    cwd: parsed.cwd || '',
    duration_ms: parsed.duration_ms ?? null,
    tool_use_id: parsed.tool_use_id || '',
    transcript_path: parsed.transcript_path || '',
    agent_id: parsed.agent_id || '',
    agent_type: parsed.agent_type || '',
  });
} else if (mode === 'stop') {
  // Stop hook: mark turn end + write idle marker + append progress entry
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  debugLog(`stop: session=${sessionId?.slice(0, 8)}`);
  try { writeFileSync(IDLE_MARKER_PATH, sessionId); } catch {}
  await post('/api/turn-end', {
    session_id: sessionId,
    stop_hook_active: parsed.stop_hook_active ?? true,
  });
  // Append progress entry (absorbed from progress-tracker.js)
  await appendProgressEntry(sessionId);
} else if (mode === 'compact') {
  // PreCompact hook: forward compact event
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  debugLog(`compact: session=${sessionId?.slice(0, 8)} trigger=${parsed.trigger || 'auto'}`);
  await post('/api/compact', {
    session_id: sessionId,
    trigger: parsed.trigger || 'auto',
  });
} else if (mode === 'session-end') {
  // SessionEnd hook: mark the session ended on the dashboard (NOT pruned —
  // it lingers until the stale prune / manual refresh, per user preference)
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  debugLog(`session-end: session=${sessionId?.slice(0, 8)}`);
  await post('/api/session-end', { session_id: sessionId });
} else if (mode === 'permission-request') {
  // PermissionRequest hook: surface "waiting on user permission" state so a
  // session blocked on a dialog doesn't read as idle on the Live surface
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  debugLog(`permission-request: session=${sessionId?.slice(0, 8)} tool=${parsed.tool_name || '?'}`);
  await post('/api/permission-request', {
    session_id: sessionId,
    tool_name: parsed.tool_name || null,
  });
} else if (mode === 'subagent-start') {
  // SubagentStart hook: forward subagent start + extract prompt from transcript
  // Payload provides: agent_id, agent_type, session_id, transcript_path, cwd.
  // Agent transcript is at dirname(transcript_path)/subagents/agent-{id}.jsonl
  // and is written incrementally — line 1 contains the prompt.
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  const agentId = parsed.agent_id || `agent-${Date.now()}`;
  const agentTranscriptPath = deriveAgentTranscriptPath(parsed.transcript_path, agentId);
  const prompt = extractPrompt(agentTranscriptPath);

  // Read meta.json for description (best-effort)
  let description = '';
  if (agentTranscriptPath) {
    try {
      const metaPath = agentTranscriptPath.replace(/\.jsonl$/, '.meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      description = meta.description || '';
    } catch {}
  }

  // F-03: stable correlation tag derived from the prompt text
  const promptTag = computePromptTag(prompt);

  debugLog(`subagent-start: session=${sessionId?.slice(0, 8)} type=${parsed.agent_type || '?'} id=${agentId} parent=${parsed.parent_agent_id || '-'} prompt=${prompt.length}chars tag=${promptTag} desc=${description.slice(0, 40)}`);

  // P2-1: write start-flag so subagent-stop can detect orphans (stops without
  // a matching start). Per 2026-05-08 audit, the orphan rate was 71% in 7d
  // window — until alerts fire we have no way to investigate.
  try { appendFileSync(subagentFlagPath(agentId), `${Date.now()}\n`); } catch {}

  await post('/api/subagent', {
    session_id: sessionId,
    action: 'start',
    agent_id: agentId,
    agent_type: parsed.agent_type || 'unknown',
    parent_agent_id: parsed.parent_agent_id || null,
    transcript_path: parsed.transcript_path || '',
    agent_transcript_path: agentTranscriptPath,
    prompt,
    promptTag,
    description,
  });
} else if (mode === 'subagent-stop') {
  // SubagentStop hook: forward subagent stop + parse transcript for token/model metrics
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  const transcriptPath = parsed.agent_transcript_path || '';

  // Parse the subagent's transcript JSONL for token usage, model, cost, and turn count.
  // C2: when transcriptPath is absent or the parse fails, stamp a status so the
  // dashboard can surface "transcript lost" instead of silently dropping cost data.
  let transcriptMetrics = { status: 'ok' };
  if (!transcriptPath) {
    transcriptMetrics = { status: 'missing-path' };
    debugLog(`subagent-transcript: no transcript_path in stdin — metrics unavailable`);
  } else if (!existsSync(transcriptPath)) {
    // B-05: existence guard prevents parseTranscript ENOENT log spam in
    // subagent-stop (same pattern as B-04 in the tool handler). Subagent
    // transcripts may be cleaned up before the stop hook fires.
    transcriptMetrics = { status: 'transcript-not-found', expectedPath: transcriptPath };
    debugLog(`subagent-stop-transcript-not-found: expected=${transcriptPath}`);
  } else {
    try {
      const txData = parseTranscript(transcriptPath);
      if (txData) {
        // Count turns (assistant messages with usage) from last 64KB of transcript
        let turnCount = 0;
        try {
          const { content } = readTail(transcriptPath);
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.message?.role === 'assistant' && entry.message?.usage) turnCount++;
            } catch {}
          }
        } catch {}

        transcriptMetrics = {
          status: 'ok',
          model: txData.model,
          cost: txData.cost,
          tokens: {
            input: txData.context_window?.current_usage?.input_tokens || 0,
            output: txData.context_window?.current_usage?.output_tokens || 0,
            cacheRead: txData.context_window?.current_usage?.cache_read_input_tokens || 0,
            cacheWrite: txData.context_window?.current_usage?.cache_creation_input_tokens || 0,
            total: (txData.context_window?.current_usage?.input_tokens || 0) +
                   (txData.context_window?.current_usage?.output_tokens || 0),
          },
          turns: turnCount || null,
        };
        debugLog(`subagent-transcript: model=${txData.model?.display_name || '?'} cost=$${txData.cost?.total_cost_usd || 0} tokens=${transcriptMetrics.tokens.total} turns=${turnCount}`);
      } else {
        transcriptMetrics = { status: 'parse_failed' };
        debugLog(`subagent-transcript: parse returned null for ${transcriptPath}`);
      }
    } catch (e) {
      const isMissing = e.code === 'ENOENT';
      transcriptMetrics = { status: isMissing ? 'missing' : 'parse_failed', error: e.message };
      debugLog(`subagent-transcript error (${transcriptMetrics.status}): ${e.message}`);
    }
  }

  // Extract prompt from transcript (fallback if SubagentStart missed it)
  const prompt = extractPrompt(transcriptPath);

  // F-03: same hash function as SubagentStart — same prompt → same tag,
  // enabling cross-subagent conflict detection without schema-level prompt capture.
  const promptTag = computePromptTag(prompt);

  // P2-1: orphan detection. If flag exists, this stop is paired with a start.
  // If not, SubagentStart never fired for this agent_id — emit alert.
  const orphanAgentId = parsed.agent_id || '';
  let isOrphan = false;
  if (orphanAgentId) {
    const flagPath = subagentFlagPath(orphanAgentId);
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch {}
    } else {
      isOrphan = true;
      emitOversightEvent('subagent_orphan_alert', {
        session_id: sessionId,
        agent_id: orphanAgentId,
        transcript_status: transcriptMetrics.status || 'unknown',
        agent_type_from_stop: parsed.agent_type || 'unknown',
        note: 'SubagentStop fired without matching SubagentStart in this session. SubagentStart hook may not be invoked for this agent type / dispatch path.',
      });
    }
  }

  debugLog(`subagent-stop: session=${sessionId?.slice(0, 8)} id=${parsed.agent_id || '?'} transcript=${transcriptPath ? 'yes' : 'no'} tag=${promptTag} perm=${parsed.permission_mode || '-'}${isOrphan ? ' ORPHAN' : ''}`);
  await post('/api/subagent', {
    session_id: sessionId,
    action: 'stop',
    agent_id: parsed.agent_id || '',
    agent_type: parsed.agent_type || 'unknown',
    last_assistant_message: parsed.last_assistant_message || '',
    agent_transcript_path: transcriptPath,
    _transcriptMetrics: transcriptMetrics,
    permission_mode: parsed.permission_mode || null,
    prompt,
    promptTag,
  });
} else if (mode === 'user-prompt') {
  // UserPromptSubmit hook: capture current prompt + clear idle marker
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  const promptText = parsed.prompt || parsed.content || parsed.message || '';
  debugLog(`user-prompt: session=${sessionId?.slice(0, 8)} len=${promptText.length}`);
  try { unlinkSync(IDLE_MARKER_PATH); } catch {}
  await post('/api/prompt', {
    session_id: sessionId,
    prompt: promptText,
  });
} else if (mode === 'config-change') {
  // ConfigChange hook: log when settings are modified.
  // B-05 fix: skip empty-payload events (config_path === '' AND changes === {}).
  // Observed 2026-04-25: 13/24h ConfigChange events fire with empty payloads
  // and surface as "Settings modified: unknown path" failures in the digest,
  // crowding out real signal. Per-environment Claude Code variants emit these
  // spuriously; the post is suppressed but the debug line remains so the event
  // is still observable in hook-debug.log.
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  const configPath = parsed.config_path || '';
  const changes = parsed.changes || {};
  const isEmptyPayload = !configPath && (!changes || Object.keys(changes).length === 0);
  debugLog(`config-change: session=${sessionId?.slice(0, 8)} path=${configPath || '(empty)'} changes=${Object.keys(changes).length} suppressed=${isEmptyPayload}`);
  if (!isEmptyPayload) {
    await post('/api/config-change', {
      session_id: sessionId,
      config_path: configPath,
      changes,
    });
  }
} else if (mode === 'task-completed') {
  // TaskCompleted hook: log task completions
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  debugLog(`task-completed: session=${sessionId?.slice(0, 8)} task=${parsed.task_id || '?'}`);
  await post('/api/task-completed', {
    session_id: sessionId,
    task_id: parsed.task_id || '',
    task_description: parsed.task_description || '',
    status: parsed.status || 'completed',
  });
} else if (mode === 'instructions-loaded') {
  // InstructionsLoaded hook (P2-3, 2026-05-08): Anthropic-recommended for
  // audit/compliance per code.claude.com/docs/en/hooks. Fires when CLAUDE.md
  // or workspace rules are loaded. Persisted to oversight-events.jsonl so
  // the supervisor can detect drift across machines/projects (when CLAUDE.md
  // content shifts between sessions, this stream answers "did anything in
  // the loaded instructions change between session A and session B").
  const raw = await readStdin();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  const sessionId = parsed.session_id || process.argv[3] || '';
  const sources = Array.isArray(parsed.sources) ? parsed.sources :
                  (parsed.path ? [parsed.path] : []);
  // Hash the loaded content if provided so we can detect drift without
  // persisting full CLAUDE.md text in the events log.
  let contentHash = '';
  const content = parsed.content || parsed.text || '';
  if (content) contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  debugLog(`instructions-loaded: session=${sessionId?.slice(0, 8)} sources=${sources.length} content_hash=${contentHash || '-'}`);
  emitOversightEvent('instructions_loaded', {
    session_id: sessionId,
    source_count: sources.length,
    sources: sources.slice(0, 10),  // cap to keep event small
    content_hash: contentHash,
  });
}