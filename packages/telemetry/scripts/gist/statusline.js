#!/usr/bin/env node
/**
 * Standalone Claude Code statusline — zero dependencies, single file.
 *
 * ─── SYNC CONTRACT ─────────────────────────────────────────────────────
 * This file is mirrored in THREE locations. They MUST remain byte-identical.
 * If you edit any of them, update the other two in the SAME commit and
 * re-verify byte-identity before merging.
 *
 *   1. rh-telemetry/scripts/statusline-CLI-only.js   ← authoritative
 *   2. rh-telemetry/scripts/gist/statusline.js         (public gist mirror)
 *   3. <user-setup>/statusline/STATUSLINE_KIT.md      (embedded in docs)
 *
 * Verify (Bash / Git Bash on Windows), from the Workspace root:
 *   node -e "const fs=require('fs');
 *     const a=fs.readFileSync('toolbeltross/toolbeltross-public/rh-telemetry/scripts/statusline-CLI-only.js');
 *     const b=fs.readFileSync('toolbeltross/toolbeltross-public/rh-telemetry/scripts/gist/statusline.js');
 *     const md=fs.readFileSync('<user-setup>/statusline/STATUSLINE_KIT.md','utf8');
 *     const embedded=md.match(/\`\`\`javascript\n([\s\S]*?)\n\`\`\`/)[1];
 *     console.log('js mirrors identical:', a.equals(b));
 *     console.log('md embed matches js:', embedded === a.toString().replace(/\n$/,''));"
 *
 * Why three copies:
 *   - (1) is the one rh-telemetry integration tests exercise
 *   - (2) is published as a GitHub gist so users can curl it directly
 *   - (3) is the documentation kit users read and copy-paste from
 * Each serves a different audience; none can be eliminated without
 * breaking a different install path. Keeping them in sync is the cost.
 * ───────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   1. Copy this file to ~/.claude/statusline.js
 *   2. Add to ~/.claude/settings.json:
 *      { "statusLine": { "type": "command", "command": "node ~/.claude/statusline.js" } }
 *
 * Optional telemetry enrichment (line 3 with turns, tools, agents):
 *   Set RH_TELEMETRY_URL=http://localhost:7890 in your environment.
 */
'use strict';

const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;
const EXTENDED_CONTEXT_WINDOW_SIZE = 1_000_000;
function resolveCtxSize(reported, modelName) {
  if (modelName && /1m\s*context/i.test(modelName)) return EXTENDED_CONTEXT_WINDOW_SIZE;
  return reported ?? DEFAULT_CONTEXT_WINDOW_SIZE;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

async function fetchJSON(url, timeout = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function postJSON(url, body) {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {}
}

async function main() {
  const raw = await readStdin();
  try {
    const input = JSON.parse(raw);
    const TELEMETRY_URL = process.env.RH_TELEMETRY_URL;

    // Fire-and-forget POST + optional snapshot GET
    let live = {};
    if (TELEMETRY_URL) {
      const [, snapshot] = await Promise.all([
        postJSON(`${TELEMETRY_URL}/api/status`, input),
        fetchJSON(`${TELEMETRY_URL}/api/snapshot`),
      ]);
      const sessionId = input.session_id || '';
      live = snapshot?.liveSessions?.[sessionId] || {};
    }

    // -- Extract data --
    const modelFull = input.model?.display_name || '?';
    const model = modelFull.replace(/\s*\(.*\)/, '');
    const cost = (input.cost?.total_cost_usd || 0).toFixed(2);
    const ctxPct = Math.round(input.context_window?.used_percentage || 0);
    const ctxWindowSize = resolveCtxSize(input.context_window?.context_window_size, modelFull);
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

    // Enrichment from telemetry snapshot
    const turnCount = live._turnCount || 0;
    const tokensPerTurn = live._tokensPerTurn || 0;
    const estTurnsLeft = live._estimatedTurnsRemaining || (tokensPerTurn > 0 ? Math.floor((ctxWindowSize - usedTokensK * 1000) / tokensPerTurn) : 0);
    const toolCount = live._toolCount || 0;
    const lastTool = live._lastTool || '';
    const activeAgents = live._activeSubagents ? Object.keys(live._activeSubagents).length : 0;
    const agentNames = live._activeSubagents ? Object.values(live._activeSubagents).map(a => a.type || a.description || '?').join(', ') : '';
    const compactCount = live._compactEvents?.length || 0;
    const totalCacheTokens = cacheRead + cacheWrite;
    const cacheHitPct = totalCacheTokens > 0 ? Math.round(cacheRead / totalCacheTokens * 100) : 0;

    // Git branch (fast fail, 500ms timeout)
    let branch = '';
    try {
      const { execSync } = require('child_process');
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

    // -- Context bar: 25 chars, tri-color zones --
    const barWidth = 25;
    const filled = Math.round(ctxPct * barWidth / 100);
    const greenZone = Math.round(barWidth * 0.7);
    const yellowZone = Math.round(barWidth * 0.9);
    let bar = '';
    for (let i = 0; i < barWidth; i++) {
      if (i < filled) {
        const color = i < greenZone ? GREEN : i < yellowZone ? YELLOW : RED;
        bar += `${color}\u2501${RST}`;
      } else {
        bar += `${DIM}\u2500${RST}`;
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

    // -- Line 3 (conditional, telemetry only): Agents + Turn velocity + Tools --
    if (TELEMETRY_URL) {
      let line3parts = [];
      if (turnCount > 0) line3parts.push(`${DIM}T${turnCount}${RST}`);
      if (tokensPerTurn > 0) line3parts.push(`${DIM}${Math.round(tokensPerTurn / 1000)}K/turn${RST}`);
      if (toolCount > 0) line3parts.push(`${BLUE}${toolCount} tools${RST}${lastTool ? ` ${DIM}(${lastTool})${RST}` : ''}`);
      if (activeAgents > 0) line3parts.push(`${CYAN}${BOLD}${activeAgents} agent${activeAgents > 1 ? 's' : ''}${RST}${agentNames ? ` ${DIM}(${agentNames})${RST}` : ''}`);
      if (line3parts.length > 0) process.stdout.write(line3parts.join(` ${DIM}|${RST} `) + '\n');
    }
  } catch {
    process.stdout.write('Claude Code\n');
  }
}

main();